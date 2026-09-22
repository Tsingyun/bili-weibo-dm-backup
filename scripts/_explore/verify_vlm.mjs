/**
 * 图片内容描述搜索验证（jsdom 离线真实执行页面脚本）
 * 验证 VLM（GLM-4.6V-Flash）描述索引：
 *   1. 索引被正确加载与统计
 *   2. 只存在于「图片描述」里的词，能被搜索框搜到，并走 vlmhit 分支
 *   3. 模型自加的小标题（「关键词：」等）已被清洗
 *   4. 卸载 data/vlm.js 后页面依然完全正常，且 OCR 功能不受影响
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
chk(/<script src="data\/vlm\.js"/.test(html), '页面已引入 data/vlm.js');

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

/* ---------------- 主实例 ---------------- */
const { dom, errors } = boot(html);
const W = dom.window, doc = W.document;
await new Promise(res => { W.addEventListener('load', res); setTimeout(res, 15000); });
await sleep(700);

const VLM = W.DM_VLM || {};
const keys = Object.keys(VLM).filter(k => k !== '_meta');
const withDesc = keys.filter(k => (VLM[k] || {}).d);

console.log('=== 1. 索引加载 ===');
chk(errors.length === 0, '页面无 JS 报错', errors.slice(0, 2).join(' | ') || '无');
chk(keys.length > 0, 'data/vlm.js 已载入', keys.length + ' 条索引');
chk(withDesc.length > 0, '其中含描述的图片', withDesc.length + ' 张');
console.log('  · 索引文件 ' + (fs.statSync(DIR + '/data/vlm.js').size / 1024).toFixed(0) + ' KB');

console.log('\n=== 2. 统计行 ===');
const s4 = doc.querySelector('.stats .s4');
chk(!!s4 && s4.textContent.includes(String(withDesc.length)),
  '统计里含图片描述数', s4 ? s4.textContent : '无');
chk(!!s4 && /文字\s*[\d,]+/.test(s4.textContent), '统计里同时含图内文字数',
  (s4 && (s4.textContent.match(/文字\s*[\d,]+/) || ['无'])[0]) || '无');

console.log('\n=== 3. 描述文本质量 ===');
{
  const dirty = keys.filter(k => /^\s*(关键词|概括|描述|总结|画面描述)\s*[:：]/.test((VLM[k] || {}).d || ''));
  chk(dirty.length === 0, '描述里没有「关键词：」这类小标题', dirty.length + ' 条残留');
  const avg = withDesc.reduce((s, k) => s + VLM[k].d.length, 0) / Math.max(1, withDesc.length);
  chk(avg >= 40 && avg <= 300, '描述长度合理（40~300 字）', '平均 ' + avg.toFixed(0) + ' 字');
  const emptyish = withDesc.filter(k => VLM[k].d.trim().length < 10);
  chk(emptyish.length === 0, '没有过短的无效描述', emptyish.length + ' 条');
}

console.log('\n=== 4. 搜「只在图片描述里出现」的词 ===');
const M = W.DM_DATA.messages;
const plain = M.map(m => (m.text || '') + ' ' + (m.card ? JSON.stringify(m.card) : '') +
  ' ' + JSON.stringify(m.links || [])).join(' ').toLowerCase();
const ocrAll = Object.entries(W.DM_OCR || {}).filter(([k]) => k !== '_meta')
  .map(([, v]) => (v && v.t) || '').join(' ').toLowerCase();

const cands = [];
for (const [k, v] of Object.entries(VLM)) {
  if (k === '_meta' || !v || !v.d) continue;
  for (const w of (v.d.match(/[\u4e00-\u9fa5]{3,5}/g) || [])) cands.push({ k, w });
}
// 候选词必须：既不在正文里，也不在 OCR 文本里 —— 这样命中就必然来自 VLM
const pick = cands.find(c =>
  !plain.includes(c.w.toLowerCase()) && !ocrAll.includes(c.w.toLowerCase()));
chk(!!pick, '找到只由图片描述命中的候选词',
  pick ? '「' + pick.w + '」来自 ' + pick.k : '未找到（描述词都被正文覆盖？）');

let hitN = 0, vlmHit = 0, ocrHit = 0, tipN = 0, markN = 0, tipLabel = '';
if (pick) {
  const qi = doc.getElementById('q');
  qi.value = pick.w;
  qi.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(900);
  hitN = doc.querySelectorAll('.msg').length;
  vlmHit = doc.querySelectorAll('.imgs img.vlmhit').length;
  ocrHit = doc.querySelectorAll('.imgs img.ocrhit').length;
  tipN = doc.querySelectorAll('.ocrtip').length;
  markN = doc.querySelectorAll('.ocrtip mark').length;
  const tipEl = doc.querySelector('.ocrtip');
  tipLabel = tipEl ? tipEl.textContent.slice(0, 12) : '';
  console.log('  · 搜索「' + pick.w + '」→ 命中 ' + hitN + ' 条消息');
  console.log('  · 结果说明 ' + (doc.getElementById('found').textContent || '空'));
  chk(hitN > 0, '图片描述能被搜到', hitN + ' 条');
  chk(vlmHit > 0, '命中的图片被描边标记（vlmhit）', vlmHit + ' 张');
  chk(ocrHit === 0, '该词没有误走图内文字分支', ocrHit + ' 张');
  chk(tipN > 0, 'DOM 里出现描述提示', tipN + ' 处');
  chk(/图片内容/.test(tipLabel), '提示标签为「图片内容」', tipLabel);
  chk(markN > 0, '提示里的关键词被高亮', markN + ' 处');
}

console.log('\n=== 5. 反向验证 ===');
{
  const qi = doc.getElementById('q');
  qi.value = 'zzz这个字符串绝不可能存在' + Date.now();
  qi.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(600);
  chk(doc.querySelectorAll('.msg').length === 0, '搜不存在的词命中 0 条',
    doc.querySelectorAll('.msg').length + ' 条');
  qi.value = '';
  qi.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(600);
  chk(doc.querySelectorAll('.msg').length > 100, '清空搜索后恢复全部消息',
    doc.querySelectorAll('.msg').length + ' 条');
  // 搜「关键词」不应命中一大片（清洗是否真正生效）
  qi.value = '关键词';
  qi.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(600);
  const n = doc.querySelectorAll('.msg').length;
  chk(n < withDesc.length / 2, '搜「关键词」不再全军命中（标签已清洗）',
    n + ' 条 / 共 ' + withDesc.length + ' 张有描述图');
}

console.log('\n=== 6. 覆盖一致性 ===');
{
  let bad = 0, covered = 0;
  for (const m of M) {
    const parts = [];
    for (const im of (m.images || [])) {
      if (!im.local) continue;
      const v = VLM[im.local.split('/').pop()];
      if (v && v.d) parts.push(String(v.d).replace(/\s+/g, ' ').trim());
    }
    const want = parts.join(' ');
    if (want && (m._vlm || '') === want) covered++;
    else if (want !== (m._vlm || '')) bad++;
  }
  chk(bad === 0, '每条消息的图片描述拼接正确', '覆盖 ' + covered + ' 条，异常 ' + bad + ' 条');
}

/* ---------------- 第二实例：模拟 vlm.js 缺失 ---------------- */
console.log('\n=== 7. 缺失 vlm.js 时的兼容性 ===');
{
  const stripped = html.replace(/<script src="data\/vlm\.js"[^>]*><\/script>\s*/, '');
  chk(stripped !== html, '已成功构造「无 vlm.js」的页面副本');
  const { dom: d2, errors: e2 } = boot(stripped);
  const W2 = d2.window, doc2 = W2.document;
  await new Promise(res => { W2.addEventListener('load', res); setTimeout(res, 15000); });
  await sleep(700);
  chk(e2.length === 0, '缺失 vlm.js 时页面无 JS 报错', e2.slice(0, 2).join(' | ') || '无');
  chk(doc2.querySelectorAll('.msg').length > 100, '消息照常渲染',
    doc2.querySelectorAll('.msg').length + ' 条');
  chk(!!(W2.DM_OCR && Object.keys(W2.DM_OCR).length > 2), 'OCR 索引仍正常载入（两者独立）');
  const q2 = doc2.getElementById('q');
  q2.value = '微博';
  q2.dispatchEvent(new W2.Event('input', { bubbles: true }));
  await sleep(700);
  chk(doc2.querySelectorAll('.msg').length > 0, '普通文字搜索仍可用',
    doc2.querySelectorAll('.msg').length + ' 条');
}

console.log('\n================ 汇总 ================');
console.log('通过 ' + pass.length + ' / ' + (pass.length + fail.length));
if (fail.length) { console.log('失败项：'); fail.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
