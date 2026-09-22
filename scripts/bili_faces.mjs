/**
 * 同步 B站表情图片到 bili/faces/，并生成 bili/faces.js（window.DM_FACES_B）
 * ---------------------------------------------------------------------------
 * 三个来源合并：
 *   1) bili/emoji_map.json —— fetch_session_msgs 随消息返回的 e_infos（最准，只用得到的）
 *   2) 表情面板接口 x/emote/user/panel/web（business=reply / dynamic / im）
 *   3) 扫描 bili/messages.json 正文里形如 [tv_doge] 的记号，能对上就收
 *
 * 用法：node bili_faces.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { findSession, sessionFromArgs } from './sessions.mjs';
import { jsAssign } from './lib/jsassign.mjs';

// 多会话支持：--session <key> 决定数据目录与 faces.js 里的全局名
const ARGS = process.argv.slice(2);
const SESSION = findSession(sessionFromArgs(ARGS, 'bili'));
const ROOT = path.resolve(import.meta.dirname, '..');
const BDIR = path.join(ROOT, SESSION.dir);
const DIR = path.join(BDIR, 'faces');
const RAW = path.join(BDIR, 'raw');
const REL_PREFIX = SESSION.dir + '/faces/';   // faces.js 里存的是相对路径
const FACES_GLOBAL = SESSION.globals.faces;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
const CONC = 10;
const PANELS = ['reply', 'dynamic', 'im'];

let COOKIE = '';
try { COOKIE = fs.readFileSync(path.join(BDIR, 'cookie_header.txt'), 'utf8').trim(); } catch {}
const HDR = () => ({
  'User-Agent': UA,
  Referer: 'https://message.bilibili.com/',
  ...(COOKIE ? { Cookie: COOKIE } : {}),
});

fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const up = (u) => {
  u = String(u || '').trim();
  if (!u) return '';
  return (u.startsWith('//') ? 'https:' + u : u).replace(/^http:\/\//, 'https://').replace(/@[^/]*$/, '');
};
// 文件名用 CDN 上的原名（去掉查询串与后缀尺寸），便于复用旧缓存
function fileName(url) {
  const m = String(url).match(/\/([^/?#]+?)(@[^/?#]*)?$/);
  let n = m ? m[1] : String(url).split('/').pop();
  n = n.replace(/[^\w.\-]/g, '_');
  if (!/\.(png|gif|jpe?g|webp)$/i.test(n)) n += '.png';
  return n;
}

async function fetchText(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: HDR(), signal: AbortSignal.timeout(25000) });
      if (r.ok) return await r.text();
      if (r.status === 404 || r.status === 403) return null;
    } catch { /* retry */ }
    await sleep(300 * i);
  }
  return null;
}
async function fetchBuf(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: HDR(), signal: AbortSignal.timeout(30000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      if (r.status === 404 || r.status === 403) return null;
    } catch { /* retry */ }
    await sleep(250 * i);
  }
  return null;
}
async function pool(items, worker, conc = CONC) {
  let i = 0;
  const n = Math.min(conc, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; await worker(items[k], k); }
  }));
}

/* ---------- 1. 收集「名字 → 图片地址」 ---------- */
const map = {};                       // '[doge]' → 原始 url
let fromEMap = 0, fromPanel = 0;

// 1a) 消息里带回来的 e_infos（最准）
const emojiJson = path.join(BDIR, 'emoji_map.json');
if (fs.existsSync(emojiJson)) {
  try {
    const em = JSON.parse(fs.readFileSync(emojiJson, 'utf8'));
    for (const [text, v] of Object.entries(em)) {
      const u = up((v && (v.gif || v.url)) || '');
      if (text && u) { if (!map[text]) fromEMap++; map[text] = u; }
    }
  } catch (e) { log('      [警告] emoji_map.json 解析失败：' + e.message); }
}
log('[1/5] emoji_map.json 提供 ' + fromEMap + ' 个表情');

// 1b) 表情面板接口
log('[2/5] 拉取表情面板…');
const rawPanels = {};
for (const biz of PANELS) {
  const t = await fetchText(`https://api.bilibili.com/x/emote/user/panel/web?business=${biz}`);
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = null; }
  if (!j || j.code !== 0) { log(`      ${biz}: 拿不到（${(j && j.message) || '无响应'}）`); continue; }
  rawPanels[biz] = j;
  let n = 0;
  for (const pk of ((j.data && j.data.packages) || [])) {
    for (const e of (pk.emote || [])) {
      if (!e || !e.text) continue;
      const u = up(e.url || e.gif_url || '');
      if (!u) continue;
      if (!map[e.text]) { map[e.text] = u; fromPanel++; }
      else if (/\.gif$/i.test(u) && !/\.gif$/i.test(map[e.text])) map[e.text] = u;  // 有动图优先动图
      n++;
    }
  }
  log(`      ${biz}: ${n} 个表情`);
  await sleep(250);
}
try { fs.writeFileSync(path.join(RAW, 'emote_panel.json'), JSON.stringify(rawPanels).slice(0, 4_000_000)); } catch {}

// 1c) 扫描聊天记录里实际用到的记号（面板里没有的也记下来，便于发现遗漏）
const MSG = path.join(BDIR, 'messages.json');
const M = fs.existsSync(MSG) ? JSON.parse(fs.readFileSync(MSG, 'utf8')) : [];
const used = new Set(), missed = new Set();
const RE_BR = /\[([^\[\]\s]{1,20})\]/g;
for (const m of M) {
  const t = m.text; if (!t) continue;
  let r; RE_BR.lastIndex = 0;
  while ((r = RE_BR.exec(t))) {
    const tk = '[' + r[1] + ']';
    used.add(tk);
    if (!map[tk]) missed.add(tk);
  }
}
log('[3/5] 聊天记录里出现过 ' + used.size + ' 种表情记号，其中 ' + missed.size + ' 种没找到图');

/* ---------- 2. 下载 ---------- */
const tasks = Object.entries(map).map(([text, url]) => ({ text, url, fn: fileName(url) }));
log('[4/5] 同步表情图片（共 ' + tasks.length + ' 个）…');
let ok = 0, skip = 0, fail = 0;
const fails = [];
await pool(tasks, async (t) => {
  const p = path.join(DIR, t.fn);
  if (fs.existsSync(p) && fs.statSync(p).size > 0) { t.final = t.fn; skip++; return; }
  const buf = await fetchBuf(t.url);
  if (!buf) { fail++; fails.push(t.url); return; }
  fs.writeFileSync(p, buf);
  t.final = t.fn; ok++;
});
log('      新下载 ' + ok + ' · 已存在 ' + skip + ' · 失败 ' + fail);
if (fails.length) log('      失败样例：' + fails.slice(0, 3).join(' , '));

/* ---------- 3. 生成 faces.js ---------- */
const phrase = {};
for (const t of tasks) {
  if (t.final) phrase[t.text.replace(/^\[|\]$/g, '')] = 'bili/faces/' + t.final;
}
fs.writeFileSync(path.join(BDIR, 'faces.js'),
  jsAssign('DM_FACES_B', JSON.stringify({ phrase, ee: {}, updated_at: new Date().toISOString() })), 'utf8');
log('[5/5] 生成 bili/faces.js：表情 ' + Object.keys(phrase).length + ' 个');

// 清理不再被引用的旧文件
try {
  const keep = new Set(Object.values(phrase).map(p => String(p).replace('bili/faces/', '')));
  let cleaned = 0;
  for (const f of fs.readdirSync(DIR)) {
    if (!/\.(png|gif|jpe?g|webp)$/i.test(f)) continue;
    if (keep.has(f)) continue;
    try { fs.unlinkSync(path.join(DIR, f)); cleaned++; } catch {}
  }
  if (cleaned) log('      清理旧表情文件 ' + cleaned + ' 个');
} catch {}

if (missed.size) {
  const sample = [...missed].slice(0, 12).join(' ');
  fs.writeFileSync(path.join(RAW, 'faces_missing.txt'), [...missed].join('\n'), 'utf8');
  log('      未找到图的表情记号（已写入 bili/raw/faces_missing.txt）：' + sample);
}
