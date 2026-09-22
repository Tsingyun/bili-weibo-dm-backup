/**
 * 导出引擎（WebUI 的「导出」和「加载备份」共用）
 * ===============================================================
 * 一次导出要能回答三个问题：**导谁**（会话）、**导哪段**（时间 / 条数 / 分类）、
 * **导成什么**（格式）。所以入口只有一个 options 对象：
 *
 *   { sessions: 'all' | ['weibo', ...], since, until, limit,
 *     kinds: [] | ['count','auto',...], mask: bool,
 *     ocr: bool, vlm: bool, images: bool, card: bool,
 *     format: 'jsonl'|'json'|'csv'|'md'|'html'|'bundle', name }
 *
 * 口径一律复用既有模块，不另起一套：
 *   · 分类 —— scripts/msg_kind.mjs 的 msgKind()（与查看页、索引库同一套）
 *   · 打码 —— msg_kind.mjs 的 maskText()
 *   · 换日 —— msg_kind.mjs 的 dayStart/dayEnd（一天 = 当天 05:00 → 次日 05:00）
 *   · 索引键 —— 图片**文件名**（压缩后扩展名会变，所以要按 stem 回落再找一次）
 *
 * `bundle` 是「可以再被本程序加载」的格式：一个 zip，里面是 data/ 这样的数据目录
 * + manifest.json。用它把备份发给别人，对方在 WebUI 里「加载他人备份」就能看。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadSessions, findSession } from '../sessions.mjs';
import { msgKind, maskText, localDay, localTime, dayStart, dayEnd } from '../msg_kind.mjs';
import { ensureDir, safeJoin, rel, humanSize, safeSegment } from './paths.mjs';
import { writeZip } from './zip.mjs';

export const FORMATS = [
  { id: 'jsonl', ext: 'jsonl', label: 'JSONL（一行一条，喂给 AI / 程序）' },
  { id: 'json', ext: 'json', label: 'JSON（结构化数组）' },
  { id: 'csv', ext: 'csv', label: 'CSV（表格 / Excel）' },
  { id: 'md', ext: 'md', label: 'Markdown（按天排版，适合阅读）' },
  { id: 'html', ext: 'html', label: 'HTML（单文件网页，双击就能看）' },
  { id: 'bundle', ext: 'zip', label: '可分享备份包（zip，能被本程序「加载」）' },
];

export const KINDS = [
  { id: 'count', label: '真实发言' },
  { id: 'auto', label: '自动回复' },
  { id: 'sys', label: '系统提示（撤回等）' },
  { id: 'gift', label: '礼物 / 提示' },
];

const IMG_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];

function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function lookupIndex(idx, base) {
  if (!base) return null;
  if (Object.prototype.hasOwnProperty.call(idx, base)) return idx[base];
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  for (const e of IMG_EXTS) {
    const alt = stem + e;
    if (Object.prototype.hasOwnProperty.call(idx, alt)) return idx[alt];
  }
  return null;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 逐会话读盘 + 过滤，产出统一记录 */
export function collect(opts) {
  const wantSessions = (!opts.sessions || opts.sessions === 'all')
    ? loadSessions()
    : opts.sessions.map((k) => findSession(k));

  const sinceTs = opts.since ? dayStart(opts.since) : null;
  const untilTs = opts.until ? dayEnd(opts.until) : null;
  const kindSet = (opts.kinds && opts.kinds.length) ? new Set(opts.kinds) : null;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : null;

  const hits = {};
  const groups = [];
  const warnings = [];

  for (const S of wantSessions) {
    const base = path.join(ROOT, S.dir);
    const msgPath = path.join(base, 'messages.json');
    if (!fs.existsSync(msgPath)) {
      const jsPath = path.join(base, 'messages.js');
      if (!fs.existsSync(jsPath)) {
        warnings.push(`会话「${S.key}」还没有数据（${S.dir}/messages.json 不存在），已跳过`);
        continue;
      }
      // 只有 .js（他人分享包里可能就这一份）→ 从 window.DM_* = 里抠出 JSON
      const alt = messagesFromJs(jsPath, S);
      if (!alt) { warnings.push(`会话「${S.key}」的 messages.js 解析失败，已跳过`); continue; }
      groups.push(buildGroup(S, alt, base, { sinceTs, untilTs, kindSet, limit, opts, hits }));
      continue;
    }
    const messages = readJson(msgPath, []);
    groups.push(buildGroup(S, messages, base, { sinceTs, untilTs, kindSet, limit, opts, hits }));
  }

  return { groups, warnings, hits, sinceTs, untilTs };
}

function buildGroup(S, messages, base, { sinceTs, untilTs, kindSet, limit, opts, hits }) {
  const ocr = opts.ocr === false ? {} : readJson(path.join(base, 'ocr.json'), {});
  const vlm = opts.vlm === false ? {} : readJson(path.join(base, 'vlm.json'), {});
  const meta = readJson(path.join(base, 'meta.json'), {});

  let rows = [];
  messages.forEach((m, i) => {
    const ts = m.ts ?? null;
    if (sinceTs != null && (ts == null || ts < sinceTs)) return;
    if (untilTs != null && (ts == null || ts > untilTs)) return;
    const kind = msgKind(m, { platform: S.platform, autoReply: S.autoReply });
    if (kindSet && !kindSet.has(kind)) return;

    const rec = {
      session: S.key,
      label: S.label,
      i,
      id: m.id ?? null,
      ts,
      date: ts != null ? localDay(ts) : null,
      time: ts != null ? localTime(ts) : (m.time || null),
      from: m.from === 'me' ? 'me' : 'peer',
      sender: m.sender || (m.from === 'me' ? (meta.self_name || '') : (meta.peer_name || '')),
      type: m.type || null,
      recalled: !!m.recalled,
      kind,
      text: m.text || '',
      images: [],
      ocr: '',
      vlm: '',
      card: null,
      links: [],
    };

    (m.images || []).forEach((im) => {
      const b = im.local ? String(im.local).split('/').pop() : '';
      if (opts.images !== false) rec.images.push({ kind: im.kind || null, local: im.local || null });
      const o = lookupIndex(ocr, b);
      if (o && o.t) { const s = String(o.t).replace(/\s+/g, ' ').trim(); if (s) rec.ocr += (rec.ocr ? ' ' : '') + s; }
      const v = lookupIndex(vlm, b);
      if (v && v.d) { const s = String(v.d).replace(/\s+/g, ' ').trim(); if (s) rec.vlm += (rec.vlm ? ' ' : '') + s; }
    });

    if (m.card) {
      rec.card = {
        kind: m.card.kind || null, sub: m.card.sub || null, author: m.card.author || null,
        title: m.card.title || '', text: m.card.text || '', url: m.card.url || '',
      };
    }
    rec.links = (m.links || []).map((l) => (typeof l === 'string' ? l : (l && l.url) || '')).filter(Boolean);

    if (opts.mask) {
      rec.text = maskText(rec.text, hits);
      if (rec.ocr) rec.ocr = maskText(rec.ocr, hits);
      if (rec.vlm) rec.vlm = maskText(rec.vlm, hits);
      if (rec.card) {
        rec.card.title = maskText(rec.card.title, hits);
        rec.card.text = maskText(rec.card.text, hits);
      }
    }
    rows.push(rec);
  });

  if (limit != null && rows.length > limit) rows = rows.slice(rows.length - limit);

  return {
    session: S, meta, rows,
    peerName: meta.peer_name || S.peer.name || '对方',
    selfName: meta.self_name || S.self.name || '我',
    totalBeforeFilter: messages.length,
  };
}

/** 只有 messages.js（window.DM_xxx = [...];）时的兜底解析 */
export function messagesFromJs(jsPath, S) {
  try {
    const t = fs.readFileSync(jsPath, 'utf8');
    const k = (S && S.globals && S.globals.data) || 'DM_DATA';
    const re = new RegExp('window\\.' + k + '\\s*=\\s*');
    const i = t.search(re);
    if (i < 0) return null;
    const start = t.indexOf('[', i);
    if (start < 0) return null;
    // 从第一个 [ 开始做括号配对（字符串里的括号要跳过）
    let depth = 0, inStr = false, esc = false;
    for (let p = start; p < t.length; p++) {
      const c = t[p];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) return JSON.parse(t.slice(start, p + 1));
      }
    }
    return null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ 渲染 */

export function csvCell(v) {
  let s = v == null ? '' : String(v);
  // ⚠ 公式注入（CSV injection）：Excel / WPS 会把以 = + - @ 开头的单元格**当公式执行**。
  //   聊天内容里 "-2+3"、"@某人"、"=1+1" 都很常见，旧实现原样导出，
  //   对方一打开就可能执行攻击载荷。惯例做法是在前面补一个单引号。
  //   纯数字（"-5"、"1.2e3"）不算公式，放过不动，免得把正常数字变成文本。
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * 只放行 http/https/mailto。
 * ⚠ 导出的 HTML 会被**别人**打开，而聊天里的链接是**对方可控**的：
 *   一条 `javascript:...` 的链接在导出的网页里就是一段能执行的脚本。
 */
export function safeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  return /^(https?:|mailto:)/i.test(s) ? s : '';
}

function renderCsv(groups) {
  const head = ['session', 'date', 'time', 'from', 'sender', 'kind', 'type', 'recalled',
    'text', 'ocr', 'vlm', 'images', 'links', 'card_title', 'card_url'];
  const lines = [head.join(',')];
  for (const g of groups) {
    for (const r of g.rows) {
      lines.push([
        r.session, r.date, r.time, r.from === 'me' ? '我方' : '对方', r.sender, r.kind, r.type,
        r.recalled ? '1' : '', r.text, r.ocr, r.vlm,
        r.images.map((x) => x.local).filter(Boolean).join(' | '),
        r.links.join(' | '),
        r.card ? r.card.title : '', r.card ? r.card.url : '',
      ].map(csvCell).join(','));
    }
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n';   // BOM：Excel 打开中文不乱码
}

function renderJson(groups) {
  return JSON.stringify(groups.flatMap((g) => g.rows), null, 2) + '\n';
}

function renderJsonl(groups) {
  const lines = [];
  for (const g of groups) for (const r of g.rows) lines.push(JSON.stringify(r));
  return lines.join('\n') + (lines.length ? '\n' : '');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMd(groups, opts) {
  const out = [];
  out.push('# 私信备份导出\n');
  out.push(`导出时间：${new Date().toLocaleString('zh-CN')}`);
  if (opts.since || opts.until) out.push(`时间范围：${opts.since || '最早'} ~ ${opts.until || '最新'}`);
  out.push(`会话：${groups.map((g) => g.session.label).join('、') || '（无）'}`);
  out.push(`条数：${groups.reduce((n, g) => n + g.rows.length, 0).toLocaleString()}`);
  out.push('');
  for (const g of groups) {
    out.push(`\n---\n\n## ${g.session.label}（${g.rows.length.toLocaleString()} 条）\n`);
    out.push(`> 对方：${g.peerName}　我：${g.selfName}\n`);
    let day = null;
    for (const r of g.rows) {
      if (r.date !== day) { day = r.date; out.push(`\n### ${day || '（无日期）'}\n`); }
      const who = r.from === 'me' ? g.selfName : g.peerName;
      const tags = [];
      if (r.kind !== 'count') tags.push({ auto: '自动回复', sys: '系统', gift: '礼物' }[r.kind] || r.kind);
      if (r.recalled) tags.push('已撤回');
      const tag = tags.length ? `〔${tags.join('·')}〕` : '';
      let line = `- \`${r.time || '--:--'}\` **${who}**${tag}：${r.text || ''}`;
      const extra = [];
      if (r.ocr) extra.push(`图内文字：${r.ocr}`);
      if (r.vlm) extra.push(`图片描述：${r.vlm}`);
      if (r.card && r.card.title) extra.push(`卡片：${r.card.title}${r.card.url ? ' ' + r.card.url : ''}`);
      if (r.links.length) extra.push(`链接：${r.links.join(' ')}`);
      if (r.images.length) extra.push(`图片：${r.images.length} 张`);
      if (extra.length) line += '\n  - ' + extra.join('\n  - ');
      out.push(line);
    }
  }
  return out.join('\n') + '\n';
}

function renderHtml(groups, opts) {
  const body = [];
  for (const g of groups) {
    body.push(`<section class="conv"><h2>${esc(g.session.label)}<small>${g.rows.length} 条</small></h2>`);
    body.push(`<p class="meta">对方：${esc(g.peerName)}　我：${esc(g.selfName)}</p>`);
    let day = null;
    for (const r of g.rows) {
      if (r.date !== day) { day = r.date; body.push(`<h3 class="day">${esc(day || '（无日期）')}</h3>`); }
      const mine = r.from === 'me';
      const extras = [];
      if (r.ocr) extras.push(`<div class="ex">🖼 图内文字：${esc(r.ocr)}</div>`);
      if (r.vlm) extras.push(`<div class="ex">🖼 图片描述：${esc(r.vlm)}</div>`);
      if (r.card && r.card.title) {
        const cu = safeUrl(r.card.url);
        extras.push(`<div class="ex">🔗 ${esc(r.card.title)} ${cu ? `<a href="${esc(cu)}">${esc(cu)}</a>` : ''}</div>`);
      }
      const links = r.links.map(safeUrl).filter(Boolean);
      if (links.length) extras.push(`<div class="ex">🔗 ${links.map((u) => `<a href="${esc(u)}">${esc(u)}</a>`).join(' ')}</div>`);
      if (r.images.length) extras.push(`<div class="ex">🖼 ${r.images.length} 张图片</div>`);
      body.push(`<div class="msg ${mine ? 'me' : ''}">` +
        `<div class="who">${esc(r.time || '--:--')} · ${esc(mine ? g.selfName : g.peerName)}` +
        `${r.kind !== 'count' ? `<span class="tag">${esc({ auto: '自动回复', sys: '系统', gift: '礼物' }[r.kind] || r.kind)}</span>` : ''}</div>` +
        `<div class="txt">${esc(r.text).replace(/\n/g, '<br>')}</div>${extras.join('')}</div>`);
    }
    body.push('</section>');
  }
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>私信备份导出</title><style>
:root{--bg:#0f1115;--fg:#e6e8ec;--muted:#98a0ad;--card:#171a21;--me:#1d3b2a;--peer:#1b1f27;--line:#252a33}
*{box-sizing:border-box}body{margin:0;padding:28px 18px 80px;background:var(--bg);color:var(--fg);
font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:820px;margin:0 auto}h1{font-size:20px}h2{font-size:17px;margin:32px 0 4px}
h2 small{font-weight:400;color:var(--muted);margin-left:8px;font-size:13px}
h3.day{position:sticky;top:0;background:var(--bg);color:var(--muted);font-size:13px;
font-weight:600;margin:22px 0 10px;padding:6px 0;text-align:center;border-bottom:1px solid var(--line)}
.meta{color:var(--muted);font-size:13px;margin:0 0 8px}
.msg{background:var(--peer);border:1px solid var(--line);border-radius:12px;padding:9px 12px;margin:6px 0;max-width:86%}
.msg.me{background:var(--me);margin-left:auto}
.who{font-size:12px;color:var(--muted);margin-bottom:3px}
.tag{background:#3a2a12;color:#e5b567;border-radius:5px;padding:0 5px;margin-left:6px;font-size:11px}
.txt{white-space:pre-wrap;word-break:break-word}
.ex{margin-top:5px;font-size:12.5px;color:var(--muted);border-left:2px solid var(--line);padding-left:8px}
a{color:#7fb3ff}</style></head><body><div class="wrap">
<h1>私信备份导出</h1>
<p class="meta">导出时间：${esc(new Date().toLocaleString('zh-CN'))}　共 ${total.toLocaleString()} 条${
    opts.since || opts.until ? `　范围：${esc(opts.since || '最早')} ~ ${esc(opts.until || '最新')}` : ''}</p>
${body.join('\n')}
</div></body></html>`;
}

const BUNDLE_README = `# 私信备份包（可被 dm-archive 加载）

这个压缩包是一份**导出好的私信备份**，不含任何登录凭据。

怎么打开：

1. 打开私信备份程序的 WebUI（双击 \`命令/查看与导出/启动WebUI.cmd\`）；
2. 进「加载他人备份」这一步，把本 zip 拖进去（或填它的路径）；
3. 加载完点「查看备份」，就能像看自己的记录一样翻阅。

包里有什么：

| 文件 | 说明 |
|---|---|
| \`manifest.json\` | 包信息：导出时间、会话、条数、时间范围 |
| \`<会话>/messages.json\` | 消息正文 |
| \`<会话>/messages.js\` | 同上，给查看页读的版本 |
| \`<会话>/ocr.json\` \`vlm.json\` | 图内文字 / 图片描述（如果有） |
| \`<会话>/images/\` | 图片（如果导出时勾选了「带图片」） |
`;

/** 只把「记录」写出去（不含图片），用于纯数据导出 */
export function render(format, groups, opts) {
  switch (format) {
    case 'jsonl': return renderJsonl(groups);
    case 'json': return renderJson(groups);
    case 'csv': return renderCsv(groups);
    case 'md': return renderMd(groups, opts);
    case 'html': return renderHtml(groups, opts);
    default: throw new Error('不支持的格式：' + format);
  }
}

function defaultName(opts, ext) {
  const s = (!opts.sessions || opts.sessions === 'all') ? 'all' : opts.sessions.join('+');
  const range = [opts.since, opts.until].filter(Boolean).join('_');
  // ⚠ `name` 是从前端传进来的，不压成单段的话 `../../x` 会把文件写到工作区外面去。
  const base = safeSegment(opts.name || 'dm', 'dm');
  return `${base}_${s}${range ? '_' + range : ''}_${stamp()}.${ext}`;
}

/**
 * 执行导出。返回 {files:[{name,rel,path,size,human}], stats, warnings}
 */
export function runExport(opts = {}) {
  const fmt = FORMATS.find((f) => f.id === (opts.format || 'jsonl'));
  if (!fmt) throw new Error('不支持的格式：' + opts.format);

  const { groups, warnings, hits } = collect(opts);
  const outDir = ensureDir(safeJoin('exports'));
  const stats = {
    sessions: groups.length,
    records: groups.reduce((n, g) => n + g.rows.length, 0),
    byKind: {},
    withOcr: 0, withVlm: 0, images: 0,
  };
  for (const g of groups) for (const r of g.rows) {
    stats.byKind[r.kind] = (stats.byKind[r.kind] || 0) + 1;
    if (r.ocr) stats.withOcr++;
    if (r.vlm) stats.withVlm++;
    stats.images += r.images.length;
  }
  const maskHits = opts.mask ? hits : null;
  const files = [];

  if (fmt.id === 'bundle') {
    const name = defaultName(opts, 'zip');
    const outPath = path.join(outDir, name);
    const entries = [];
    const manifest = {
      format: 'dm-archive-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      generator: 'dm-archive WebUI',
      options: {
        sessions: opts.sessions || 'all',
        since: opts.since || null,
        until: opts.until || null,
        limit: opts.limit || null,
        kinds: opts.kinds || [],
        mask: !!opts.mask,
        withImages: opts.images !== false,
      },
      sessions: [],
    };
    for (const g of groups) {
      const dir = g.session.dir;                            // 例如 data / bili / imported/xxx/weibo
      const msgJson = JSON.stringify(g.rows.map((r) => ({
        id: r.id, ts: r.ts, time: r.ts != null ? new Date(r.ts).toISOString() : null,
        from: r.from, sender: r.sender, type: r.type, recalled: r.recalled,
        kind: r.kind, text: r.text,
        images: r.images.map((x) => ({ kind: x.kind, local: x.local })),
        links: r.links,
        card: r.card,
      })));
      entries.push({ name: `${dir}/messages.json`, data: msgJson });
      entries.push({ name: `${dir}/messages.js`, data: `window.DM_DATA_${g.session.key.toUpperCase().replace(/[^A-Z0-9]/g, '_')} = ${msgJson};\n` });
      const ocrMap = {}, vlmMap = {};
      for (const g2 of [g]) for (const r of g2.rows) {
        for (const im of r.images) {
          const b = im.local ? String(im.local).split('/').pop() : '';
          if (!b) continue;
          if (r.ocr) ocrMap[b] = { t: r.ocr };
          if (r.vlm) vlmMap[b] = { d: r.vlm };
        }
      }
      if (Object.keys(ocrMap).length) entries.push({ name: `${dir}/ocr.json`, data: JSON.stringify(ocrMap) });
      if (Object.keys(vlmMap).length) entries.push({ name: `${dir}/vlm.json`, data: JSON.stringify(vlmMap) });
      entries.push({
        name: `${dir}/meta.json`,
        data: JSON.stringify({
          total: g.rows.length, peer_name: g.peerName, self_name: g.selfName,
          first_time: g.rows.length ? new Date(g.rows[0].ts).toISOString() : null,
          last_time: g.rows.length ? new Date(g.rows[g.rows.length - 1].ts).toISOString() : null,
          exported: true, source_total: g.totalBeforeFilter,
        }, null, 2),
      });
      // 图片（可选）
      let imgCopied = 0;
      if (opts.images !== false) {
        const seen = new Set();
        for (const r of g.rows) {
          for (const im of r.images) {
            if (!im.local || seen.has(im.local)) continue;
            seen.add(im.local);
            const src = path.join(ROOT, String(im.local).replace(/\\/g, '/'));
            if (!fs.existsSync(src)) continue;
            entries.push({ name: `${dir}/images/${path.basename(src)}`, data: fs.readFileSync(src) });
            imgCopied++;
          }
        }
      }
      manifest.sessions.push({
        key: g.session.key, label: g.session.label, platform: g.session.platform,
        dir, records: g.rows.length, images: imgCopied,
        peer: { name: g.peerName, uid: '' }, self: { name: g.selfName, uid: '' },
      });
    }
    entries.unshift({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
    entries.push({ name: '先读我.md', data: BUNDLE_README });
    const z = writeZip(entries, outPath);
    files.push({ name, rel: rel(outPath), path: outPath, size: z.bytes, human: humanSize(z.bytes) });
  } else {
    const name = defaultName(opts, fmt.ext);
    const outPath = path.join(outDir, name);
    const text = render(fmt.id, groups, opts);
    fs.writeFileSync(outPath, text, 'utf8');
    const size = Buffer.byteLength(text, 'utf8');
    files.push({ name, rel: rel(outPath), path: outPath, size, human: humanSize(size) });
  }

  return { files, stats, warnings, maskHits, format: fmt.id, groups: groups.map((g) => ({ key: g.session.key, label: g.session.label, rows: g.rows.length })) };
}
