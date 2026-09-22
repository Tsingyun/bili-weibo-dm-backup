/**
 * 只读探针：量一量「把一天的分界从 00:00 改成 05:00」会动到多少数据。
 * 不写任何文件。
 */
import fs from 'node:fs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const CUT = 5 * 3600 * 1000;
const p = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
const at5 = (t) => { const d = new Date(t - CUT); d.setHours(0, 0, 0, 0); return d.getTime(); };
const days = (a, b) => Math.round((b - a) / 86400000) + 1;

for (const [name, file] of [['weibo', 'data/messages.json'], ['bili', 'bili/messages.json']]) {
  let M;
  try { M = JSON.parse(fs.readFileSync(R + '/' + file, 'utf8')); } catch { console.log(name + '：读不到 ' + file); continue; }
  if (!Array.isArray(M)) M = M.messages;
  let win = 0, tmin = Infinity, tmax = -Infinity, noTs = 0;
  const byHour = new Array(24).fill(0);
  const samples = [];
  const keyOld = new Set(), keyNew = new Set();
  for (const m of M) {
    if (!m.ts) { noTs++; continue; }
    if (m.ts < tmin) tmin = m.ts;
    if (m.ts > tmax) tmax = m.ts;
    const d = new Date(m.ts), h = d.getHours();
    byHour[h]++;
    keyOld.add(ymd(d));
    keyNew.add(ymd(new Date(m.ts - CUT)));
    if (h < 5) { win++; if (samples.length < 6) samples.push(new Date(m.ts).toLocaleString('sv-SE')); }
  }
  console.log('== ' + name + ' ==  总 ' + M.length + ' 条 · 无 ts ' + noTs);
  console.log('   区间 ' + new Date(tmin).toLocaleString('sv-SE') + '  →  ' + new Date(tmax).toLocaleString('sv-SE'));
  console.log('   落在 00:00~05:00 的消息 = ' + win + ' 条（' + (win / M.length * 100).toFixed(2) + '%）');
  console.log('   出现的「日」个数：旧口径 ' + keyOld.size + ' → 新口径 ' + keyNew.size);
  console.log('   连续轴天数：旧 ' + days(at5(tmin + CUT), at5(tmax + CUT)) + ' → 新 ' + days(at5(tmin), at5(tmax)));
  console.log('   0~8 点分布 ' + byHour.slice(0, 9).map((v, i) => i + '点:' + v).join(' '));
  console.log('   0~5 点样例 ' + (samples.join(' | ') || '（无）'));
}
