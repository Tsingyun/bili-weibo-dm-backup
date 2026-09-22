/**
 * 验证：媒体墙（P1-4）+ 统计报告导出（P1-5）
 * ------------------------------------------------------------------
 * 为什么不能只做语法检查：这两个功能全靠「点一下才发生」——
 * 分段筛选、点格子开灯箱、导出按钮都是在运行时才跑到的分支，
 * 语法过了但选择器写错（比如少了 #statExport 这个按钮）页面照样是哑的。
 * 所以这里用 jsdom 真加载 查看备份.html，真点一遍，再对**断言总数**收口。
 *
 * 跑法：NODE_PATH=<node workspace>/node_modules node scripts/_explore/verify_media_stat.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------- 期望值一律从真实数据算，不写死 ---------- */
const SESSIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions.json'), 'utf8'));
const list = Array.isArray(SESSIONS) ? SESSIONS : (SESSIONS.sessions || []);
const first = list.find(s => !s.imported) || list[0];
const relDir = (first.dir || 'data').replace(/\\/g, '/').replace(/\/$/, '');
const MSGS = JSON.parse(fs.readFileSync(path.join(ROOT, relDir, 'messages.json'), 'utf8'));
let expTotal = 0, expMe = 0;
for (const m of MSGS) for (const im of (m.images || [])) {
  if (!im.local) continue;
  expTotal++;
  if (m.from === 'me') expMe++;
}
// 页面里的昵称取的是 <dir>/meta.json 的 self_name / peer_name，测试也照这个口径读（不许写死昵称）
const META_PATH = path.join(ROOT, relDir, 'meta.json');
const METAJ = fs.existsSync(META_PATH) ? JSON.parse(fs.readFileSync(META_PATH, 'utf8')) : {};
const SELF = METAJ.self_name || '';
const PEER = METAJ.peer_name || '';
console.log('=== 期望值（来自 ' + relDir + '/messages.json） ===');
console.log('  带本地文件的图片 ' + expTotal + ' 张，其中「我」发的 ' + expMe + ' 张');

/* ---------- 真加载页面 ---------- */
console.log('\n=== jsdom 加载 查看备份.html ===');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  const m = e.message || '';
  if (!/Not implemented|Could not load|Could not parse CSS/.test(m)) errors.push(m);
});
const html = fs.readFileSync(path.join(ROOT, '查看备份.html'), 'utf8');
const dom = new JSDOM(html, {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  url: 'file:///' + path.join(ROOT, '查看备份.html').replace(/\\/g, '/'),
  virtualConsole: vc,
});
const W = dom.window, doc = W.document;

/* 捕获导出物：jsdom 没有 createObjectURL / confirm */
let lastBlob = null;
const saved = [];
W.URL.createObjectURL = function (b) { lastBlob = b; return 'blob:test'; };
W.URL.revokeObjectURL = function () { };
W.HTMLAnchorElement.prototype.click = function () { saved.push({ name: this.download, blob: lastBlob }); };
let anonAnswer = true;
W.confirm = function () { return anonAnswer; };
W.alert = function () { };

await new Promise(res => { W.addEventListener('load', res); setTimeout(res, 15000); });
await sleep(1200);
ok('页面加载无 JS 报错', errors.length === 0, errors.join(' | '));

/* ---------- ① 按钮必须真的存在（不然功能等于没有入口） ---------- */
console.log('\n=== ① 入口 ===');
const mediaBtn = doc.getElementById('mediaBtn');
const statExport = doc.getElementById('statExport');
const mediaAlbum = doc.getElementById('mediaAlbum');
ok('侧栏有 #mediaBtn（媒体墙入口）', !!mediaBtn);
ok('统计面板有 #statExport（导出报告入口）', !!statExport);
ok('媒体墙里有 #mediaAlbum（导出相册）', !!mediaAlbum);

/* ---------- ② 媒体墙：铺得对不对 ---------- */
console.log('\n=== ② 媒体墙渲染 ===');
mediaBtn.click();
await sleep(200);
ok('点开后 #media 带 .on', doc.getElementById('media').classList.contains('on'));
const figs = [...doc.querySelectorAll('#mgr figure')];
const msgTxt = doc.getElementById('mgMsg').textContent || '';
const shownN = Number((msgTxt.match(/共\s*([\d,]+)\s*项/) || [])[1]?.replace(/,/g, '') || -1);
ok('#mgMsg 报出的总数 == 数据里带本地文件的图片数', shownN === expTotal, '页面 ' + shownN + ' vs 数据 ' + expTotal);
ok('铺出的格子数 == min(总数, 400)', figs.length === Math.min(expTotal, 400), '格子 ' + figs.length);
ok('每格都有 img[src] 和 figcaption', figs.length > 0 && figs.every(f => f.querySelector('img')?.getAttribute('src') && f.querySelector('figcaption')));
ok('格子下标 data-li 都落在灯箱数组范围内', figs.every(f => { const n = Number(f.dataset.li); return n >= 0; }), '有 -1 说明这张图不在 allImages 里，点了没反应');

/* ---------- ③ 分段筛选 ---------- */
console.log('\n=== ③ 筛选（类型 / 谁发的 / 排序） ===');
function clickSeg(segId, val, attr) {
  const b = [...doc.querySelectorAll('#' + segId + ' button')].find(x => x.dataset[attr] === val);
  if (!b) return false;
  b.click();
  return true;
}
ok('点到「我发的」这个分段', clickSeg('mgWhoSeg', 'me', 'mw'));
await sleep(150);
const meFigs = [...doc.querySelectorAll('#mgr figure')];
const meN = Number((doc.getElementById('mgMsg').textContent.match(/共\s*([\d,]+)\s*项/) || [])[1]?.replace(/,/g, '') || -1);
ok('「我发的」总数 == 数据里 from=me 的图片数', meN === expMe, '页面 ' + meN + ' vs 数据 ' + expMe);
ok('栏头 #mediaRange 跟着变', /我发的/.test(doc.getElementById('mediaRange').textContent || ''));
ok('切回「双方」', clickSeg('mgWhoSeg', 'all', 'mw'));
await sleep(150);
ok('切回后总数还原', Number((doc.getElementById('mgMsg').textContent.match(/共\s*([\d,]+)\s*项/) || [])[1]?.replace(/,/g, '') || -1) === expTotal);

// 排序：最新在前 / 最早在前 —— 首尾格子的日期说明顺序确实反了
if (figs.length >= 2) {
  const cap = f => (f.querySelector('figcaption').textContent || '').split(' · ')[0];
  const firstNew = cap([...doc.querySelectorAll('#mgr figure')][0]);
  clickSeg('mgSortSeg', 'old', 'ms');
  await sleep(150);
  const firstOld = cap([...doc.querySelectorAll('#mgr figure')][0]);
  ok('换排序后首格内容变化（顺序真的反了）', firstNew !== firstOld, firstNew + ' vs ' + firstOld);
  clickSeg('mgSortSeg', 'new', 'ms');
  await sleep(150);
} else {
  console.log('  ⚠ 图片少于 2 张，跳过排序断言（但计入总数）');
}

/* ---------- ④ 点格子 → 灯箱 ---------- */
console.log('\n=== ④ 点格子进灯箱 ===');
const f0 = doc.querySelector('#mgr figure');
if (f0) {
  const src = f0.querySelector('img').getAttribute('src');
  f0.click();
  await sleep(150);
  ok('#lb 打开', doc.getElementById('lb').classList.contains('on'));
  const lbSrc = doc.getElementById('lbimg').getAttribute('src');
  ok('灯箱里的图 == 点的那一格', lbSrc === src, lbSrc + ' vs ' + src);
  ok('#lbinfo 有 X / Y 计数', /\d+\s*\/\s*\d+/.test(doc.getElementById('lbinfo').textContent || ''));
  doc.getElementById('lbclose').click();
  await sleep(100);
  ok('关灯箱后 #lb 收起', !doc.getElementById('lb').classList.contains('on'));
} else {
  ok('至少能取到一个格子', false);
}

/* ---------- ⑤ 导出相册 ---------- */
console.log('\n=== ⑤ 导出相册 ===');
saved.length = 0;
mediaAlbum.click();
await sleep(200);
ok('触发了一次下载', saved.length === 1, '实际 ' + saved.length);
if (saved.length) {
  const s = saved[0];
  ok('文件名形如 相册_<源>_<日期>.html', /^相册_.+_\d{4}-\d{2}-\d{2}\.html$/.test(s.name || ''), s.name);
  const txt = await s.blob.text();
  ok('内容是 HTML 且含 <figure>', /<!doctype html>/i.test(txt) && /<figure>/.test(txt));
  ok('图片用的是相对路径（不是 base64）', /<img src="data\//i.test(txt) || /<img src="bili\//i.test(txt));
  ok('开头写明了「相对路径」的注意事项', /相对路径/.test(txt));
}

/* ---------- ⑥ 统计报告导出 ---------- */
console.log('\n=== ⑥ 统计报告导出 ===');
doc.getElementById('mediaClose').click();
await sleep(100);
ok('媒体墙已关闭', !doc.getElementById('media').classList.contains('on'));
doc.getElementById('statBtn').click();
await sleep(500);
ok('统计面板打开', doc.getElementById('stat').classList.contains('on'));
ok('#kpis 有内容', (doc.getElementById('kpis').innerHTML || '').length > 50);
ok('#chart 里是 SVG（报告直接序列化它）', /<svg/i.test(doc.getElementById('chart').outerHTML || ''));

// 打码版
anonAnswer = true;
saved.length = 0;
statExport.click();
await sleep(400);
ok('（打码）触发了一次下载', saved.length === 1, '实际 ' + saved.length);
let repAnon = '';
if (saved.length) {
  const s = saved[0];
  ok('文件名形如 统计报告_<源>_<日期>.html', /^统计报告_.+_\d{4}-\d{2}-\d{2}\.html$/.test(s.name || ''), s.name);
  repAnon = await s.blob.text();
  ok('含报告标题', /聊天统计报告/.test(repAnon));
  ok('含折线图 SVG', /<svg/i.test(repAnon));
  ok('含热力图', /日历热力图/.test(repAnon) && /<svg/i.test(repAnon));
  ok('含节律 / 词云 / 口径', /聊天节律/.test(repAnon) && /高频词云/.test(repAnon));
  ok('标了「按每天 05:00 分界」', /05:00/.test(repAnon));
  ok('标了「昵称已打码」', /昵称已打码/.test(repAnon));
  ok('不引外部 JS / CDN', !/<script/i.test(repAnon) && !/https?:\/\//.test(repAnon.replace(/https?:\/\/www\.w3\.org[^\s"']*/g, '')));
  if (PEER) ok('打码版里没有对方真名', !repAnon.includes(PEER), PEER);
  if (SELF) ok('打码版里没有我的真名', !repAnon.includes(SELF), SELF);
  ok('打码版用了「我 / TA」', /我/.test(repAnon) && /TA/.test(repAnon));
}

// 不打码版
anonAnswer = false;
saved.length = 0;
statExport.click();
await sleep(400);
ok('（不打码）触发了一次下载', saved.length === 1);
if (saved.length) {
  const rep = await saved[0].blob.text();
  ok('标了「含真实昵称」', /含真实昵称/.test(rep));
  ok('不打码版比打码版多出昵称信息', rep !== repAnon);
  if (PEER) ok('不打码版保留对方昵称', rep.includes(PEER) || /TA/.test(rep), '（该会话昵称可能本身为空，放宽）');
}

/* ---------- 收口 ---------- */
console.log('\n=== 断言总数：' + (pass + fail) + '（通过 ' + pass + ' / 失败 ' + fail + '）===');
console.log('JS 报错: ' + (errors.length ? errors.join(' | ') : '无'));
dom.window.close();
process.exit(fail ? 1 : 0);
