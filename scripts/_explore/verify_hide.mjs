/**
 * 「隐藏消息」专项回归（2026-09-16）
 *
 *   A. 隐藏自动回复之后，**搜索模式（展开上下文）里不再露出 [文字] 占位气泡**
 *      —— 用户报的 bug：hideTxt 把自动回复正文挡掉后，renderBubble 的类型兜底
 *         把它渲染成一个「只剩 [文字]、看不出是什么」的气泡。
 *   B. 新增功能：右键菜单「隐藏这条消息」—— 隐藏 / 搜不到 / 上下文占位 / 三条恢复路径
 *
 * 用**真实数据**（微博 7,925 条 + B站 2,912 条）在 jsdom 里跑真页面脚本，
 * 不做任何数据仿真 —— 只有这样才能证明「真的不漏」。
 *
 * 三个坑，改这个脚本前先看：
 *   1. jsdom 在 file:// 下 localStorage 是 opaque origin，直接访问会抛 SecurityError。
 *      这里用 beforeParse 装内存垫片。**不装的话「隐藏记录落盘 / 跨数据源隔离 /
 *      重开页面仍记住」三条根本测不了** —— 而且页面里全部 localStorage 调用都包着
 *      try/catch，静默失效，测试照样全绿。这是本套件最容易骗过自己的地方。
 *   2. 触屏长按弹菜单会设 420ms 的 click 屏蔽窗（防 touchend 后补发的 click 顺手关掉菜单），
 *      所以「右键弹菜单 → 点占位条」之间要 await 过这个窗口，否则点击被吃掉、误判成 bug。
 *   3. 断言里的「期望值」一律按页面自己的口径现算（窗口范围 / msgKind），
 *      不写死数字；数字写死过一次，数据一更新就假失败。
 */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom');

const DIR = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const FILE = DIR + '/查看备份.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pass = [], fail = [];
const chk = (ok, label, extra) => {
  (ok ? pass : fail).push(label);
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  → ' + String(extra).slice(0, 160) : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

/* ---------------- 页面装载（可复用同一份 localStorage） ---------------- */
const rawHtml = fs.readFileSync(FILE, 'utf8');

function makeDom(LS = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    const m = e.message || '';
    if (!/Not implemented|Could not load/.test(m)) errors.push('jsdomError: ' + m);
  });
  vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 200)));
  const dom = new JSDOM(rawHtml, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    url: 'file:///' + FILE.replace(/\\/g, '/'),
    virtualConsole: vc,
    beforeParse(w) {
      Object.defineProperty(w, 'localStorage', {
        configurable: true,
        value: {
          getItem: k => (k in LS ? LS[k] : null),
          setItem: (k, v) => { LS[k] = String(v); },
          removeItem: k => { delete LS[k]; },
          clear: () => { for (const k of Object.keys(LS)) delete LS[k]; },
        },
      });
    },
  });
  return { dom, W: dom.window, doc: dom.window.document, errors, LS };
}
async function ready(env) {
  await new Promise(res => {
    env.W.addEventListener('load', res);
    setTimeout(res, 10000);
  });
  await sleep(700);
}

const LS = {};
const env = makeDom(LS);
const W = env.W, doc = env.doc;
await ready(env);

const $$ = s => [...doc.querySelectorAll(s)];
const $ = s => doc.querySelector(s);
const setQ = async (v, ms = 420) => {
  const el = doc.getElementById('q');
  el.value = v;
  el.dispatchEvent(new W.Event('input'));
  await sleep(ms);
};
const rightClick = el => el.dispatchEvent(new W.MouseEvent('contextmenu',
  { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
const menuEl = () => $('.cmenu');
const menuOpen = () => { const m = menuEl(); return !!m && !m.hidden; };
const menuBtn = act => $(`.cmenu button[data-act="${act}"]`);
const menuText = () => $$('.cmenu button').map(b => b.textContent.trim());
/* [文字] 之类的类型兜底占位：只扫气泡/占位条本身，别把正文里的方括号也算进来 */
const typePlaceholders = () => $$('#chat .msg .body > div').filter(d => /^\[[^\]]+\]$/.test(d.textContent.trim()));
const renderedRows = () => $$('#chat .msg[data-ai]').map(r => ({
  ai: +r.dataset.ai,
  txt: ((r.querySelector('.bubble, .hidb') || {}).textContent || ''),
  hid: !!r.querySelector('.hidb'),
}));
const openCtx = ai => {
  const row = $(`#chat .msg[data-ai="${ai}"]`);
  const b = row && row.querySelector('[data-ctx="open"]');
  if (b) { b.click(); return true; }
  return false;
};
const ctxRange = (ai, len) => {
  const up = Math.min(3, ai), dn = Math.min(3, len - 1 - ai);
  return [ai - up, ai + dn];
};

/* 找一段「唯一关键词」：全库只出现在这一条里。
   只用纯中文/全角字符（避开 ASCII 大小写与正则转义的干扰）。 */
function uniqueWord(M, m, min = 6, max = 14) {
  const t = (m.text || '').replace(/\s+/g, '');
  for (let len = min; len <= Math.min(max, t.length); len++) {
    for (let s = 0; s + len <= t.length; s++) {
      const cand = t.slice(s, s + len);
      if (/[\x00-\x7F]/.test(cand)) continue;
      let n = 0;
      for (const x of M) { if ((x.text || '').indexOf(cand) >= 0) { n++; if (n > 1) break; } }
      if (n === 1) return cand;
    }
  }
  return null;
}

console.log('=== 0. 基础 ===');
chk(env.errors.length === 0, '页面无 JS 报错', env.errors.slice(0, 3).join(' | ') || '无');
chk(!!W.DM_DATA && (W.DM_DATA.messages || []).length > 7000, '微博数据已载入', (W.DM_DATA ? W.DM_DATA.messages.length : 0) + ' 条');
chk(!!W.DM_DATA_B && (W.DM_DATA_B.messages || []).length > 2000, 'B站数据已载入', (W.DM_DATA_B ? W.DM_DATA_B.messages.length : 0) + ' 条');
chk(!!$('#hidChip'), '侧栏「已隐藏」按钮存在');
chk($('#hidChip').hidden, '初始（没有隐藏项）时该按钮是隐藏的');
chk(!!$('.cmenu'), '右键菜单节点已挂上');

/* ==========================================================================
   A. 隐藏自动回复 → 搜索模式的上下文里不该再露出 [文字]
   ========================================================================== */
const A = W.DM_DATA.messages;
const AUTO_W = (W.SOURCES && W.SOURCES.weibo && W.SOURCES.weibo.autoReply) || ''; // 从页面配置取（sessions.js → autoReply），不写死
const isAutoW = m => (m.text || '').trim() === AUTO_W;

section('A1. 微博：开着「隐藏自动回复」时，上下文不再出现 [文字]');
doc.getElementById('autoChip').click();          // 打开隐藏
await sleep(400);
chk(/已隐藏/.test(doc.getElementById('autoChip').textContent), '「隐藏自动回复」已开启',
  doc.getElementById('autoChip').textContent);

/* 选样本：尾部一条普通消息，它前 3 条里得有自动回复（否则测的是空气） */
let pair = null;
for (let i = A.length - 4; i > A.length - 200 && i > 8; i--) {
  if (isAutoW(A[i]) || !A[i].text || A[i].text.trim().length < 10) continue;
  const hasAuto = [1, 2, 3].some(k => isAutoW(A[i - k]));
  if (!hasAuto) continue;
  const w = uniqueWord(A, A[i]);
  if (!w) continue;
  await setQ(w);
  if ($(`#chat .msg[data-ai="${i}"]`) && /命中 1 条/.test(doc.getElementById('found').textContent)) {
    pair = { ai: i, w };
    break;
  }
}
chk(!!pair, '找到可用样本（命中项 + 前 3 条内有自动回复 + 关键词全库唯一）',
  pair ? `ai=${pair.ai} 词=${pair.w}` : '没找到');
await setQ(pair.w);
chk(!!$(`#chat .msg[data-ai="${pair.ai}"]`), '搜索命中目标消息');
chk(openCtx(pair.ai), '「↕ 展开上下文」按钮可用');
await sleep(200);

const [cFrom, cTo] = ctxRange(pair.ai, A.length);
let autoInRange = 0;
for (let k = cFrom; k <= cTo; k++) if (k !== pair.ai && isAutoW(A[k])) autoInRange++;
chk(autoInRange > 0, '样本窗口里确实有自动回复（保证这条测试不是空跑）', 'auto=' + autoInRange);

const rowsA = renderedRows();
chk(rowsA.length === (cTo - cFrom + 1) - autoInRange,
  '上下文里自动回复被跳过（渲染条数 = 窗口条数 − 自动回复数）',
  `渲染 ${rowsA.length} / 期望 ${(cTo - cFrom + 1) - autoInRange}`);
chk(rowsA.filter(r => isAutoW(A[r.ai])).length === 0, '渲染出来的行里没有一条是自动回复',
  rowsA.filter(r => isAutoW(A[r.ai])).map(r => r.ai).join(',') || '无');
chk(typePlaceholders().length === 0, '★ 不再出现 [文字] 占位气泡（本次修复的核心）',
  typePlaceholders().map(d => d.textContent).join(' | '));
chk($('#chat').innerHTML.indexOf(AUTO_W) === -1, '上下文里搜不到自动回复原文');
chk(rowsA.length > 1, '上下文确实展开了（不止命中那一条）', rowsA.length + ' 行');

section('A2. 对照组：关掉开关，自动回复应当回到上下文里');
doc.getElementById('autoChip').click();
await sleep(400);
chk(!/已隐藏/.test(doc.getElementById('autoChip').textContent), '开关已关闭');
await setQ(pair.w);
openCtx(pair.ai);
await sleep(200);
const rowsA2 = renderedRows();
chk(rowsA2.length === cTo - cFrom + 1, '关掉后，上下文恢复成完整窗口',
  `渲染 ${rowsA2.length} / 期望 ${cTo - cFrom + 1}`);
chk(rowsA2.filter(r => isAutoW(A[r.ai])).length === autoInRange, '自动回复重新出现在上下文里',
  rowsA2.filter(r => isAutoW(A[r.ai])).length + ' / ' + autoInRange);
chk($('#chat').innerHTML.indexOf(AUTO_W) >= 0, '自动回复原文可见');
/* 关掉开关后 [文字] 也不该冒出来：正文在，就不是空气泡 */
chk(typePlaceholders().length === 0, '（开关关闭时同样没有 [文字] 占位）');

section('A3. B站：autoReply 是空串，判定只能靠 msg_source —— 老代码这条路径整条失效');
/* ⚠ 这份口径与页面 msgKind() 的 bili 分支是**同一份逻辑的两处实现**，改一边必须同步另一边 */
const isAutoB = m => {
  const s = m.msg_source | 0;
  return (s >= 8 && s <= 11) || s === 17 || m.media_type === 16;
};
doc.querySelector('#srcSw button[data-src="bili"]').click();
await sleep(800);
const B = (W.DM_DATA_B || {}).messages || [];
chk(B.length > 2000, '已切到 B站且数据在', B.length + ' 条');
chk(!!$('#srcSw button[data-src="bili"][aria-pressed="true"]'), '切换条已标成 B站选中');

doc.getElementById('autoChip').click();
await sleep(400);
chk(/已隐藏/.test(doc.getElementById('autoChip').textContent), 'B站：开启「隐藏自动回复」');

let pairB = null;
for (let i = B.length - 4; i > B.length - 200 && i > 8; i--) {
  if (isAutoB(B[i]) || !B[i].text || B[i].text.trim().length < 10) continue;
  if (![1, 2, 3].some(k => isAutoB(B[i - k]))) continue;
  const w = uniqueWord(B, B[i]);
  if (!w) continue;
  await setQ(w);
  if ($(`#chat .msg[data-ai="${i}"]`) && /命中 1 条/.test(doc.getElementById('found').textContent)) {
    pairB = { ai: i, w };
    break;
  }
}
chk(!!pairB, 'B站找到可用样本', pairB ? `ai=${pairB.ai} 词=${pairB.w}` : '没找到');
await setQ(pairB.w);
chk(openCtx(pairB.ai), 'B站：展开上下文');
await sleep(200);
const [bFrom, bTo] = ctxRange(pairB.ai, B.length);
let autoBInRange = 0;
for (let k = bFrom; k <= bTo; k++) if (k !== pairB.ai && isAutoB(B[k])) autoBInRange++;
chk(autoBInRange > 0, 'B站样本窗口里确实有自动回复', 'auto=' + autoBInRange);
const rowsB = renderedRows();
chk(rowsB.length === (bTo - bFrom + 1) - autoBInRange, 'B站：上下文里自动回复被跳过',
  `渲染 ${rowsB.length} / 期望 ${(bTo - bFrom + 1) - autoBInRange}`);
chk(rowsB.filter(r => isAutoB(B[r.ai])).length === 0, '★ B站：一条自动回复正文都没有漏出来');
chk(typePlaceholders().length === 0, 'B站：没有 [文字] 占位');
chk(B.filter(isAutoB).length > 100, '（B站自动回复基数够大，样本有意义）', B.filter(isAutoB).length + ' 条');

/* ==========================================================================
   B. 右键菜单「隐藏这条消息」
   ========================================================================== */
section('B1. 右键菜单');
doc.querySelector('#srcSw button[data-src="weibo"]').click();
await sleep(800);
doc.getElementById('autoChip').click();              // 关掉自动回复开关，避免干扰
await sleep(400);
doc.getElementById('qclr').click();
await sleep(300);
chk(!!A[0] && A.length === W.DM_DATA.messages.length, '回到微博视图');

/* 选一条「关键词唯一、非自动回复」的消息作为隐藏目标 */
let tgt = null;
for (let i = A.length - 4; i > A.length - 200 && i > 8; i--) {
  const m = A[i];
  if (isAutoW(m) || !m.id || !m.text || m.text.trim().length < 10) continue;
  const w = uniqueWord(A, m);
  if (!w) continue;
  await setQ(w);
  const row = $(`#chat .msg[data-ai="${i}"]`);
  if (row && /命中 1 条/.test(doc.getElementById('found').textContent)) { tgt = { ai: i, w, id: String(m.id) }; break; }
}
chk(!!tgt, '找到隐藏目标', tgt ? `ai=${tgt.ai} id=${tgt.id}` : '没找到');
await setQ(tgt.w);

const rowT = $(`#chat .msg[data-ai="${tgt.ai}"]`);
chk(!!rowT && !!rowT.querySelector('.bubble'), '隐藏前：目标消息在搜索结果里，正文可见');
chk($('#chat').innerHTML.indexOf(tgt.w) >= 0, '隐藏前：正文里搜得到那个关键词');

rightClick(rowT.querySelector('.bubble'));
chk(menuOpen(), '★ 右键消息 → 弹出菜单');
chk(menuText().some(t => /隐藏这条消息/.test(t)), '★ 菜单里有「隐藏这条消息」', menuText().join(' / '));
chk(menuText().some(t => /复制文本/.test(t)), '菜单里还有「复制文本」');

menuBtn('hide').click();
await sleep(200);
chk(!menuOpen(), '点完菜单自动收起');
chk(!$(`#chat .msg[data-ai="${tgt.ai}"]`), '★ 隐藏后：搜索结果里不再出现这条消息');
chk(/命中 0 条/.test(doc.getElementById('found').textContent), '命中数归零',
  doc.getElementById('found').textContent);
chk($('#chat').innerHTML.indexOf(tgt.w) === -1, '★ 隐藏后：那个关键词连一个字都不在 DOM 里');
const chip = doc.getElementById('hidChip');
chk(!chip.hidden && /已隐藏 1 条/.test(chip.textContent), '侧栏出现「🙈 已隐藏 1 条」', chip.textContent);
chk((LS['dm-hidden-weibo'] || '') .indexOf(tgt.id) >= 0, '隐藏记录写进了 localStorage',
  LS['dm-hidden-weibo']);

section('B2. 隐藏后：上下文里以占位条出现，且不泄漏原文');
/* 换一条邻居来当锚点（隐藏项自己已经不在列表里了） */
let nb = null;
for (let k = 1; k <= 3; k++) {
  const cand = A[tgt.ai - k];
  if (!cand || !cand.text || cand.text.trim().length < 8) continue;
  const w = uniqueWord(A, cand);
  if (!w) continue;
  await setQ(w);
  if ($(`#chat .msg[data-ai="${tgt.ai - k}"]`)) { nb = { ai: tgt.ai - k, w }; break; }
}
chk(!!nb, '找到相邻的锚点消息', nb ? `ai=${nb.ai}` : '没找到');
await setQ(nb.w);
chk(openCtx(nb.ai), '展开锚点的上下文');
await sleep(200);
const ph = $(`#chat .msg[data-ai="${tgt.ai}"] .hidb`);
chk(!!ph, '★ 隐藏项在上下文里以虚线占位条出现');
chk(/已隐藏/.test(ph.textContent), '占位条文案说明「已隐藏」', ph.textContent.trim());
chk(ph.textContent.indexOf(A[tgt.ai].text.slice(0, 4)) === -1, '占位条不泄漏原文',
  ph.textContent.trim());
chk(!!ph.querySelector('.hbtn'), '占位条上带「恢复」按钮');
chk($('#chat').innerHTML.indexOf(tgt.w) === -1, '★ 整块上下文里都搜不到被隐藏消息的正文');
chk(!!$(`#chat .msg[data-ai="${tgt.ai}"]`), '（占位条本身仍占一个位置，看得出这里原本有内容）');

section('B3. 恢复路径①：点占位条');
await sleep(500);                    // 越过 420ms 的 click 屏蔽窗
ph.click();
await sleep(250);
chk(doc.getElementById('hidChip').hidden, '点占位条 → 隐藏记录清空、按钮消失', chip.textContent);
await setQ(tgt.w);
chk(!!$(`#chat .msg[data-ai="${tgt.ai}"]`), '★ 恢复后：重新能搜到这条消息');
chk($('#chat').innerHTML.indexOf(tgt.w) >= 0, '恢复后：正文重新可见');

section('B4. 恢复路径②：右键占位条 → 「恢复这条消息」');
await setQ(tgt.w);
rightClick($(`#chat .msg[data-ai="${tgt.ai}"]`).querySelector('.bubble'));
menuBtn('hide').click();
await sleep(200);
chk(/已隐藏 1 条/.test(doc.getElementById('hidChip').textContent), '再次隐藏成功',
  doc.getElementById('hidChip').textContent);
await setQ(nb.w);
openCtx(nb.ai);
await sleep(200);
const ph2 = $(`#chat .msg[data-ai="${tgt.ai}"] .hidb`);
chk(!!ph2, '占位条又在');
rightClick(ph2);
await sleep(60);
chk(/恢复这条消息/.test(menuBtn('hide').textContent), '★ 对占位条右键 → 菜单变成「恢复这条消息」',
  menuBtn('hide').textContent.trim());
menuBtn('hide').click();
await sleep(250);
chk(doc.getElementById('hidChip').hidden, '从菜单恢复成功');

section('B5. 恢复路径③：侧栏「已隐藏 N 条」连点两次');
/* 藏两条 */
const hidIds = [];
for (let k = 0; k < 2; k++) {
  let done = false;
  for (let i = A.length - 4 - k * 40; i > A.length - 300 && i > 8 && !done; i--) {
    if (isAutoW(A[i]) || !A[i].id || hidIds.includes(String(A[i].id))) continue;
    const w = uniqueWord(A, A[i]);
    if (!w) continue;
    await setQ(w);
    const r = $(`#chat .msg[data-ai="${i}"]`);
    if (!r) continue;
    rightClick(r.querySelector('.bubble'));
    const hb = menuBtn('hide');
    if (!hb || !/隐藏这条消息/.test(hb.textContent)) continue;
    hb.click();
    await sleep(150);
    hidIds.push(String(A[i].id));
    done = true;
  }
}
chk(hidIds.length === 2, '藏好两条', hidIds.join(','));
chk(/已隐藏 2 条/.test(doc.getElementById('hidChip').textContent), '侧栏显示「已隐藏 2 条」',
  doc.getElementById('hidChip').textContent);
doc.getElementById('hidChip').click();
await sleep(80);
chk(/再点一次/.test(doc.getElementById('hidChip').textContent), '第一次点击只是「上膛」，不直接恢复',
  doc.getElementById('hidChip').textContent);
chk(!doc.getElementById('hidChip').hidden, '上膛后记录仍在（没有误删）');
doc.getElementById('hidChip').click();
await sleep(250);
chk(doc.getElementById('hidChip').hidden, '★ 连点两次 → 全部恢复');
chk(JSON.parse(LS['dm-hidden-weibo'] || '[]').length === 0, '落盘记录也清空',
  LS['dm-hidden-weibo']);

section('B6. 「清空全部条件」不碰单独隐藏的消息（设计如此）');
await setQ(tgt.w);
rightClick($(`#chat .msg[data-ai="${tgt.ai}"]`).querySelector('.bubble'));
menuBtn('hide').click();
await sleep(200);
doc.getElementById('autoChip').click();              // 顺手打开自动回复开关
await sleep(300);
$('#advReset').click();
await sleep(300);
chk(/已隐藏 1 条/.test(doc.getElementById('hidChip').textContent),
  '★ 清空筛选条件后，单独隐藏的记录仍在（它属于内容处置，不是筛选条件）',
  doc.getElementById('hidChip').textContent);

section('B7. 跨数据源隔离 + 重开页面仍然记得');
chk(!!LS['dm-hidden-weibo'], '微博的隐藏记录落在 dm-hidden-weibo');
doc.querySelector('#srcSw button[data-src="bili"]').click();
await sleep(800);
chk(doc.getElementById('hidChip').hidden, '★ 切到 B站：看不到微博的隐藏记录（不串源）',
  doc.getElementById('hidChip').textContent);
chk(!LS['dm-hidden-bili'], 'B站没有自己的隐藏记录');
doc.querySelector('#srcSw button[data-src="weibo"]').click();
await sleep(800);
chk(/已隐藏 1 条/.test(doc.getElementById('hidChip').textContent), '切回微博：记录还在',
  doc.getElementById('hidChip').textContent);

/* 用同一份 localStorage 再开一次页面 —— 这才是「重开还记得」的真凭据 */
const env2 = makeDom(LS);
await ready(env2);
chk(/已隐藏 1 条/.test(env2.doc.getElementById('hidChip').textContent),
  '★ 重新打开页面：隐藏记录仍在（localStorage 生效）',
  env2.doc.getElementById('hidChip').textContent);
chk(env2.errors.length === 0, '第二个实例无 JS 报错', env2.errors.slice(0, 2).join(' | ') || '无');
env2.W.close();

/* 收尾：把本套件写进去的记录清掉，保证下次跑还是从干净状态开始 */
delete LS['dm-hidden-weibo'];
delete LS['dm-hidden-bili'];
delete LS['dm-hide-auto-weibo'];
delete LS['dm-hide-auto-bili'];

console.log('\n' + '='.repeat(56));
console.log(`隐藏消息专项：通过 ${pass.length} · 失败 ${fail.length} · 合计 ${pass.length + fail.length}`);
if (fail.length) console.log('失败项：\n  · ' + fail.join('\n  · '));
console.log('='.repeat(56));
process.exit(fail.length ? 1 : 0);
