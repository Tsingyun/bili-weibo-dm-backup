#!/usr/bin/env node
/* ============================================================
   P1-10 · 结构化导出给大模型用（JSONL）
   ============================================================
   把「对话正文 + 图片内文字(OCR) + 图片内容描述(VLM) + 分享卡片 + 链接」
   摊平成一行一条的 JSONL，方便做语义检索 / 主题归类 / 时间线摘要。

   为什么单独做一个命令行脚本，而不是只在查看页加个按钮：
     查看页的 JSONL 导出是「当前筛选结果」的浏览器内下载，适合临时看一眼；
     这个脚本是「整库摊平 + 可打码 + 可切时间窗」，适合喂流水线。
     两边字段口径保持一致（见 scripts/msg_kind.mjs 顶部说明）。

   ⚠ 全程纯本地文件读写，不联网、不上传、不依赖任何云服务。

   用法：
     node scripts/export_jsonl.mjs                       # 两个会话全导
     node scripts/export_jsonl.mjs --session bili
     node scripts/export_jsonl.mjs --since 2026-01-01 --mask
     node scripts/export_jsonl.mjs --out exports/2026.jsonl --session weibo
     node scripts/export_jsonl.mjs --help
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadSessions, findSession } from './sessions.mjs';
import { msgKind, maskText, localDay, localTime, dayStart, dayEnd } from './msg_kind.mjs';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, d = null) => {
  const i = ARGS.indexOf(f);
  if (i < 0) return d;
  const v = ARGS[i + 1];
  if (v === undefined || v.startsWith('--')) return d;
  return v;
};

if (has('--help') || has('-h')) {
  console.log(`结构化导出 JSONL（纯本地）

  --session <key|all>   要导哪个会话，默认 all（sessions.json 里的全部）
  --out <path>          输出路径。单会话且以 .jsonl 结尾 → 当作文件名；
                        其余情况当作目录，文件名自动生成。
  --since YYYY-MM-DD    只要这个「日」之后的消息（该日 05:00 起 —— 换日按凌晨 5 点算）
  --until YYYY-MM-DD    只要这个「日」之前的消息（到次日 05:00 为止，含）
  --limit N             最多导 N 条（取**最近**的 N 条，便于先试跑）
  --mask                手机号 / 邮箱 / 身份证 / 银行卡 / 账号 / 收货地址 打码
  --no-ocr              不带图片内文字
  --no-vlm              不带图片内容描述
  --no-images           不带图片路径数组
  --no-card             不带分享卡片字段
  --stdout              打到标准输出，不写文件（配合 --limit 做小样预览）
  --quiet               少打日志

  输出：每行一个 JSON 对象，字段见文件头部注释。`);
  process.exit(0);
}

const QUIET = has('--quiet');
const say = (...a) => { if (!QUIET) console.log(...a); };

/* ---------- 参数校验 ---------- */
const sessionArg = val('--session', 'all');
let sessions;
if (sessionArg === 'all') {
  sessions = loadSessions();
} else {
  sessions = [findSession(sessionArg)];
}

const sinceStr = val('--since');
const untilStr = val('--until');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
for (const [k, v] of [['--since', sinceStr], ['--until', untilStr]]) {
  if (v && !DATE_RE.test(v)) {
    console.error(`[x] ${k} 要写成 YYYY-MM-DD，收到的是「${v}」`);
    process.exit(2);
  }
}
/* 日期边界与查看页 / 索引库同一套口径：一天 = 当天 05:00 → 次日 05:00。
   （用 dayStart/dayEnd 而不是自己写 T00:00:00，免得三处口径各说各话） */
const sinceTs = sinceStr ? dayStart(sinceStr) : null;
const untilTs = untilStr ? dayEnd(untilStr) : null;

let limit = null;
if (val('--limit')) {
  limit = parseInt(val('--limit'), 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error('[x] --limit 要是正整数');
    process.exit(2);
  }
}

const WANT_OCR = !has('--no-ocr');
const WANT_VLM = !has('--no-vlm');
const WANT_IMAGES = !has('--no-images');
const WANT_CARD = !has('--no-card');
const DO_MASK = has('--mask');
const TO_STDOUT = has('--stdout');

/* ---------- 读取单个 json，缺失就给空对象/空数组 ---------- */
function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[x] ${path.relative(ROOT, p)} 不是合法 JSON：${e.message}`);
    process.exit(3);
  }
}

const IMG_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];

/**
 * 找索引键。索引以图片**文件名（含扩展名）**为键，压缩成 webp 后键也会跟着变；
 * 万一某个索引漏迁移，这里退回「同名不同扩展名」再找一次，并记账 ——
 * 不静默当作没有，否则图内文字会凭空消失而没人发现。
 */
function lookup(idx, base, stat) {
  if (!base) return null;
  if (Object.prototype.hasOwnProperty.call(idx, base)) return idx[base];
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  for (const e of IMG_EXTS) {
    const alt = stem + e;
    if (Object.prototype.hasOwnProperty.call(idx, alt)) {
      stat.extMismatch++;
      return idx[alt];
    }
  }
  return null;
}

function pickOutPath(dirOrFile, key) {
  if (dirOrFile && dirOrFile.toLowerCase().endsWith('.jsonl')) return path.resolve(ROOT, dirOrFile);
  const dir = path.resolve(ROOT, dirOrFile || 'exports');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return path.join(dir, `${key}_${stamp}.jsonl`);
}

const outArg = val('--out');
const maskHits = {};
const grand = { sessions: 0, records: 0, bytes: 0, auto: 0, sys: 0, gift: 0, count: 0, withOcr: 0, withVlm: 0 };

for (const S of sessions) {
  const base = path.join(ROOT, S.dir);
  const msgPath = path.join(base, 'messages.json');
  if (!fs.existsSync(msgPath)) {
    console.error(`[!] 会话「${S.key}」没有 ${S.dir}/messages.json，跳过（先跑一次对应的更新脚本）`);
    continue;
  }
  const messages = readJson(msgPath, []);
  const ocr = WANT_OCR ? readJson(path.join(base, 'ocr.json'), {}) : {};
  const vlm = WANT_VLM ? readJson(path.join(base, 'vlm.json'), {}) : {};

  const stat = { extMismatch: 0 };
  let rows = [];
  messages.forEach((m, i) => {
    const ts = m.ts ?? null;
    if (sinceTs != null && (ts == null || ts < sinceTs)) return;
    if (untilTs != null && (ts == null || ts > untilTs)) return;

    const rec = {
      session: S.key,
      i,
      id: m.id ?? null,
      ts,
      date: ts != null ? localDay(ts) : null,
      time: ts != null ? localTime(ts) : (m.time || null),
      utc: m.time || null,
      from: m.from,
      sender: m.sender || null,
      type: m.type || null,
      media_type: m.media_type ?? null,
      msg_source: m.msg_source ?? null,
      recalled: !!m.recalled,
      kind: msgKind(m, { platform: S.platform, autoReply: S.autoReply }),
      text: m.text || '',
    };

    if (WANT_IMAGES) rec.images = (m.images || []).map((im) => ({ kind: im.kind || null, local: im.local || null }));

    if (WANT_OCR) {
      const parts = [];
      (m.images || []).forEach((im) => {
        const b = im.local ? im.local.split('/').pop() : '';
        const o = lookup(ocr, b, stat);
        if (o && o.t) {
          const s = String(o.t).replace(/\s+/g, ' ').trim();
          if (s) parts.push(s);
        }
      });
      rec.ocr = parts.join(' ');
    }

    if (WANT_VLM) {
      const vs = [];
      (m.images || []).forEach((im) => {
        const b = im.local ? im.local.split('/').pop() : '';
        const v = lookup(vlm, b, stat);
        if (v && v.d) {
          const s = String(v.d).replace(/\s+/g, ' ').trim();
          if (s) vs.push(s);
        }
      });
      rec.vlm = vs.join(' ');
    }

    if (WANT_CARD) {
      rec.card = m.card ? {
        kind: m.card.kind || null,
        sub: m.card.sub || null,
        author: m.card.author || null,
        title: m.card.title || '',
        text: m.card.text || '',
        url: m.card.url || '',
      } : null;
      rec.links = (m.links || []).map((l) => (typeof l === 'string' ? l : (l.url || ''))).filter(Boolean);
    }

    if (DO_MASK) {
      rec.text = maskText(rec.text, maskHits);
      if (rec.ocr) rec.ocr = maskText(rec.ocr, maskHits);
      if (rec.vlm) rec.vlm = maskText(rec.vlm, maskHits);
      if (rec.card) {
        rec.card.title = maskText(rec.card.title, maskHits);
        rec.card.text = maskText(rec.card.text, maskHits);
      }
    }

    rows.push(rec);
  });

  if (limit != null && rows.length > limit) rows = rows.slice(rows.length - limit);

  const lines = rows.map((r) => JSON.stringify(r));
  const body = lines.join('\n') + (lines.length ? '\n' : '');

  for (const r of rows) {
    grand[r.kind] = (grand[r.kind] || 0) + 1;
    if (r.ocr) grand.withOcr++;
    if (r.vlm) grand.withVlm++;
  }

  if (TO_STDOUT) {
    process.stdout.write(body);
  } else {
    const out = pickOutPath(outArg, S.key);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body, 'utf8');
    const kb = (Buffer.byteLength(body, 'utf8') / 1024).toFixed(0);
    say(`[ok] ${S.label}：${rows.length.toLocaleString()} 条 → ${path.relative(ROOT, out)}（${kb} KB）`);
    if (stat.extMismatch) {
      say(`     [!] ${stat.extMismatch} 处图片索引键的扩展名和 messages.json 对不上` +
          `（多半是压缩后索引没迁移干净）—— 跑一次「一键体检」看看`);
    }
  }

  grand.sessions++;
  grand.records += rows.length;
  grand.bytes += Buffer.byteLength(body, 'utf8');
}

if (!TO_STDOUT) {
  say('');
  say(`合计：${grand.sessions} 个会话 · ${grand.records.toLocaleString()} 条 · ` +
      `${(grand.bytes / 1024 / 1024).toFixed(1)} MB`);
  say(`分类：真实发言 ${(grand.count || 0).toLocaleString()} · 自动回复 ${(grand.auto || 0).toLocaleString()} · ` +
      `系统 ${(grand.sys || 0).toLocaleString()} · 礼物/提示 ${(grand.gift || 0).toLocaleString()}`);
  say(`带图内文字 ${grand.withOcr.toLocaleString()} 条 · 带图片描述 ${grand.withVlm.toLocaleString()} 条`);
  if (DO_MASK) {
    const ks = Object.keys(maskHits);
    say(ks.length
      ? '打码命中：' + ks.map((k) => k + ' ' + maskHits[k]).join(' · ')
      : '打码命中：未命中任何敏感信息规则');
  }
  say('（全程本地读写，没有联网、没有上传）');
}
