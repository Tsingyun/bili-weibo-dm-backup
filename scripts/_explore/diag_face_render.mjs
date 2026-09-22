/**
 * 诊断：微博中文表情 [微笑] 到底有没有渲染成图片？
 * ------------------------------------------------------------------
 * 疑点：data/faces.js 的 phrase 键全部带方括号（"[微笑]"），
 *       而页面 faceImg() 收到的是去掉括号的 token（"微笑"）。
 * 做法：① 静态统计字典键格式  ② 用 jsdom 真实渲染，数 img.face
 */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom');

const DIR = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- ① 静态：字典键格式 + 命中率 ---------- */
const MSGS = JSON.parse(fs.readFileSync(DIR + '/data/messages.json', 'utf8'));
const FACES = JSON.parse(
  fs.readFileSync(DIR + '/data/faces.js', 'utf8').replace(/^window\.DM_FACES\s*=\s*/, '').trim().replace(/;$/, ''));
const keys = Object.keys(FACES.phrase || {});
const withBr = keys.filter(k => /^\[.*\]$/.test(k));
const noBr = keys.filter(k => !/^\[/.test(k));
console.log('=== ① 表情字典键格式 ===');
console.log('  phrase 键总数 ' + keys.length + '：带方括号 ' + withBr.length + ' / 不带方括号 ' + noBr.length);
console.log('  ee 键总数 ' + Object.keys(FACES.ee || {}).length + '（形如 ee808d，无括号）');

let totMsg = 0, hitBr = 0, hitNoBr = 0, totToken = 0, tokBr = 0, tokNoBr = 0;
let pick = null;
for (let i = 0; i < MSGS.length; i++) {
  const t = MSGS[i].text;
  if (!t) continue;
  const g = t.match(/\[[^\[\]\s]{1,20}\]/g);
  if (!g) continue;
  totMsg++;
  const b = g.filter(x => FACES.phrase[x]).length;                        // 带括号查
  const n = g.filter(x => FACES.phrase[x.replace(/^\[|\]$/g, '')]).length; // 不带括号查
  totToken += g.length; tokBr += b; tokNoBr += n;
  if (b) hitBr++;
  if (n) hitNoBr++;
  if (!pick && b) pick = { ai: i, text: t, tokens: g.slice(0, 3) };
}
console.log('  含 [xxx] 记号的消息 ' + totMsg + ' 条 / 记号 ' + totToken + ' 个');
console.log('    · 用「带括号」键查：命中消息 ' + hitBr + ' 条，命中记号 ' + tokBr + '/' + totToken);
console.log('    · 用「不带括号」键查：命中消息 ' + hitNoBr + ' 条，命中记号 ' + tokNoBr + '/' + totToken);
console.log('  取样一条：ai=' + (pick ? pick.ai : '-') + '  ' + JSON.stringify(pick ? pick.text.slice(0, 70) : ''));
console.log('    其中记号 ' + JSON.stringify(pick ? pick.tokens : []) + '  → 带括号键存在？ ' +
  JSON.stringify(pick ? pick.tokens.map(x => !!FACES.phrase[x]) : []));

/* ---------- ② 动态：真实渲染 ---------- */
console.log('\n=== ② jsdom 真实渲染 ===');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { const m = e.message || ''; if (!/Not implemented|Could not load/.test(m)) errors.push(m); });
const dom = new JSDOM(fs.readFileSync(DIR + '/查看备份.html', 'utf8'), {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  url: 'file:///' + DIR + '/查看备份.html', virtualConsole: vc,
});
const W = dom.window, doc = W.document;
await new Promise(res => { W.addEventListener('load', res); setTimeout(res, 10000); });
await sleep(900);

console.log('  JS 报错: ' + (errors.length ? errors.join(' | ') : '无'));
const els = [...doc.querySelectorAll('.msg')];
console.log('  首屏 .msg 元素 ' + els.length + ' 个，其中带 data-ai 的 ' +
  els.filter(e => e.dataset.ai !== undefined).length + ' 个');
console.log('  首屏 img.face 共 ' + doc.querySelectorAll('img.face').length + ' 个');
const srcs = [...doc.querySelectorAll('img.face')].map(i => i.getAttribute('src'));
console.log('  img.face src: ' + JSON.stringify(srcs.slice(0, 6)));

let checked = 0, expectFace = 0, gotFace = 0;
const samples = [];
for (const el of els) {
  const ai = Number(el.dataset.ai);
  if (!Number.isFinite(ai) || !MSGS[ai]) continue;
  const t = MSGS[ai].text || '';
  const g = (t.match(/\[[^\[\]\s]{1,20}\]/g) || []).filter(x => FACES.phrase[x]);
  if (!g.length) continue;
  checked++;
  expectFace += g.length;
  const got = el.querySelectorAll('img.face').length;
  gotFace += got;
  if (samples.length < 3) samples.push({ ai, tokens: g.slice(0, 3), domFaces: got, html: el.innerHTML.replace(/\s+/g, ' ').slice(0, 170) });
}
console.log('\n  首屏含「字典里有的表情记号」的消息: ' + checked + ' 条');
console.log('    期望渲染表情图 ' + expectFace + ' 个 → 实际渲染 ' + gotFace + ' 个');
for (const s of samples) {
  console.log('    · ai=' + s.ai + ' 记号' + JSON.stringify(s.tokens) + ' DOM里img.face=' + s.domFaces);
  console.log('      ' + s.html);
}

const rawLeft = [...doc.querySelectorAll('.bubble')].filter(b => /\[[^\[\]\s]{1,20}\]/.test(b.textContent)).length;
console.log('\n  仍以原文 [xxx] 形式显示的气泡: ' + rawLeft + ' 个');
console.log('\n结论: ' + (gotFace > 0 && gotFace >= expectFace
  ? '✅ 中文表情已正常渲染成图片'
  : '❌ 中文表情未渲染（expected ' + expectFace + ', got ' + gotFace + '）'));

if (W && dom) dom.window.close();
process.exit(0);
