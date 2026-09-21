/**
 * 验证「按天互动统计」：
 *  1) 独立重算一遍统计口径（不调用页面函数），与页面 KPI 数字比对
 *  2) 交互：打开面板 / 切换范围 / 均线 / 独立量程 / 点图跳转
 */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom');

const DIR = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const FILE = DIR + '/查看备份.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (ok, label, extra) => {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  → ' + extra : ''));
};

const html = fs.readFileSync(FILE, 'utf8');
const errors = [];
const vc = new VirtualConsole();
// 可选数据集（bili/、data/ocr.js 等）缺失时 jsdom 会报 "Could not load"，
// 这是设计内行为（页面要能在缺文件时照常用），不算 JS 报错。
vc.on('jsdomError', e => { const m = e.message || ''; if (!/Not implemented|Could not load/.test(m)) errors.push('jsdomError: ' + m); });
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 200)));

const dom = new JSDOM(html, {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  url: 'file:///' + FILE.replace(/\\/g, '/'), virtualConsole: vc,
});
const W = dom.window, doc = W.document;
await new Promise(res => { W.addEventListener('load', res); setTimeout(res, 10000); });
await sleep(900);

/* ============ 独立重算（照抄口径规则，但不碰页面代码） ============ */
const M = W.DM_DATA.messages;
/* 对方显示名一律从数据 meta 取 —— 页面已改成运行时读 peer_name，
   测试里再写死昵称就会和实现脱钩（改个昵称测试就红，是假红）。 */
const PEER = (W.DM_DATA.meta && W.DM_DATA.meta.peer_name) || '对方';
const AUTO = (W.SOURCES && W.SOURCES.weibo && W.SOURCES.weibo.autoReply) || ''; // 从页面配置取（sessions.js → autoReply），不写死
const RE_GIFT = /^感谢您的助威支持|助威权益还有\d+天|^发出红包消息/;
const RE_SYS = /^(?:你|对方)撤回了一条消息$/;
/* ⚠ 换日口径（2026-09-18 起）：一天 = 当天 05:00 → 次日 05:00，
   所以这里必须先减 5 小时再取年月日 —— 这是**同一份口径的第二处实现**，
   页面改了这里不改，测试就会拿旧口径去比新数字（本项目真有这个前科）。 */
const CUT5 = 5 * 3600 * 1000;
const dk = t => {
  const d = new Date(t - CUT5);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const dStart = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 5, 0, 0, 0).getTime(); };

const exp = { me: 0, peer: 0, auto: 0, gift: 0, sys: 0, autoMe: 0, autoPeer: 0 };
const dayMap = {};
let tmin = Infinity, tmax = -Infinity, pre5All = 0;
for (const m of M) {
  if (!m.ts) continue;
  if (m.ts < tmin) tmin = m.ts;
  if (m.ts > tmax) tmax = m.ts;
  if (new Date(m.ts).getHours() < 5) pre5All++;      // 口径：全部消息，不预先剔除
  const t = (m.text || '').trim();
  if (t === AUTO) { exp.auto++; m.from === 'me' ? exp.autoMe++ : exp.autoPeer++; continue; }
  if (RE_GIFT.test(t)) { exp.gift++; continue; }
  if (RE_SYS.test(t)) { exp.sys++; continue; }
  if (m.from !== 'me' && m.from !== 'peer') continue;
  const k = dk(m.ts);
  dayMap[k] = dayMap[k] || { me: 0, peer: 0 };
  dayMap[k][m.from]++;
  exp[m.from]++;
}
/* 连续日轴：按**逻辑日**逐日 +1（起点/终点都由 dk() 定位，不要拿 tmin 直接 setHours(0,0,0,0)） */
let span = 0, both = 0, zero = 0;
for (let c = dStart(dk(tmin)); c <= dStart(dk(tmax)); c += 86400000) {
  span++;
  const v = dayMap[dk(c)] || { me: 0, peer: 0 };
  if (v.me && v.peer) both++;
  if (!v.me && !v.peer) zero++;
}
const spanNatural = (() => {                            // 旧口径天数，用来证明「确实换了」
  const a = new Date(tmin); a.setHours(0, 0, 0, 0);
  const b = new Date(tmax); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000) + 1;
})();

console.log('=== 0. 基础 ===');
chk(errors.length === 0, '页面无 JS 报错', errors.slice(0, 3).join(' | ') || '无');

console.log('\n=== 1. 面板默认状态与打开 ===');
const statEl = doc.getElementById('stat');
chk(!statEl.classList.contains('on'), '面板默认隐藏');
doc.getElementById('statBtn').click();
await sleep(120);
chk(statEl.classList.contains('on'), '点「📊 互动统计」后面板打开');

console.log('\n=== 2. KPI 数字 vs 独立重算 ===');
const kpiTxt = doc.getElementById('kpis').textContent.replace(/\s+/g, ' ');
const num = n => n.toLocaleString();
chk(kpiTxt.includes(num(exp.me)), '「我发出」总数一致', '重算=' + num(exp.me));
chk(kpiTxt.includes(num(exp.peer)), '「对方回复」总数一致', '重算=' + num(exp.peer));
chk(kpiTxt.includes(num(both) + '/'), '「有来有回」天数一致', '重算=' + both + ' / ' + span + ' 天');
chk(doc.getElementById('statRange').textContent.includes(String(span)), '区间天数一致', '重算=' + span + ' 天');

console.log('\n=== 2b. 换日口径：每天 05:00（不是自然日 0 点）===');
const rangeTxt = doc.getElementById('statRange').textContent.replace(/\s+/g, ' ');
chk(/05:00 分界/.test(rangeTxt), '区间行标注「按每天 05:00 分界」', rangeTxt.slice(0, 72));
chk(String(span) !== String(spanNatural), '★ 新口径天数 ≠ 自然日口径天数（改动确实生效，断言有区分度）',
  `05:00 口径 ${span} 天 vs 自然日 ${spanNatural} 天`);
const calTxt = doc.getElementById('caliber').textContent.replace(/\s+/g, ' ');
chk(/每天 05:00/.test(calTxt), '口径框写明「按每天 05:00 分界」');
chk(/00:00~05:00 的消息算前一天/.test(calTxt), '口径框写明「00:00~05:00 算前一天」');
chk(!/按自然日划分/.test(calTxt), '口径框不再残留「按自然日划分」这句旧话术');
chk(new RegExp('的消息有 ' + pre5All.toLocaleString() + ' 条').test(calTxt),
  '口径框报出的凌晨消息条数 = 独立重算（口径：全部消息）', pre5All.toLocaleString() + ' 条');
const pct5 = (pre5All / M.length * 100).toFixed(1);
chk(calTxt.includes('占全部 ' + pct5 + '%'), '口径框报出的占比 = 独立重算', '占全部 ' + pct5 + '%');
const hintTxt = doc.getElementById('chartHint').textContent.replace(/\s+/g, ' ');
chk(/05:00 分界/.test(hintTxt), '趋势图提示行写明 05:00 分界', hintTxt.slice(0, 66));

console.log('\n=== 3. 排除项口径 ===');
const cal = doc.getElementById('caliber').textContent.replace(/\s+/g, ' ');
const L = n => n.toLocaleString();
chk(cal.includes(L(exp.auto)), '自动回复排除数 = ' + L(exp.auto));
chk(cal.includes(PEER + ' ' + exp.autoPeer + ' · 我 ' + exp.autoMe), '自动回复拆分正确（' + PEER + ' ' + exp.autoPeer + ' / 我 ' + exp.autoMe + '）');
chk(cal.includes('送礼物 / 助威系统通知：' + L(exp.gift)), '送礼物排除数 = ' + L(exp.gift));
chk(cal.includes('撤回了一条消息」：' + L(exp.sys)), '撤回提示排除数 = ' + L(exp.sys) + '（含「对方撤回」1 条）');
// 关键反例：日常提到「礼物」的 11 条必须计入，不能被排除
const giftWord = M.filter(m => /礼物/.test((m.text || '') + JSON.stringify(m.card || {}))).length;
const giftExcluded = M.filter(m => RE_GIFT.test((m.text || '').trim())).length;
console.log('  · 数据中「礼物」两字命中 ' + giftWord + ' 条，其中被排除的只有 ' + giftExcluded + ' 条（其余都是真实对话，已计入）');
chk(exp.gift === giftExcluded && giftExcluded < giftWord, '「礼物」二字未被误排除');

console.log('\n=== 4. 图表输出 ===');
const svg = doc.getElementById('chart');
chk(!!svg.getAttribute('viewBox'), 'SVG 已设置 viewBox', svg.getAttribute('viewBox'));
const P = svg.querySelectorAll('path');
const pStyle = i => P[i].getAttribute('style') || '';
chk(P.length >= 6, '折线 path 数量充足（面积×2 + 原始×2 + 均线×2）', P.length + ' 条');
chk(svg.querySelectorAll('text').length >= 10, '坐标轴刻度已绘制', svg.querySelectorAll('text').length + ' 个文本');
chk(/c-me/.test(pStyle(2)), '「我」的线用 c-me 色');
chk(/c-peer/.test(pStyle(3)), '「对方」的线用 c-peer 色');
chk(!!svg.querySelector('rect[style*="pointer-events:all"]'), '有透明命中层（图表空白处也能悬停）');
const badAttr = Array.from(svg.querySelectorAll('*')).filter(el =>
  ['fill', 'stroke', 'stop-color'].some(a => /var\(/.test(el.getAttribute(a) || '')));
chk(badAttr.length === 0, '颜色没写进 presentation attribute（Chrome 不解析 var()）',
  badAttr.length ? badAttr.length + ' 处残留' : '无残留');

console.log('\n=== 5. 交互：范围 / 均线 / 独立量程 ===');
const kpiAll = doc.getElementById('kpis').textContent;
doc.querySelector('#rangeSeg button[data-r="30"]').click();
await sleep(80);
const kpi30 = doc.getElementById('kpis').textContent;
chk(kpi30 !== kpiAll, '切到「近 30 天」后 KPI 变化');
chk(doc.getElementById('statRange').textContent.includes('共 30 天'), '区间标注为 30 天');
doc.querySelector('#rangeSeg button[data-r="0"]').click();
await sleep(80);
chk(doc.getElementById('kpis').textContent === kpiAll, '切回「全部」恢复');

const pathCount1 = svg.querySelectorAll('path').length;
const sw = () => (/stroke-width:([\d.]+)/.exec(svg.querySelectorAll('path')[2].getAttribute('style') || '') || [, ''])[1];
const avgTog = doc.getElementById('avgTog');
chk(avgTog.getAttribute('aria-pressed') === 'true', '7 日均线默认开启');
avgTog.click(); await sleep(60);
const pOff = sw();
avgTog.click(); await sleep(60);
const pOn = sw();
chk(pOff === '1.6' && pOn === '1', '均线开关改变原始线粗细（关=' + pOff + ' 开=' + pOn + '）');
chk(avgTog.getAttribute('aria-pressed') === 'true', '开关状态回写正确');

const dualTog = doc.getElementById('dualTog');
chk(dualTog.getAttribute('aria-pressed') === 'true', '「独立量程」默认开启（否则对方线贴底看不见）');
const txtOn = svg.querySelectorAll('text').length;
dualTog.click(); await sleep(80);
const txtOff = svg.querySelectorAll('text').length;
chk(txtOff < txtOn, '关掉后移除右轴刻度', txtOn + ' → ' + txtOff);
chk(/同轴对比/.test(doc.getElementById('chartHint').textContent), '提示条切换为「同轴对比」说明',
  doc.getElementById('chartHint').textContent.replace(/\s+/g, ' ').slice(0, 52));
dualTog.click(); await sleep(80);
chk(svg.querySelectorAll('text').length === txtOn, '再开启恢复右轴刻度');

console.log('\n=== 5b. 轴标题不与日期刻度重叠 ===');
const texts = Array.from(svg.querySelectorAll('text'));
const atY = y => texts.filter(t => Math.round(parseFloat(t.getAttribute('y'))) === y);
chk(atY(13).length >= 2, '顶部两角各有一个轴标题', atY(13).map(t => t.textContent).join(' | '));
chk(atY(311).length >= 2, '底部有日期刻度', atY(311).length + ' 个');
chk(!atY(311).some(t => /条/.test(t.textContent)), '「条/天」标签已从底部移走（不再压住日期）');
chk(atY(13).some(t => /我（条/.test(t.textContent)) && atY(13).some(t => t.textContent.includes(PEER + '（条')),
  '双轴分别标注「我 / ' + PEER + '」');

console.log('\n=== 6. 点图跳到那天 ===');
const chart = doc.getElementById('chart');
const ev = (type, x) => {
  const e = new W.MouseEvent(type, { bubbles: true, clientX: x, clientY: 100 });
  chart.dispatchEvent(e);
};
ev('mousemove', 500); await sleep(60);
const tip = doc.getElementById('tip');
chk(tip.classList.contains('on'), '悬停出现浮层');
chk(/我发出/.test(tip.textContent) && tip.textContent.includes(PEER + '回复'), '浮层含两条数据', tip.textContent.replace(/\s+/g, ' ').slice(0, 60));
chk(doc.getElementById('hovline').getAttribute('opacity') === '1', '竖向指示线显示');
ev('click', 500); await sleep(200);
chk(!statEl.classList.contains('on'), '点击后统计面板自动关闭（跳转到聊天）');

console.log('\n=== 7. 关闭方式 ===');
doc.getElementById('statBtn').click(); await sleep(100);
chk(statEl.classList.contains('on'), '再次打开成功');
doc.getElementById('statClose').click(); await sleep(80);
chk(!statEl.classList.contains('on'), '「关闭」按钮有效');
doc.getElementById('statBtn').click(); await sleep(100);
doc.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(80);
chk(!statEl.classList.contains('on'), 'Esc 可关闭');

console.log('\n========================================');
console.log('通过 ' + pass + ' / ' + (pass + fail) + (fail ? '　❌ 失败 ' + fail : '　✅ 全部通过'));
if (errors.length) console.log('页面报错：\n' + errors.slice(0, 5).join('\n'));
process.exit(fail ? 1 : 0);
