/**
 * 「展开上下文」功能验证（jsdom 离线真实执行页面脚本，靠点击 DOM 驱动）
 * 覆盖：
 *   A. 触发方式：只有搜索后、命中消息下方才出现「↕ 展开上下文」
 *   B. 首次展开条数：前后各 3 条，且确实是完整会话里的相邻 6 条
 *   C. 上下文来源：包含被搜索条件筛掉的消息（证明取自完整会话）
 *   D. 高亮：展开的那条被标 .hit，落在别人上下文里的另一条命中标 .hitsoft
 *   E. 加载更多：更早 / 更晚 各自 +5 条
 *   F. 边界：会话首/尾显示「这已经是…」且不出加载按钮
 *   G. 收起：上下文消失、DOM 复原
 *   H. 换搜索词自动重置；上下文不计入命中数；同一条消息不重复渲染
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
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  → ' + extra : ''));
};

const html = fs.readFileSync(FILE, 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Not implemented|Could not load/.test(e.message)) errors.push(e.message); });
vc.on('error', (...a) => errors.push(a.map(String).join(' ').slice(0, 200)));
const dom = new JSDOM(html, {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  url: 'file:///' + FILE.replace(/\\/g, '/'), virtualConsole: vc,
});
const W = dom.window, doc = W.document;
await new Promise(res => { W.addEventListener('load', res); setTimeout(res, 15000); });
await sleep(600);

const M = W.DM_DATA.messages;
const N = M.length;
console.log('会话总条数 ' + N.toLocaleString());
chk(errors.length === 0, 'A0. 页面加载无 JS 报错', errors.slice(0, 2).join(' | ') || '无');

const chat = doc.getElementById('chat');
const qEl = doc.getElementById('q');
const $$ = s => Array.from(chat.querySelectorAll(s));
const ais = s => $$(s).map(e => +e.dataset.ai);
const txt = e => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');

async function search(term) {
  qEl.value = term;
  qEl.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(400);
}
const openBtns = () => $$('[data-ctx="open"]');
const moreBtns = () => $$('[data-ctx="more1"]');
const closeBtns = () => $$('[data-ctx="close"]');

/* ================= A. 触发方式 ================= */
console.log('\n=== A. 触发方式：只有搜索后才出现 ===');
chk(openBtns().length === 0, 'A1. 未搜索时（全部消息）不出现「展开上下文」按钮',
  openBtns().length + ' 个');
chk(doc.getElementById('ctxhint').style.display === 'none' ||
    doc.getElementById('ctxhint').style.display === '',
  'A2. 未搜索时不显示侧栏提示');

// 挑一个命中数适中、且不在会话首尾的词
const cnt = new Map();
for (const m of M) {
  const w = (m.text || '').match(/[一-龥]{2,4}/g) || [];
  for (const x of new Set(w)) cnt.set(x, (cnt.get(x) || 0) + 1);
}
let term = null;
for (const [w, c] of [...cnt.entries()].sort((a, b) => a[1] - b[1])) {
  if (c >= 3 && c <= 40) { term = w; break; }
}
chk(!!term, 'A3. 找到命中数适中的测试词', term ? '「' + term + '」' : '无');

await search(term);
const hitCnt = $$('[data-ctx="open"]').length;
chk(hitCnt > 0, 'A4. 搜索后每条命中消息下方都出现按钮', hitCnt + ' 个按钮（命中 ' + hitCnt + ' 条）');
chk(doc.getElementById('ctxhint').style.display === 'block', 'A5. 侧栏提示同时出现');
const foundTxt = txt(doc.getElementById('found'));
console.log('  · 侧栏提示：' + txt(doc.getElementById('ctxhint')));
console.log('  · 结果栏：' + foundTxt);
const btn0 = openBtns()[0];
chk(/展开上下文/.test(txt(btn0)) && /前后各 3 条/.test(txt(btn0)),
  'A6. 按钮文案说明首次条数', txt(btn0));

/* ================= B/C/D. 首次展开 ================= */
console.log('\n=== B/C/D. 首次展开：前后各 3 条 + 高亮 ===');
const allHitAis = ais('[data-ctx="open"]');
// 选一个前后都有余量的命中
const pickAi = allHitAis.find(a => a >= 8 && a <= N - 9);
chk(pickAi != null, 'B0. 选中一个前后都有余量的命中', '会话下标 ' + pickAi);
const btn = openBtns().find(e => +e.dataset.ai === pickAi);
btn.click();
await sleep(120);

const ctxAis = ais('.msg.ctx');
chk(ctxAis.length === 6, 'B1. 首次展开出现前后各 3 条上下文', ctxAis.length + ' 条');
const want = [pickAi - 3, pickAi - 2, pickAi - 1, pickAi + 1, pickAi + 2, pickAi + 3];
chk(JSON.stringify(ctxAis) === JSON.stringify(want),
  'B2. 上下文正是该消息在完整会话里的相邻 6 条',
  ctxAis.join(',') + ' vs 期望 ' + want.join(','));

const hitEls = $$('.msg.hit');
chk(hitEls.length === 1 && +hitEls[0].dataset.ai === pickAi,
  'D1. 展开的那条被高亮（.hit）且唯一点亮它', 'data-ai=' + (hitEls[0] || {}).dataset?.ai);
chk(/命中/.test(txt(hitEls[0])), 'D2. 高亮条带「命中」角标', txt(hitEls[0]).slice(0, 60));
chk($$('.hitbadge').length === 1, 'D3. 页面上只有一个「命中」角标', $$('.hitbadge').length + ' 个');

// 上下文里应包含「本来没被搜到」的消息
const inResults = new Set();
for (const e of $$('.msg')) if (!e.classList.contains('ctx')) inResults.add(+e.dataset.ai);
const ctxNotHit = ctxAis.filter(a => !allHitAis.includes(a));
chk(ctxNotHit.length > 0,
  'C1. 上下文里包含被搜索筛掉的消息（证明取自完整会话，不是搜索结果）',
  ctxNotHit.length + '/6 条不在结果集里');

// 顺序：上下文夹着命中，且严格按会话顺序
const allAi = ais('.msg');
const sortedAsc = allAi.every((v, i) => i === 0 || allAi[i - 1] < v);
chk(sortedAsc, 'B3. 渲染顺序严格按会话时间递增（上下文已正确插入）',
  allAi.slice(0, 3).join(',') + ' … ' + allAi.slice(-3).join(','));
chk(allAi[allAi.indexOf(pickAi) - 1] === pickAi - 1 &&
    allAi[allAi.indexOf(pickAi) + 1] === pickAi + 1,
  'B4. 命中条正好夹在前后上下文中间');
chk(allAi.length === allAi.filter((v, i, a) => a.indexOf(v) === i).length,
  'I1. 同一条消息没有被重复渲染（去重生效）');

// 上下文两端有控制条
const bars = $$('.ctxmore');
chk(bars.length === 2, 'E0. 上下文上下两端各有一条控制条', bars.length + ' 条');
const upBar = bars[0], downBar = bars[bars.length - 1];   // DOM 顺序 = 会话顺序
chk(/加载更早的上下文/.test(txt(upBar)) && /\+5/.test(txt(upBar)),
  'E1. 顶部控制条 = 「加载更早的上下文 +5 条」', txt(upBar));
chk(/加载更晚的上下文/.test(txt(downBar)) && /\+5/.test(txt(downBar)),
  'E2. 底部控制条 = 「加载更晚的上下文 +5 条」', txt(downBar));
chk(txt(closeBtns()[0]) === '收起', 'G0. 命中消息下方出现「收起」', txt(closeBtns()[0]));
console.log('  · 命中条下方文案：' + txt(hitEls[0].parentElement));

/* ================= E. 加载更多 ================= */
console.log('\n=== E. 加载更多：单侧 +5 条 ===');
const upBtn = $$('[data-ctx="more1"][data-dir="up"]')[0];
upBtn.click();
await sleep(120);
chk(ais('.msg.ctx').length === 11, 'E3. 点「加载更早」后上下文变 11 条', ais('.msg.ctx').length + ' 条');
chk(ais('.msg.ctx')[0] === pickAi - 8, 'E4. 更早侧确实扩到 8 条', '首条下标 ' + ais('.msg.ctx')[0]);
const downBtn2 = $$('[data-ctx="more1"][data-dir="down"]')[0];
downBtn2.click();
await sleep(120);
chk(ais('.msg.ctx').length === 16, 'E5. 再点「加载更晚」后变 16 条（两侧独立）', ais('.msg.ctx').length + ' 条');
chk(ais('.msg.ctx')[15] === pickAi + 8, 'E6. 更晚侧扩到 8 条', '末条下标 ' + ais('.msg.ctx')[15]);
// 命中下方的快捷按钮
const quickUp = moreBtns().find(e => e.dataset.dir === 'up' && +e.dataset.owners === pickAi);
chk(!!quickUp && /更早/.test(txt(quickUp)), 'E7. 命中条下方也有「↑ 更早 +5」快捷按钮', txt(quickUp));
quickUp.click();
await sleep(120);
chk(ais('.msg.ctx')[0] === pickAi - 13, 'E8. 快捷按钮同样生效（更早扩到 13 条）',
  '首条下标 ' + ais('.msg.ctx')[0]);

/* ================= G. 收起 ================= */
console.log('\n=== G. 收起 ===');
closeBtns()[0].click();
await sleep(120);
chk($$('.msg.ctx').length === 0, 'G1. 收起后上下文全部消失', $$('.msg.ctx').length + ' 条');
chk($$('.msg.hit').length === 0, 'G2. 高亮同步消失');
chk($$('.ctxmore').length === 0, 'G3. 上下端控制条一并消失');
chk(openBtns().length === hitCnt, 'G4. 恢复成「↕ 展开上下文」按钮', openBtns().length + ' 个');

/* ================= H. 命中数不受影响 ================= */
console.log('\n=== H. 上下文不计入命中数 ===');
const btnA = openBtns().find(e => +e.dataset.ai === pickAi);
btnA.click();
await sleep(120);
chk(txt(doc.getElementById('found')) === foundTxt,
  'H1. 展开上下文后命中条数不变（上下文只是「看」，不参与统计）',
  txt(doc.getElementById('found')));

/* ================= F. 会话首尾边界 ================= */
console.log('\n=== F. 会话首 / 尾的显示方式 ===');
const openByAi = a => openBtns().find(e => +e.dataset.ai === a);

// —— 会话开头 ——
let iHead = M.findIndex((m, i) => i < 8 && (m.text || '').trim().length >= 4);
chk(iHead >= 0, 'F0-0. 找到会话最开头的文本消息', '会话下标 ' + iHead);
await search(M[iHead].text.trim().slice(0, 3));
if (!openByAi(iHead)) { doc.getElementById('toTop').click(); await sleep(250); }
const headBtn = openByAi(iHead);
chk(!!headBtn, 'F0-1. 定位到最早那条命中的按钮', headBtn ? '会话下标 ' + headBtn.dataset.ai : '无');
if (headBtn) {
  headBtn.click();
  await sleep(120);
  const upT = $$('.ctxmore')[0];
  chk(/这已经是你们最早的对话/.test(txt(upT)) && !upT.querySelector('button'),
    'F1. 会话开头：显示「↑ 这已经是你们最早的对话」，不给加载按钮', txt(upT));
  chk(!/\+\d+/.test(txt(closeBtns()[0])), 'F1-2. 更早侧到底时命中条下方也不出「↑ 更早」快捷按钮',
    txt(upT).slice(0, 40) + ' | ' + txt(closeBtns()[0]));
  chk(ais('.msg.ctx')[0] === 0 || iHead === 0, 'F2. 更早侧最多只到第 0 条',
    '上下文首条下标 ' + ais('.msg.ctx')[0] + '，更早已加载 ' +
    ((txt(closeBtns()[0]).match(/更早 (\d+) 条/) || [])[1] || '?') + ' 条');
}

// —— 会话末尾 ——
let iTail = -1;
for (let i = N - 1; i >= N - 8; i--) if ((M[i].text || '').trim().length >= 4) { iTail = i; break; }
chk(iTail >= 0, 'F0-2. 找到会话最末尾的文本消息', '会话下标 ' + iTail);
await search(M[iTail].text.trim().slice(0, 3));
const tailBtn = openByAi(iTail);
chk(!!tailBtn, 'F0-3. 定位到最后那条命中的按钮', tailBtn ? '会话下标 ' + tailBtn.dataset.ai : '无');
if (tailBtn) {
  tailBtn.click();
  await sleep(120);
  for (let g = 0; g < 300; g++) {
    const b = $$('[data-ctx="more1"][data-dir="down"]')[0];
    if (!b) break;
    b.click(); await sleep(20);
  }
  const dnT = $$('.ctxmore')[$$('.ctxmore').length - 1];
  chk(/这已经是最后一条消息/.test(txt(dnT)) && !dnT.querySelector('button'),
    'F3. 会话末尾：显示「↓ 这已经是最后一条消息」，不给加载按钮', txt(dnT));
  chk(ais('.msg.ctx').pop() === N - 1 || iTail === N - 1, 'F4. 更晚侧最多只到第 ' + (N - 1) + ' 条',
    '上下文末条下标 ' + ais('.msg.ctx').pop());
}

/* ================= I2. 两条命中上下文重叠 ================= */
console.log('\n=== I2. 两条命中的上下文窗口重叠 ===');
await search(M[iHead].text.trim().slice(0, 3));
if (!openByAi(iHead)) { doc.getElementById('toTop').click(); await sleep(250); }
const pair = openBtns().slice(0, 2).map(e => +e.dataset.ai);
chk(pair.length === 2, 'I2-0. 取到相邻很近的两条命中', pair.join(' 和 '));
openByAi(pair[0]).click(); await sleep(150);
openByAi(pair[1]).click(); await sleep(150);
const marks = $$('.ctxmore').filter(b => /这已经是你们最早的对话/.test(txt(b)));
chk(marks.length <= 1, 'I2-1. 重叠时「最早的对话」标记不会叠出两条', marks.length + ' 条');
const aiAll = ais('.msg');
chk(aiAll.length === new Set(aiAll).size, 'I2-2. 重叠展开后仍无重复消息',
  aiAll.length + ' 条渲染 / ' + new Set(aiAll).size + ' 条唯一');
chk(aiAll.every((v, i) => i === 0 || aiAll[i - 1] < v), 'I2-3. 重叠后顺序依然严格递增');
const ctxAis2 = ais('.msg.ctx');
chk(ctxAis2.length > 6, 'I2-4. 两条一起展开，上下文合并去重后仍多于单条的 6 条',
  ctxAis2.length + ' 条');
// 点一下合并后的「加载更早」，两条都应同时扩展
const upPair = $$('[data-ctx="more1"][data-dir="up"]')[0];
if (upPair) {
  const before = ctxAis2.length;
  upPair.click(); await sleep(150);
  chk(ais('.msg.ctx').length > before, 'I2-5. 合并后的「加载更早」一次点击对两条都生效',
    before + ' → ' + ais('.msg.ctx').length + ' 条');
}
closeBtns()[0].click(); await sleep(120);

/* ================= H2. 换搜索词重置 ================= */
console.log('\n=== H2. 换搜索词 / 换筛选自动重置 ===');
await search(term);
const b2 = openBtns().find(e => +e.dataset.ai === pickAi);
if (b2) { b2.click(); await sleep(120); }
chk($$('.msg.ctx').length > 0, 'H2-0. 再次展开成功');
const other = [...cnt.entries()].find(([w, c]) => w !== term && c >= 2 && c <= 30);
await search(other[0]);
chk($$('.msg.ctx').length === 0, 'H2-1. 换搜索词后上下文自动清空（不会张冠李戴）',
  $$('.msg.ctx').length + ' 条');
await search('');
chk($$('.msg.ctx').length === 0 && openBtns().length === 0,
  'H2-2. 清空搜索词后按钮与上下文都不见');

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(56));
console.log('通过 ' + pass.length + ' / ' + (pass.length + fail.length));
if (fail.length) { console.log('失败项：'); fail.forEach(f => console.log('  ✗ ' + f)); process.exitCode = 1; }
else console.log('全部通过 🎉');
