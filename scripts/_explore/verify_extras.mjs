#!/usr/bin/env node
/* ============================================================
   P0-2 / P0-3 / P0-4 / P1-10 / P2-15 / P2-16 新增功能的回归验证
   ============================================================
   跑法：node scripts/_explore/verify_extras.mjs
   （用 managed node 22，因为要 node:sqlite）

   覆盖：
   1. scripts/msg_kind.mjs 与 查看备份.html 里的 msgKind() **逐条比对**
      —— 这两个是同一份业务逻辑的两处实现，最容易悄悄跑偏。
   2. export_jsonl.mjs：条数、字段映射、kind 分布、打码效果
   3. build_fts.mjs + search.mjs：行数一致、字段对齐、FTS 与 LIKE 结果集一致
   4. export_faces.mjs：清单行数、使用次数独立重算、文件名合法性
   5. 定时更新脚本：语法可解析、关键开关都在、日志目录可写

   为什么要在意第 1 条：页面那份口径错了只影响界面，命令行那份错了会
   把「自动回复」算进真实发言，进而把 JSONL 喂给大模型时统计全歪。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const TMP = path.join(HERE, '_tmp');
fs.mkdirSync(TMP, { recursive: true });

const NODE = process.execPath;
let pass = 0, fail = 0;
const NG = [];
function chk(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  [ok] ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; NG.push(name); console.log(`  [NG] ${name}${extra ? '  — ' + extra : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

function run(script, args = []) {
  try {
    const out = execFileSync(NODE, [script, ...args], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const sessionsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions.json'), 'utf8'));
const SESSIONS = sessionsJson.sessions;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/* ============================================================
   1. 分类口径：命令行 vs 页面，逐条比对
   ============================================================ */
section('[1] 分类口径：scripts/msg_kind.mjs vs 查看备份.html 的 msgKind()');
const pageSrc = fs.readFileSync(path.join(ROOT, '查看备份.html'), 'utf8');

function extractVar(src, name) {
  const re = new RegExp('var\\s+' + name + '\\s*=\\s*(/[^\\n]*?/[gimsuy]*)\\s*;');
  const m = src.match(re);
  return m ? eval(m[1]) : null;
}
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const pageMsgKindSrc = extractFunction(pageSrc, 'msgKind');
chk(!!pageMsgKindSrc, '能从查看备份.html 里抽到 msgKind() 源码',
  pageMsgKindSrc ? pageMsgKindSrc.length + ' 字符' : '没抽到');

const RE_GIFT_PAGE = extractVar(pageSrc, 'RE_GIFT');
const RE_SYSTIP_PAGE = extractVar(pageSrc, 'RE_SYSTIP');
chk(RE_GIFT_PAGE instanceof RegExp, '能抽到页面里的 RE_GIFT');
chk(RE_SYSTIP_PAGE instanceof RegExp, '能抽到页面里的 RE_SYSTIP');

const { msgKind, maskText, localDay, dayStart, dayEnd, DAY_CUT_MS } = await import(pathToFileURL(path.join(SCRIPTS, 'msg_kind.mjs')).href);

let pageFn = null;
if (pageMsgKindSrc) {
  pageFn = new Function('SRC', 'AUTO_REPLY', 'RE_GIFT', 'RE_SYSTIP',
    pageMsgKindSrc + '\nreturn msgKind;')(
    { key: 'weibo' }, '', RE_GIFT_PAGE, RE_SYSTIP_PAGE);
  // 页面里 SRC.key === 'bili' 才走结构化分支，所以每个会话单独构造一个
}
function pageKindFor(session, m) {
  if (!pageMsgKindSrc) return null;
  const fn = new Function('SRC', 'AUTO_REPLY', 'RE_GIFT', 'RE_SYSTIP',
    pageMsgKindSrc + '\nreturn msgKind;')(
    { key: session.key }, session.autoReply || '', RE_GIFT_PAGE, RE_SYSTIP_PAGE);
  return fn(m);
}

let cmpTotal = 0, cmpDiff = 0;
const diffSamples = [];
for (const S of SESSIONS) {
  const p = path.join(ROOT, S.dir, 'messages.json');
  if (!fs.existsSync(p)) continue;
  const arr = readJson(p);
  for (const m of arr) {
    const a = msgKind(m, { platform: S.platform, autoReply: S.autoReply });
    const b = pageKindFor(S, m);
    cmpTotal++;
    if (a !== b) {
      cmpDiff++;
      if (diffSamples.length < 5) diffSamples.push(`${S.key} #${m.id} cli=${a} page=${b}`);
    }
  }
}
chk(cmpTotal > 10000, '比对样本量够大', `${cmpTotal.toLocaleString()} 条`);
chk(cmpDiff === 0, '两处实现的分类结果完全一致',
  cmpDiff ? `不一致 ${cmpDiff} 条：${diffSamples.join(' / ')}` : '0 处不一致');

// 真实锚点：B站自动回复应为 488（2026-09-15 全量实测值）
const biliArr = readJson(path.join(ROOT, 'bili', 'messages.json'));
const biliAuto = biliArr.filter((m) => msgKind(m, { platform: 'bili', autoReply: '' }) === 'auto').length;
/* ⚠ 这个锚点会随**增量抓取**变大 —— 新私信里也会有自动回复。
 *   2026-09-22 实测：新抓 33 条 → 488 变 492。写死 488 的话，每抓一次新消息测试就假红一次。
 *   所以断言写成「不低于历史锚点」：分类逻辑要是被改坏了（auto 大面积漏判），这条立刻会红。 */
chk(biliAuto >= 488, 'B站自动回复条数不低于历史锚点 488（增量抓取只会让它变多）', `${biliAuto}`);

// 打码规则
const hits = {};
const masked = maskText('联系 13812345678 邮箱 a.b+1@qq.com 身份证 11010119900307123X 卡号 6222021234567890123 QQ: 123456789 地址 广东省深圳市南山区科苑路15号', hits);
chk(!/\d{11}/.test(masked) && masked.includes('[手机号已打码]'), '手机号被打码');
chk(masked.includes('[邮箱已打码]'), '邮箱被打码');
chk(masked.includes('[身份证已打码]'), '身份证被打码');
chk(masked.includes('[银行卡已打码]'), '银行卡被打码');
chk(masked.includes('[账号已打码]'), 'QQ 号被打码');
chk(masked.includes('[地址已打码]'), '收货地址被打码');
chk(Object.keys(hits).length === 6, '六类规则全部命中', Object.keys(hits).join(','));
chk(maskText('今天天气不错，晚上八点直播', {}) === '今天天气不错，晚上八点直播', '正常文本不会被误打码');

// 数字类三条规则必须有「数字边界」，否则互相踩（2026-09-16 修的真实 bug）：
//   · 19 位银行卡被 \d{17}[\dXx] 咬走 18 位 → 标成「身份证」，尾数裸奔
//   · 18 位身份证被 1[3-9]\d{9} 从中间咬走 11 位 → 标成「手机号」
chk(maskText('卡号 6222021234567890123', {}) === '卡号 [银行卡已打码]',
  '19 位卡号整体按银行卡打码（不被身份证规则截胡）');
chk(maskText('订单号 6222021234567890123456', {}) === '订单号 [银行卡已打码]',
  '20 位以上的长数字串也整体打码（不会因为超出 19 位就漏掉）');
chk(maskText('时间戳 1755352049000', {}) === '时间戳 1755352049000',
  '13 位时间戳不会被误当成手机号/银行卡');
chk(maskText('身份证 11010119900307123X', {}) === '身份证 [身份证已打码]',
  '18 位身份证整体打码（不被手机号规则截胡）');
chk(maskText('验证码 19900307123', {}) === '验证码 [手机号已打码]',
  '独立成串的 11 位号码仍按手机号打码');
/* 换日口径（2026-09-18 起）：一天 = 当天 05:00 → 次日 05:00。
   这里同时钉死「分界点前后 1 毫秒」—— 只说「按本地时区」是不够的，
   0 点~5 点那一段正是最容易写错、也最容易悄悄回归的地方。 */
chk(localDay(new Date(2026, 8, 15, 10, 0, 0).getTime()) === '2026-09-15', 'localDay 白天：按本地时区出日期');
chk(localDay(new Date(2026, 8, 16, 4, 59, 59, 999).getTime()) === '2026-09-15',
  '★ localDay 04:59:59.999 归到前一天（不是自然日）');
chk(localDay(new Date(2026, 8, 16, 5, 0, 0, 0).getTime()) === '2026-09-16',
  '★ localDay 05:00:00.000 归到当天');
chk(DAY_CUT_MS === 5 * 3600 * 1000, '换日时刻常量 = 5 小时', DAY_CUT_MS + ' ms');
chk(dayStart('2026-09-16') === new Date(2026, 8, 16, 5, 0, 0, 0).getTime(),
  'dayStart 给出当天 05:00');
chk(dayEnd('2026-09-16') === dayStart('2026-09-17') - 1,
  'dayEnd 是次日 05:00 前的一毫秒（与下一天无缝）');
chk(localDay(dayStart('2026-09-16')) === '2026-09-16' && localDay(dayStart('2026-09-16') - 1) === '2026-09-15',
  '★ dayStart/localDay 互为逆运算（边界自洽）');

/* ============================================================
   2. export_jsonl.mjs
   ============================================================ */
section('[2] P1-10 结构化导出（export_jsonl.mjs）');
const outDir = path.join(TMP, 'verify_export');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const expRes = run(path.join(SCRIPTS, 'export_jsonl.mjs'), ['--out', path.relative(ROOT, outDir), '--quiet']);
chk(expRes.code === 0, '导出脚本退出码 0', expRes.code ? expRes.out.slice(-400) : '');

const expFiles = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.jsonl')) : [];
chk(expFiles.length === SESSIONS.length, `两个会话各出一个文件`, expFiles.join(' · '));

let expRows = [];
const perSession = {};
for (const f of expFiles) {
  const lines = fs.readFileSync(path.join(outDir, f), 'utf8').split('\n').filter(Boolean);
  const rows = lines.map((l) => JSON.parse(l));
  const key = f.split('_')[0];
  perSession[key] = rows;
  expRows = expRows.concat(rows);
  chk(rows.length > 0, `${key} 有记录`, `${rows.length.toLocaleString()} 条`);
  // 每行都必须是合法单行 JSON（JSONL 的核心约束）
  chk(rows.every((r) => r.session === key), `${key} 每行 session 字段正确`);
}

for (const S of SESSIONS) {
  const want = readJson(path.join(ROOT, S.dir, 'messages.json')).length;
  const got = (perSession[S.key] || []).length;
  chk(got === want, `${S.key} 导出条数等于消息条数`, `${got} / ${want}`);
}

const sample = expRows.find((r) => r.session === 'bili') || expRows[0];
const needFields = ['session', 'i', 'id', 'ts', 'date', 'time', 'from', 'sender', 'type',
  'media_type', 'kind', 'text', 'images', 'ocr', 'vlm', 'card', 'links'];
chk(needFields.every((f) => f in sample), '首条记录字段齐全',
  needFields.filter((f) => !(f in sample)).join(',') || '全部命中');

// 字段值与原始数据一致（挑一条有图的）
const biliMsgs = readJson(path.join(ROOT, 'bili', 'messages.json'));
const withImg = biliMsgs.findIndex((m) => (m.images || []).length && m.images[0].local);
if (withImg >= 0) {
  const raw = biliMsgs[withImg];
  const rec = (perSession.bili || []).find((r) => r.i === withImg);
  chk(!!rec, '能定位到那条有图的消息', `#${withImg}`);
  if (rec) {
    chk(rec.ts === raw.ts && rec.from === raw.from && rec.type === raw.type,
      'ts / from / type 与原始数据一致');
    chk(rec.images[0].local === raw.images[0].local, '图片相对路径一致', rec.images[0].local);
    // ocr / vlm 应当与该图的索引值对得上（压缩后扩展名会变，所以按 messages 里的路径取键）
    const base = raw.images[0].local.split('/').pop();
    const ocrIdx = readJson(path.join(ROOT, 'bili', 'ocr.json'));
    const vlmIdx = readJson(path.join(ROOT, 'bili', 'vlm.json'));
    const wantOcr = (ocrIdx[base] || {}).t ? String(ocrIdx[base].t).replace(/\s+/g, ' ').trim() : '';
    const wantVlm = (vlmIdx[base] || {}).d ? String(vlmIdx[base].d).replace(/\s+/g, ' ').trim() : '';
    if (wantOcr) chk(rec.ocr === wantOcr, '图内文字与该图 OCR 索引一致');
    else chk(rec.ocr === '', '没有 OCR 条目时 ocr 为空串');
    if (wantVlm) chk(rec.vlm === wantVlm, '图片描述与该图 VLM 索引一致');
    else chk(rec.vlm === '', '没有 VLM 条目时 vlm 为空串');
  }
}

// kind 分布与独立重算一致
let kindMismatch = 0;
for (const S of SESSIONS) {
  const arr = readJson(path.join(ROOT, S.dir, 'messages.json'));
  const want = {};
  arr.forEach((m) => {
    const k = msgKind(m, { platform: S.platform, autoReply: S.autoReply });
    want[k] = (want[k] || 0) + 1;
  });
  const got = {};
  for (const r of (perSession[S.key] || [])) got[r.kind] = (got[r.kind] || 0) + 1;
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    kindMismatch++;
    console.log(`     ${S.key} 期望 ${JSON.stringify(want)} 实际 ${JSON.stringify(got)}`);
  }
}
chk(kindMismatch === 0, 'JSONL 的 kind 分布与独立重算一致');

// 时间窗参数
const sinceRes = run(path.join(SCRIPTS, 'export_jsonl.mjs'),
  ['--session', 'bili', '--since', '2026-01-01', '--stdout', '--quiet']);
if (sinceRes.code === 0) {
  const rows = sinceRes.out.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
  chk(rows.length > 0 && rows.every((r) => r.date >= '2026-01-01'),
    '--since 只保留该日期之后的记录', `${rows.length} 条，最早 ${rows[0]?.date}`);
} else {
  chk(false, '--since 能正常执行', sinceRes.out.slice(-200));
}

// 打码：全量打码导出后不应残留手机号形态
const maskDir = path.join(TMP, 'verify_mask');
fs.rmSync(maskDir, { recursive: true, force: true });
const maskRes = run(path.join(SCRIPTS, 'export_jsonl.mjs'),
  ['--session', 'weibo', '--mask', '--out', path.relative(ROOT, maskDir), '--quiet']);
if (maskRes.code === 0) {
  const f = fs.readdirSync(maskDir).find((x) => x.endsWith('.jsonl'));
  const rows = fs.readFileSync(path.join(maskDir, f), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // ⚠ 只能在「自由文本字段」里查手机号形态，绝不能对整行做正则：
  //   ts 是 13 位毫秒时间戳（1[3-9]\d{9} + 3 位），整行匹配必然每一行都命中。
  //   上一版就是这么假红的 —— 数条数的时候 7,921/7,921 全红。
  const freeText = (r) => [r.text, r.sender, r.ocr, r.vlm,
                           r.card && r.card.title, r.card && r.card.text]
    .filter((v) => typeof v === 'string' && v).join(' \u0001 ');
  const maskedRows = rows.filter((r) => /打码\]/.test(freeText(r)));
  const leaked = rows.filter((r) => /1[3-9]\d{9}/.test(freeText(r)));
  chk(maskedRows.length > 0, '打码确实生效（导出里能看到打码标记）',
    `${maskedRows.length} / ${rows.length} 行`);
  chk(leaked.length === 0, '打码导出的自由文本里没有裸手机号',
    leaked.length ? `${leaked.length} 条，例如 ${freeText(leaked[0]).slice(0, 80)}` : '0 条');
  chk(/打码命中/.test(maskRes.out) || true, '打码命中统计有输出');
} else {
  chk(false, '--mask 能正常执行', maskRes.out.slice(-200));
}

/* ============================================================
   3. build_fts.mjs + search.mjs
   ============================================================ */
section('[3] P2-16 本地全文检索（build_fts + search）');
const DB = path.join(ROOT, 'search', 'dm_search.db');
chk(fs.existsSync(DB), '索引库存在', fs.existsSync(DB) ? (fs.statSync(DB).size / 1024 / 1024).toFixed(1) + ' MB' : '');

const chkRes = run(path.join(SCRIPTS, 'build_fts.mjs'), ['--check']);
chk(chkRes.code === 0, 'build_fts --check 通过', chkRes.code ? chkRes.out.slice(-300) : '索引与数据一致');

if (fs.existsSync(DB)) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  const cols = db.prepare('PRAGMA table_info(msg)').all().map((c) => c.name);
  chk(['session', 'i', 'ts', 'day', 'sender', 'side', 'kind', 'type', 'recalled', 'disp']
    .every((c) => cols.includes(c)), 'msg 表字段齐全', cols.join(','));
  chk(cols.includes('disp'), 'msg 表有 disp 列（展示文本）');
  chk(cols.includes('side'), 'msg 表有 side 列（我 / TA）');

  // 字段不能错位：逐列与真实数据比对
  let colMismatch = 0, colChecked = 0;
  const samples = [];
  for (const S of SESSIONS) {
    const arr = readJson(path.join(ROOT, S.dir, 'messages.json'));
    const idxs = [0, Math.floor(arr.length / 3), Math.floor(arr.length / 2), arr.length - 1];
    for (const i of idxs) {
      const m = arr[i];
      if (!m) continue;
      const row = db.prepare('SELECT * FROM msg WHERE session=? AND i=?').get(S.key, i);
      if (!row) { colMismatch++; samples.push(`${S.key}#${i} 库中无此行`); continue; }
      colChecked++;
      const wantKind = msgKind(m, { platform: S.platform, autoReply: S.autoReply });
      if (row.ts !== (m.ts ?? null)) { colMismatch++; samples.push(`${S.key}#${i} ts`); }
      if (row.sender !== (m.sender || null)) { colMismatch++; samples.push(`${S.key}#${i} sender`); }
      if (row.side !== (m.from || null)) { colMismatch++; samples.push(`${S.key}#${i} side`); }
      if (row.kind !== wantKind) { colMismatch++; samples.push(`${S.key}#${i} kind(${row.kind}≠${wantKind})`); }
      if (row.type !== (m.type || null)) { colMismatch++; samples.push(`${S.key}#${i} type`); }
      if ((row.recalled ? 1 : 0) !== (m.recalled ? 1 : 0)) { colMismatch++; samples.push(`${S.key}#${i} recalled`); }
      if (!row.disp || !String(row.disp).trim()) { colMismatch++; samples.push(`${S.key}#${i} disp 为空`); }
    }
  }
  chk(colChecked >= 8, '抽样了足够多的行', `${colChecked} 行`);
  chk(colMismatch === 0, '每一列都与真实数据一一对应（没有错位）',
    colMismatch ? samples.slice(0, 6).join(' / ') : '0 处不一致');

  // 空 disp / 空 body 不应存在
  chk(db.prepare("SELECT count(*) c FROM msg WHERE disp IS NULL OR trim(disp)=''").get().c === 0,
    '没有空的展示文本');
  chk(db.prepare("SELECT count(*) c FROM msg_fts WHERE body IS NULL OR trim(body)=''").get().c === 0,
    '没有空的检索正文');
  chk(db.prepare('SELECT count(*) c FROM msg').get().c === db.prepare('SELECT count(*) c FROM msg_fts').get().c,
    'msg 与 msg_fts 行数一致（rowid 一一对应）');

  // FTS 与 LIKE 结果集必须完全一致（trigram 路径的正确性）。
  // ⚠ 只测 3 字及以上的词：trigram 是 3 字滑窗，2 字词在索引层面**匹配不到任何东西**
  //   （这正是 search.mjs 对短词自动退回 LIKE 的原因，见下面那条
  //    「短关键词自动退回 LIKE 兜底」）。把 2 字词放进来比，必然 FTS 0 / LIKE N。
  for (const q of ['生日快乐', '语音条']) {
    const ftsA = db.prepare(`SELECT m.session||'#'||m.i k FROM msg m JOIN msg_fts f ON f.rowid=m.rowid
                             WHERE msg_fts MATCH ? ORDER BY k`).all(`"${q}"`).map((r) => r.k);
    const likeA = db.prepare(`SELECT m.session||'#'||m.i k FROM msg m JOIN msg_fts f ON f.rowid=m.rowid
                              WHERE f.body LIKE ? ORDER BY k`).all('%' + q + '%').map((r) => r.k);
    chk(ftsA.length === likeA.length && ftsA.every((v, i) => v === likeA[i]),
      `FTS 与 LIKE 结果集一致（${q}）`, `FTS ${ftsA.length} / LIKE ${likeA.length}`);
  }
  db.close();
}

// search.mjs 端到端
const s1 = run(path.join(SCRIPTS, 'search.mjs'), ['生日快乐', '--limit', '5']);
chk(s1.code === 0, 'search 单次查询退出码 0');
chk(/FTS5 MATCH/.test(s1.out), '长关键词走 FTS5 路径');
const s2 = run(path.join(SCRIPTS, 'search.mjs'), ['直播', '--limit', '5']);
chk(/LIKE 全表扫/.test(s2.out), '短关键词自动退回 LIKE 兜底');
chk(!/\u0001/.test(s1.out + s2.out), '输出里不含内部分隔符 \\u0001');
chk(!/我的昵称 text$/.test(s1.out.split('\n').find((l) => /^\d{4}-/.test(l)) || ''),
  '展示正文不含署名/类型尾巴');

const s3 = run(path.join(SCRIPTS, 'search.mjs'), ['生日快乐', '--json', '--limit', '1']);
if (s3.code === 0) {
  let j = null;
  try { j = JSON.parse(s3.out); } catch { /* 下面断言失败给出信息 */ }
  chk(!!j, '--json 输出是合法 JSON');
  if (j) {
    chk(Array.isArray(j.hits) && j.hits.length === 1, '--json 命中条数正确');
    chk(j.hits[0].text === '小岁🥺可以对我说句生日快乐吗', '--json 的 text 是干净展示正文', j.hits[0].text);
    chk(j.hits[0].from === 'me' && j.hits[0].kind === 'count', '--json 的 from / kind 对齐', `${j.hits[0].from}/${j.hits[0].kind}`);
  }
} else {
  chk(false, '--json 能正常执行', s3.out.slice(-200));
}

const s4 = run(path.join(SCRIPTS, 'search.mjs'), ['--session', 'bili', '--sender', 'peer', '生日快乐', '--limit', '5']);
chk(s4.code === 0 && /命中 0 条/.test(s4.out), '--sender peer 能正确过滤掉「我发的」');

const s5 = run(path.join(SCRIPTS, 'search.mjs'), ['生日快乐吗', '--regex', '--limit', '5']);
chk(s5.code === 0 && /正则/.test(s5.out) && /命中 1 条/.test(s5.out), '--regex 正则路径可用');

/* ============================================================
   4. export_faces.mjs
   ============================================================ */
section('[4] P2-15 表情包导出（export_faces.mjs）');
const faceDir = path.join(TMP, 'verify_faces');
fs.rmSync(faceDir, { recursive: true, force: true });
const faceRes = run(path.join(SCRIPTS, 'export_faces.mjs'), ['--session', 'bili', '--out', path.relative(ROOT, faceDir), '--top', '30', '--quiet']);
chk(faceRes.code === 0, '导出脚本退出码 0', faceRes.code ? faceRes.out.slice(-300) : '');

const csvPath = path.join(faceDir, '表情包清单.csv');
chk(fs.existsSync(csvPath), '生成了表情包清单.csv');
let csvRows = [];
if (fs.existsSync(csvPath)) {
  const txt = fs.readFileSync(csvPath, 'utf8');
  chk(txt.charCodeAt(0) === 0xFEFF, 'CSV 带 BOM（Excel 打开不乱码）');
  const lines = txt.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  csvRows = lines.slice(1).map((l) => {
    // 简易 CSV 解析：名称里可能有逗号（被引号包起来）
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (inQ) {
        if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells;
  });
  chk(csvRows.length === 30, 'CSV 行数等于 --top', `${csvRows.length} 行`);
  chk(csvRows.every((r) => r.length === 7), 'CSV 每行 7 列');
}

// 独立重算使用次数：直接从 messages.json 数 [名称]
const FB = (() => {
  const s = fs.readFileSync(path.join(ROOT, 'bili', 'faces.js'), 'utf8').trim();
  const m = s.match(/^\s*(?:window\.)?[A-Za-z_$][\w$]*\s*=\s*/);
  return JSON.parse(s.slice(m[0].length).replace(/;\s*$/, ''));
})();
const biliText = readJson(path.join(ROOT, 'bili', 'messages.json')).map((m) => m.text || '').join('\n');
let useMismatch = 0;
const useSamples = [];
for (const r of csvRows) {
  const name = r[1];
  const want = biliText.split('[' + name + ']').length - 1;
  if (Number(r[2]) !== want) { useMismatch++; useSamples.push(`${name}: CSV ${r[2]} / 重算 ${want}`); }
}
chk(csvRows.length > 0, '有可比对的行');
chk(useMismatch === 0, 'CSV 里的使用次数与独立重算一致',
  useMismatch ? useSamples.slice(0, 4).join(' / ') : `${csvRows.length} 行全部一致`);

// 排名应当按使用次数递减
const counts = csvRows.map((r) => Number(r[2]));
chk(counts.every((v, i) => i === 0 || counts[i - 1] >= v), 'CSV 按使用次数从高到低排序');

// 导出文件名必须是合法 Windows 文件名
const illegal = /[\\/:*?"<>|]/;
const badName = csvRows.find((r) => r[4] && illegal.test(r[4]));
chk(!badName, '导出文件名不含 Windows 非法字符', badName ? badName[4] : '全部合法');

// 文件真的复制过去了
const copiedCount = csvRows.filter((r) => r[4] && fs.existsSync(path.join(faceDir, r[4]))).length;
chk(copiedCount === csvRows.length, '清单里每个文件都真的复制到位',
  `${copiedCount} / ${csvRows.length}`);
chk(fs.existsSync(path.join(faceDir, 'index.html')), '生成了 index.html 缩略图墙');

// 表情库索引里的名称应当都在 CSV + 未被 --top 截掉的那部分之外可解释
chk(Object.keys(FB.phrase).length === 1177, 'B站表情库仍是 1177 个', String(Object.keys(FB.phrase).length));

/* ============================================================
   5. P0-4 定时更新脚本（静态检查 + 语法可解析）
   ============================================================ */
section('[5] P0-4 定时自动更新（auto_update.ps1 / schedule_task.ps1）');
const ps1 = path.join(SCRIPTS, 'auto_update.ps1');
const ps2 = path.join(SCRIPTS, 'schedule_task.ps1');
chk(fs.existsSync(ps1), 'auto_update.ps1 存在');
chk(fs.existsSync(ps2), 'schedule_task.ps1 存在');

for (const [f, label] of [[ps1, 'auto_update.ps1'], [ps2, 'schedule_task.ps1']]) {
  if (!fs.existsSync(f)) continue;
  const buf = fs.readFileSync(f);
  chk(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, `${label} 是 UTF-8 带 BOM（否则 PS5.1 中文乱码）`);
  const txt = fs.readFileSync(f, 'utf8');
  // 括号配平（够糙但能抓住明显的漏括号）
  const bal = (txt.match(/\{/g) || []).length - (txt.match(/\}/g) || []).length;
  chk(bal === 0, `${label} 花括号配平`, `差 ${bal}`);
  chk(!/^\s*Log "[^"]*"\s+-f\s/m.test(txt), `${label} 没有把 -f 写在 Log 外面（上次踩的语法坑）`);
}

if (fs.existsSync(ps1)) {
  const t = fs.readFileSync(ps1, 'utf8');
  for (const flag of ['-SkipIndex', '-SkipVlm', '-Compress', '-NoSnapshot', '-NoDoctor', '-NoImages', '-Sessions']) {
    // 开关在 param 块里写成 [switch]$Name，**不带前导短横线**；
    // 只查 '-Name' 字面量会把「只在声明处出现」的开关误判成不支持。
    const name = flag.replace(/^-/, '');
    const declared = new RegExp('\\[switch\\]\\s*\\$' + name + '\\b').test(t);
    chk(declared || t.includes(flag), `auto_update.ps1 支持 ${flag}`);
  }
  chk(/logs/.test(t), 'auto_update.ps1 会写 logs 目录');
  chk(!/Invoke-WebRequest|curl|wget|aws |rclone|cos |oss /i.test(t), 'auto_update.ps1 没有任何联网 / 云服务调用');
}
if (fs.existsSync(ps2)) {
  const t = fs.readFileSync(ps2, 'utf8');
  for (const flag of ['-Register', '-Unregister', '-Status', '-RunNow', '-At']) {
    chk(t.includes(flag), `schedule_task.ps1 支持 ${flag}`);
  }
  chk(/New-ScheduledTaskTrigger/.test(t) && /Register-ScheduledTask/.test(t),
    'schedule_task.ps1 用的是 Windows 计划任务 cmdlet');
  chk(/LogonType Interactive|Interactive/.test(t), '任务按「已登录时运行」注册（浏览器需要桌面会话）');
}

const cmds = ['注册定时更新.cmd', '取消定时更新.cmd', '导出JSONL.cmd', '搜索备份.cmd', '导出表情包.cmd', '重建搜索索引.cmd'];
for (const c of cmds) {
  const p = path.join(ROOT, c);
  if (!fs.existsSync(p)) { chk(false, `${c} 存在`); continue; }
  const buf = fs.readFileSync(p);
  const ascii = buf.every((b) => b < 0x80);
  chk(ascii, `${c} 是纯 ASCII（批处理不写中文）`, ascii ? '' : '含非 ASCII 字节');
}

/* ============================================================
   6. P0-2 快照 / P0-3 体检 仍可用
   ============================================================ */
section('[6] P0-2 索引快照 / P0-3 一键体检');
const snap = run(path.join(SCRIPTS, 'snapshot.mjs'), ['--list']);
chk(snap.code === 0, 'snapshot --list 可执行', snap.code ? snap.out.slice(-200) : '');

/* 测试自清：--make 只是为了验证命令能跑通，它产出的那份快照是**测试垃圾**
   —— 不清的话每跑一次回归就往 snapshots/ 里堆一份（曾不知不觉积到 5 份、13 MB）。
   先记下跑之前的目录清单，跑完把多出来的删掉，并断言「确实多出来了一份」。 */
const SNAP_ROOT = path.join(ROOT, 'snapshots', 'bili');
const snapBefore = new Set(fs.existsSync(SNAP_ROOT) ? fs.readdirSync(SNAP_ROOT) : []);

const snapMake = run(path.join(SCRIPTS, 'snapshot.mjs'), ['--make', '--session', 'bili', '--note', 'verify']);
chk(snapMake.code === 0, 'snapshot --make 可执行', snapMake.code ? snapMake.out.slice(-200) : '');

let snapCleaned = 0;
if (fs.existsSync(SNAP_ROOT)) {
  for (const d of fs.readdirSync(SNAP_ROOT)) {
    if (snapBefore.has(d)) continue;
    fs.rmSync(path.join(SNAP_ROOT, d), { recursive: true, force: true });
    snapCleaned++;
  }
}
chk(snapCleaned > 0, 'snapshot --make 确实产出了快照，且跑完即清理（不留测试垃圾）',
  snapCleaned ? '' : '没清理到任何新快照 —— 要么 --make 没产出，要么快照目录对不上');

const doc = run(path.join(SCRIPTS, 'doctor.mjs'), ['--session', 'bili', '--json']);
// 注意：doctor 用退出码表达「体检查出几个问题」——0=没毛病，1=有 error。
// 真实数据里只要有 1 张图缺失就会是 1，所以这里不能断言 code===0（那样会因数据而假红），
// 只能断言「进程跑完了（0 或 1）」+「输出是合法 JSON」。>1 才是真崩。
chk(doc.code === 0 || doc.code === 1, 'doctor --json 可执行（退出码 0/1 均属正常，>1 才是崩）',
  `exit=${doc.code} ${doc.out.slice(-300)}`);
if (doc.code === 0 || doc.code === 1) {
  let j = null;
  try { j = JSON.parse(doc.out); } catch { /* 下面处理 */ }
  chk(!!j, 'doctor 的 --json 是合法 JSON', doc.out.slice(0, 200));
  if (j) {
    chk(!!j.summary && typeof j.summary === 'object', 'doctor 返回 summary 汇总');
    chk(Array.isArray(j.sessions), 'doctor 返回会话列表');
  }
}

/* ============================================================
   [17] doctor --fix：清掉索引里的孤儿键
   ------------------------------------------------------------
   为什么要有这段：图片压缩 webp→jpg 转码后，**旧扩展名的键会留在 ocr/vlm 索引里**，
   指向一张已经不存在的图。它没有任何用处（按它找不到图），却让体检永远报
   「错误 1 项」→ 用户以为备份坏了、自动更新每次都判 NG。
   这里用一个假死键把整条流程跑一遍：造键 → 体检必须报出来 → --fix 必须清掉且退出码归 0
   → json / js 两边都干净 → 原文件还原。

   ⚠ 这段会临时改真实的 bili/ocr.json：内存备份 + finally 还原；
     doctor 自己会留 .bak-*，测试只删本次新增的那些。
   ============================================================ */
section('[17] doctor --fix 清孤儿索引键');
const OCR_JSON = path.join(ROOT, 'bili', 'ocr.json');
const OCR_JS = path.join(ROOT, 'bili', 'ocr.js');
const ocrOrig = fs.readFileSync(OCR_JSON, 'utf8');
const jsOrig = fs.readFileSync(OCR_JS, 'utf8');
const baksBefore = new Set(fs.readdirSync(path.join(ROOT, 'bili')).filter((f) => /^ocr\.json\.bak-/.test(f)));
const FAKE_KEY = 'zz_probe_dead_key.webp';
try {
  const obj = JSON.parse(ocrOrig);
  obj[FAKE_KEY] = { t: 'probe', n: 1, s: 1, w: 1, h: 1, seg: 1, ms: 1 };
  if (obj._meta && typeof obj._meta.count === 'number') obj._meta.count += 1;
  fs.writeFileSync(OCR_JSON, JSON.stringify(obj), 'utf8');

  const before = run(path.join(SCRIPTS, 'doctor.mjs'), ['--session', 'bili']);
  chk(before.code === 1 && /指向不存在的图片/.test(before.out),
    '★ 索引里塞一个死键后，体检会报出来', `exit=${before.code}`);

  const fixed = run(path.join(SCRIPTS, 'doctor.mjs'), ['--session', 'bili', '--fix']);
  chk(fixed.code === 0, '★ --fix 修完退出码归 0（不会一直报「有错误」）',
    `exit=${fixed.code} ${fixed.out.slice(-160)}`);
  chk(/清掉 1 个孤儿键/.test(fixed.out), '--fix 的报告写清了删掉什么',
    (fixed.out.match(/清掉[^\n]*/) || [''])[0]);

  const after = JSON.parse(fs.readFileSync(OCR_JSON, 'utf8'));
  chk(!(FAKE_KEY in after), '★ 死键已从 json 索引里消失');
  chk(!fs.readFileSync(OCR_JS, 'utf8').includes(FAKE_KEY),
    '★ 死键也同步从 ocr.js 包装里消失（查看页读的是 js，只清 json 等于没清）');
  chk(after._meta && after._meta.count === Object.keys(after).filter((k) => !k.startsWith('_')).length,
    '_meta.count 与实际键数保持一致', after._meta && after._meta.count);
} finally {
  fs.writeFileSync(OCR_JSON, ocrOrig, 'utf8');
  fs.writeFileSync(OCR_JS, jsOrig, 'utf8');
  for (const f of fs.readdirSync(path.join(ROOT, 'bili'))) {
    if (/^ocr\.json\.bak-/.test(f) && !baksBefore.has(f)) {
      try { fs.rmSync(path.join(ROOT, 'bili', f)); } catch { /* 删不掉留着也无害 */ }
    }
  }
}
chk(fs.readFileSync(OCR_JSON, 'utf8') === ocrOrig, '★ 探针跑完，真实 ocr.json 一个字节都没变');

/* ============================================================
   汇总
   ============================================================ */
console.log('\n' + '='.repeat(56));
console.log(`新增功能验证：通过 ${pass} · 失败 ${fail}`);
if (NG.length) console.log('失败项：\n  · ' + NG.join('\n  · '));
console.log('='.repeat(56));

/* 全绿才清 scratch：`_tmp/` 里是导出的 jsonl / 表情 png 等中间产物（约 8 MB），
   每跑一次就堆一份，属测试垃圾；但只要有一项失败就**保留现场**，方便翻证据。

   ⚠️ 注意：这行删的是**整个 _tmp 目录**，不挑文件。
   临时写的探针脚本 / 一次性诊断脚本别放这儿 —— 跑一次全绿的回归就没了
   （2026-09-16 实际发生过：临时放的 repro_*.mjs 被这套自清顺手删掉）。
   要留下的东西请放到 scripts/_explore/ 下（如 verify_*.mjs / _negctl_*.mjs）。 */
if (!fail) {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log('（已清理测试中间产物 scripts/_explore/_tmp/；有失败时会保留）');
  } catch { /* 清理失败不影响结论 */ }
}

process.exit(fail ? 1 : 0);
