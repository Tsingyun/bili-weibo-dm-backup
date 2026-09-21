/**
 * 图片文字搜索验证（jsdom 离线真实执行页面脚本）
 * 验证：
 *   1. OCR 索引被正确加载与统计
 *   2. 只存在于图片里的词，能被搜索框搜到
 *   3. 命中后 DOM 里确实出现图内文字提示与高亮
 *   4. 卸载 data/ocr.js 后页面依然完全正常（这是「可卸载」承诺的验证）
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

function boot(h) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented|Could not load/.test(e.message)) errors.push(e.message); });
  vc.on('error', (...a) => errors.push(a.map(String).join(' ').slice(0, 200)));
  const dom = new JSDOM(h, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    url: 'file:///' + FILE.replace(/\\/g, '/'), virtualConsole: vc,
  });
  return { dom, errors };
}

/* ---------------- 主实例：带 OCR 索引 ---------------- */
const { dom, errors } = boot(html);
const W = dom.window, doc = W.document;
const t0 = Date.now();
await new Promise(res => { W.addEventListener('load', res); setTimeout(res, 15000); });
await sleep(600);
const loadMs = Date.now() - t0;

const OCR = W.DM_OCR || {};
const keys = Object.keys(OCR).filter(k => k !== '_meta');
const withText = keys.filter(k => (OCR[k] || {}).t);

console.log('=== 1. 索引加载 ===');
chk(errors.length === 0, '页面无 JS 报错', errors.slice(0, 2).join(' | ') || '无');
chk(keys.length > 0, 'data/ocr.js 已载入', keys.length + ' 条索引');
chk(withText.length > 0, '其中含文字的图片', withText.length + ' 张');
console.log('  · 页面加载耗时 ' + loadMs + ' ms');
console.log('  · 索引文件 ' + (fs.statSync(DIR + '/data/ocr.js').size / 1024).toFixed(0) + ' KB');

console.log('\n=== 2. 统计行 ===');
const statsTxt = doc.getElementById('stats').textContent;
chk(/图片可搜索/.test(statsTxt), '侧栏出现「图片可搜索」统计',
  (statsTxt.match(/图片可搜索\s*[\d,]+\s*张（[^）]*）/) || ['无'])[0]);
const s4 = doc.querySelector('.stats .s4');
chk(!!s4 && s4.textContent.includes(String(withText.length)),
  '统计里含图内文字索引数', s4 ? s4.textContent : '无');

console.log('\n=== 3. 搜「只在图片里出现」的词 ===');
// 收集所有非图片文本，用来排除「本来就能搜到」的词
const M = W.DM_DATA.messages;
const plain = M.map(m => (m.text || '') + ' ' +
  (m.card ? JSON.stringify(m.card) : '') + ' ' + JSON.stringify(m.links || [])).join(' ').toLowerCase();

const cands = [];
for (const [k, v] of Object.entries(OCR)) {
  if (k === '_meta' || !v || !v.t) continue;
  for (const w of (v.t.match(/[\u4e00-\u9fa5]{3,6}/g) || [])) cands.push({ k, w });
}
const pick = cands.find(c => !plain.includes(c.w.toLowerCase()));
chk(!!pick, '找到只在图片里出现的候选词',
  pick ? '「' + pick.w + '」来自 ' + pick.k : '未找到（数据异常）');

let hitN = 0, tipN = 0, markN = 0, imgHit = 0;
if (pick) {
  const qi = doc.getElementById('q');
  qi.value = pick.w;
  qi.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(900);
  hitN = doc.querySelectorAll('.msg').length;
  tipN = doc.querySelectorAll('.ocrtip').length;
  imgHit = doc.querySelectorAll('.imgs img.ocrhit').length;
  markN = doc.querySelectorAll('.ocrtip mark').length;
  console.log('  · 搜索「' + pick.w + '」→ 命中 ' + hitN + ' 条消息');
  console.log('  · 结果说明 ' + (doc.getElementById('found').textContent || '空'));
  chk(hitN > 0, '图片里的文字能被搜到', hitN + ' 条');
  chk(tipN > 0, 'DOM 里出现「图内文字」提示', tipN + ' 处');
  chk(imgHit > 0, '命中的图片被描边标记', imgHit + ' 张');
  chk(markN > 0, '提示里的关键词被高亮', markN + ' 处');
}

console.log('\n=== 4. 反向验证 ===');
{
  const qi = doc.getElementById('q');
  qi.value = 'zzz这个字符串绝不可能存在' + Date.now();
  qi.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(600);
  const n = doc.querySelectorAll('.msg').length;
  chk(n === 0, '搜不存在的词命中 0 条', n + ' 条');
  qi.value = '';
  qi.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(600);
  chk(doc.querySelectorAll('.msg').length > 100, '清空搜索后恢复全部消息',
    doc.querySelectorAll('.msg').length + ' 条');
}

console.log('\n=== 5. 索引覆盖一致性 ===');
{
  // 每条带图消息的 _ocr，应当等于其图片 OCR 文本的拼接
  let bad = 0, covered = 0;
  for (const m of M) {
    const parts = [];
    for (const im of (m.images || [])) {
      if (!im.local) continue;
      const o = OCR[im.local.split('/').pop()];
      if (o && o.t) parts.push(String(o.t).replace(/\s+/g, ' ').trim());
    }
    const want = parts.join(' ');
    if (want && (m._ocr || '') === want) covered++;
    else if (want !== (m._ocr || '')) bad++;
  }
  chk(bad === 0, '每条消息的图内文字拼接正确', '覆盖 ' + covered + ' 条，异常 ' + bad + ' 条');
}

/* ---------------- 第二实例：模拟已卸载（没有 ocr.js） ---------------- */
console.log('\n=== 6. 卸载 ocr.js 后的兼容性 ===');
{
  const stripped = html.replace(/<script src="data\/ocr\.js"[^>]*><\/script>\s*/, '');
  chk(stripped !== html, '已成功构造「无 ocr.js」的页面副本');
  const { dom: d2, errors: e2 } = boot(stripped);
  const W2 = d2.window, doc2 = W2.document;
  await new Promise(res => { W2.addEventListener('load', res); setTimeout(res, 15000); });
  await sleep(600);
  chk(e2.length === 0, '卸载后页面无 JS 报错', e2.slice(0, 2).join(' | ') || '无');
  chk(doc2.querySelectorAll('.msg').length > 100, '卸载后消息照常渲染',
    doc2.querySelectorAll('.msg').length + ' 条');
  const st2 = doc2.getElementById('stats').textContent;
  chk(!/已索引图片文字/.test(st2), '卸载后不再显示图片文字统计行');
  chk(!!doc2.getElementById('q'), '卸载后搜索框仍在');
  // 卸载后文字搜索还应正常工作
  const q2 = doc2.getElementById('q');
  q2.value = '微博';
  q2.dispatchEvent(new W2.Event('input', { bubbles: true }));
  await sleep(700);
  chk(doc2.querySelectorAll('.msg').length > 0, '卸载后普通文字搜索仍可用',
    doc2.querySelectorAll('.msg').length + ' 条');
}

console.log('\n================ 汇总 ================');
console.log('通过 ' + pass.length + ' / ' + (pass.length + fail.length));
if (fail.length) { console.log('失败项：'); fail.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
