/**
 * 用已运行的浏览器（CDP 9333）打开查看页，检查渲染是否正常并截图
 */
import fs from 'fs';

const PORT = 9333;
const OUT = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const PAGE = 'file:///' + OUT + '/查看备份.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdpOk() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}
if (!await cdpOk()) { console.log('[×] CDP 9333 未就绪'); process.exit(1); }

const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(PAGE)}`, { method: 'PUT' });
const tab = await r.json();
console.log('打开标签:', tab.id);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0; const pending = new Map(); const events = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else events.push(m);
};
const send = (method, params = {}) => new Promise(resolve => {
  const i = ++id; pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (res.result && res.result.exceptionDetails) return '[JS异常] ' + JSON.stringify(res.result.exceptionDetails).slice(0, 200);
  return res.result && res.result.result ? res.result.result.value : null;
};
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + '/' + name, Buffer.from(s.result.data, 'base64'));
  console.log('  截图 ->', name);
}

await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
await sleep(3000);

const errs = events.filter(e => e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
console.log('\n页面报错数:', errs.length);
errs.slice(0, 6).forEach(e => console.log('  !', JSON.stringify(e.params).slice(0, 260)));

const PROBE = `(() => {
  const q = s => document.querySelectorAll(s).length;
  const D = window.DM_DATA || {}, F = window.DM_FACES || {phrase:{},ee:{}};
  const fi = [...document.querySelectorAll('img.face')];
  return JSON.stringify({
    msgTotal: (D.messages||[]).length,
    faceMap: Object.keys(F.phrase||{}).length + '+' + Object.keys(F.ee||{}).length,
    rendered: q('.msg'),
    wcards: q('.wcard'), wcardBtn: q('.wcard-btn'), wcardLink: q('.wcard-link'),
    collapsed: q('.bubble.has-card:not(.open)'), opened: q('.bubble.has-card.open'),
    faceImgs: fi.length, faceLoaded: fi.filter(i=>i.naturalWidth>0).length,
    faceBroken: fi.filter(i=>i.complete && i.naturalWidth===0).length,
    homeIcon: q('.wcard'), searchEl: !!document.getElementById('q'),
    autoChip: document.getElementById('autoChip') && document.getElementById('autoChip').textContent,
    found: document.getElementById('found') && document.getElementById('found').textContent,
    hitnav: document.getElementById('hitnav') && document.getElementById('hitnav').className
  }, null, 1);
})()`;

console.log('\n=== 初始状态 ===');
console.log(await evaluate(PROBE));
await shot('_v1_初始.png');

// 搜索「丑猫」定位到截图里那条分享微博
await evaluate(`(()=>{const i=document.getElementById('q');i.value='丑猫';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
await sleep(1500);
console.log('\n=== 搜索「丑猫」后（卡片折叠态）===');
console.log(await evaluate(PROBE));
await evaluate(`window.scrollTo(0, 0); 1`);
await shot('_v2_卡片折叠.png');

// 展开第一张卡片
console.log('\n=== 点击「展开详情」===');
console.log(await evaluate(`(()=>{const b=document.querySelector('.wcard-btn'); if(!b) return '没找到按钮'; b.click(); return b.textContent;})()`));
await sleep(400);
console.log(await evaluate(PROBE));
await evaluate(`window.scrollTo(0, 0); 1`);
await shot('_v3_卡片展开.png');

// 测试表情渲染（搜索一个带表情的词）
console.log('\n=== 搜「礼物」看表情渲染 ===');
console.log(await evaluate(`(()=>{const i=document.getElementById('q');i.value='礼物';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`));
await sleep(1500);
console.log(await evaluate(PROBE));
await shot('_v4_表情.png');

// 测试自动回复开关
console.log('\n=== 自动回复开关 ===');
const before = await evaluate(`document.querySelectorAll('.msg').length`);
console.log(await evaluate(`(()=>{document.getElementById('autoChip').click(); return document.getElementById('autoChip').textContent;})()`));
await sleep(1200);
console.log('切换后:', await evaluate(`document.getElementById('found') && document.getElementById('found').textContent`));
console.log(await evaluate(`(()=>{document.getElementById('qclr').click(); return '清空搜索';})()`));
await sleep(1200);
console.log('清空后统计:', await evaluate(`document.getElementById('stats').textContent.slice(0,60)`));
const after = await evaluate(`(()=>{return document.getElementById('found') ? document.getElementById('found').textContent : '(无)';})()`);
console.log('found 文本:', after);
console.log('最终 probe:', await evaluate(PROBE));
await shot('_v5_隐藏自动回复.png');

// 关掉这个标签
await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`);
console.log('\n已关闭验证标签。');
ws.close();
process.exit(0);
