/**
 * 同步微博官方表情图片到 data/faces/，并生成 data/faces.js
 *   - 官方 face 表情：https://face.t.sinajs.cn/t4/appstyle/expression/ext/normal/xx/xxx_mobile.png
 *   - 旧版大表情（文本里的 /eeXXXX.png）：https://img.t.sinajs.cn/t4/appstyle/expression/emimage/eeXXXX.png
 * 用法：node sync_faces.mjs
 */
import fs from 'fs';
import path from 'node:path';
import { findSession, sessionFromArgs } from './sessions.mjs';

// 多会话支持：--session <key> 决定数据目录与 faces.js 里的全局名。
// 顺带修掉一个老问题：ROOT 原来写死成绝对路径，换台机器/换个目录就跑不了。
const ARGS = process.argv.slice(2);
const SESSION = findSession(sessionFromArgs(ARGS, 'weibo'));
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, SESSION.dir);
const DIR = path.join(DATA, 'faces');
const RAW = path.join(DATA, 'raw');
const REL_PREFIX = SESSION.dir + '/faces/';   // faces.js 里存的是相对路径
const FACES_GLOBAL = SESSION.globals.faces;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const HDR = { 'User-Agent': UA, 'Referer': 'https://weibo.com/' };
const CONC = 10;
const EMIMAGE = 'https://img.t.sinajs.cn/t4/appstyle/expression/emimage/';
// type=all 才是全量（564 个）；不带 type 只有 341 个
const LIST_API = 'https://api.weibo.com/2/emotions.json?source=209678993&type=all';

// 官方给的通常是 _org（原图，较大），优先换成 _mobile（96×96，够清晰又小）
function candidates(url) {
  const out = [];
  if (/_org\.(png|gif)$/i.test(url)) out.push(url.replace(/_org\.(png|gif)$/i, '_mobile.$1'));
  out.push(url);
  if (/_mobile\.(png|gif)$/i.test(url)) out.push(url.replace(/_mobile\.(png|gif)$/i, '_org.$1'));
  return [...new Set(out)];
}
// 文件名直接用 CDN 上的名字（保留尺寸后缀），这样旧缓存能继续复用
function fileName(url) {
  const m = String(url).match(/\/([0-9a-z]{2})\/([^/?#]+)$/i);
  const raw = m ? m[1] + '_' + m[2] : String(url).split('/').pop();
  return raw.replace(/[^\w.\-]/g, '_');
}

fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchBuf(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: HDR });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      if (r.status === 404 || r.status === 403) return null;
    } catch (e) { /* retry */ }
    await sleep(250 * i);
  }
  return null;
}

async function pool(items, worker, conc = CONC) {
  const out = new Array(items.length);
  let i = 0;
  const n = Math.min(conc, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await worker(items[k], k); }
  }));
  return out;
}

/* ---------- 1. 官方表情列表 ---------- */
log('[1/4] 拉取官方表情列表…');
let list = null;
const lb = await fetchBuf(LIST_API);
if (lb) { try { list = JSON.parse(lb.toString('utf8')); } catch (e) {} }
if (!Array.isArray(list) && fs.existsSync(RAW + '/emo_api.json')) {
  list = JSON.parse(fs.readFileSync(RAW + '/emo_api.json', 'utf8'));
  log('      接口失败，改用本地缓存');
}
if (!Array.isArray(list)) { log('      [×] 拿不到表情列表，放弃'); process.exit(1); }
log('      官方表情 ' + list.length + ' 个');
try { fs.writeFileSync(RAW + '/emo_api.json', JSON.stringify(list)); } catch (e) {}

/* ---------- 2. 扫描消息里实际用到的表情 ---------- */
log('[2/4] 扫描聊天记录里的表情…');
const MSG = DATA + '/messages.json';
const M = fs.existsSync(MSG) ? JSON.parse(fs.readFileSync(MSG, 'utf8')) : [];
const phNeed = new Set(), eeNeed = new Set();
const RE_EE = /\/?(ee[0-9a-f]{4,6})\.(?:png|gif)/gi;
const RE_BR = /\[([^\[\]\s]{1,20})\]/g;
for (const m of M) {
  const t = m.text; if (!t) continue;
  let r;
  RE_EE.lastIndex = 0; while ((r = RE_EE.exec(t))) eeNeed.add(r[1].toLowerCase());
  RE_BR.lastIndex = 0;
  while ((r = RE_BR.exec(t))) {
    const n = r[1];
    if (!/^\/?ee[0-9a-f]{4,6}\.(?:png|gif)$/i.test(n) && !/^\//.test(n)) phNeed.add(n);
  }
}
log('      用到中文表情名 ' + phNeed.size + ' 种，ee 大表情 ' + eeNeed.size + ' 个');

/* ---------- 3. 下载 ---------- */
const tasks = [];
for (const e of list) {
  const ph = e.phrase, url = e.url || e.icon;
  if (!ph || !url) continue;
  const cands = candidates(url);
  tasks.push({ ph, url, fn: fileName(cands[0]), cands });
}
for (const name of eeNeed) {
  tasks.push({ ee: name, url: EMIMAGE + name + '.png', fn: name + '.png', cands: [EMIMAGE + name + '.png'] });
}
log('[3/4] 同步表情图片（共 ' + tasks.length + ' 个）…');
let ok = 0, skip = 0, fail = 0;
const fails = [];
await pool(tasks, async (t) => {
  const p = DIR + '/' + t.fn;
  if (fs.existsSync(p) && fs.statSync(p).size > 0) { t.final = t.fn; skip++; return; }
  let buf = null;
  for (const cu of t.cands) { buf = await fetchBuf(cu); if (buf) break; }
  if (!buf) { fail++; fails.push(t.url); return; }
  fs.writeFileSync(p, buf);
  t.final = t.fn; ok++;
});
log('      新下载 ' + ok + ' · 已存在 ' + skip + ' · 失败 ' + fail);

/* ---------- 4. 生成 faces.js ---------- */
const phrase = {}, ee = {};
for (const t of tasks) {
  if (!t.final) continue;
  const rel = 'data/faces/' + t.final;
  if (t.ph) phrase[t.ph] = rel;
  if (t.ee) ee[t.ee] = rel;
}
const js = 'window.DM_FACES = ' + JSON.stringify({ phrase, ee, updated_at: new Date().toISOString() }) + ';\n';
fs.writeFileSync(DATA + '/faces.js', js);
log('[4/4] 生成 data/faces.js：中文表情 ' + Object.keys(phrase).length + ' · ee 表情 ' + Object.keys(ee).length);

// 清理 faces 目录里不再被引用的旧表情文件，保持目录干净
try {
  const keep = new Set();
  Object.values(phrase).concat(Object.values(ee)).forEach(p => keep.add(String(p).replace('data/faces/', '')));
  let cleaned = 0;
  for (const f of fs.readdirSync(DIR)) {
    if (!/\.(png|gif|jpe?g|webp)$/i.test(f)) continue;
    if (keep.has(f)) continue;
    try { fs.unlinkSync(DIR + '/' + f); cleaned++; } catch (e) {}
  }
  if (cleaned) log('      清理旧表情文件 ' + cleaned + ' 个');
} catch (e) {}

if (fails.length) log('      失败样例：' + fails.slice(0, 5).join(' , '));
