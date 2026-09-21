// 细查统计口径里需要甄别的几类消息
import fs from 'fs';
const DATA = import.meta.dirname.replace(/\\/g, '/') + '/../../data/';
const M = JSON.parse(fs.readFileSync(DATA + 'messages.json', 'utf8'));
const AUTO = (() => { try { const s = JSON.parse(fs.readFileSync(import.meta.dirname + '/../../sessions.json', 'utf8')); return ((s.sessions || []).find(x => x.key === 'weibo') || {}).autoReply || ''; } catch { return ''; } })(); // 自动回复文案取自 sessions.json（属个人内容，不写进代码）
const show = (m, tag) => console.log('   [' + (tag || '') + '|' + m.from + '/' + m.type + '/mt' + m.media_type + '] ' +
  (m.text || '').replace(/\n/g, ' ⏎ ').slice(0, 78) +
  (m.card ? '  ⟨card:' + m.card.kind + '|' + (m.card.author || '') + '|' + (m.card.text || '').slice(0, 40) + '⟩' : '') +
  (m.links && m.links.length ? '  ⟨' + m.links.map(l => l.short || l.long).join(' , ').slice(0, 60) + '⟩' : ''));

console.log('=== 1. 我发出的「自动回复同文本」是什么（' + M.filter(m => m.from === 'me' && (m.text || '').trim() === AUTO).length + ' 条） ===');
M.filter(m => m.from === 'me' && (m.text || '').trim() === AUTO).forEach(m => {
  console.log('   ' + new Date(m.ts).toLocaleString('zh-CN') + '  id=' + m.id + '  recalled=' + !!m.recalled);
});

console.log('\n=== 2. 命中「礼物」的消息 ===');
M.filter(m => ((m.text || '') + ' ' + JSON.stringify(m.card || {})).indexOf('礼物') >= 0).forEach(m => show(m, '礼物'));

console.log('\n=== 3. 命中「打赏」的消息 ===');
M.filter(m => ((m.text || '') + ' ' + JSON.stringify(m.card || {})).indexOf('打赏') >= 0).forEach(m => show(m, '打赏'));

console.log('\n=== 4. 命中「助威/赞赏/vipclub」的消息（完整） ===');
M.filter(m => /助威|赞赏|vipclub/.test((m.text || '') + ' ' + JSON.stringify(m.card || {}) + ' ' + JSON.stringify(m.links || {}))).forEach(m => {
  console.log('   ' + new Date(m.ts).toLocaleString('zh-CN') + '  id=' + m.id);
  show(m, '礼物');
});

console.log('\n=== 5. 「你撤回了一条消息」类系统提示 ===');
const recallTip = M.filter(m => /撤回了一条消息/.test(m.text || ''));
console.log('   共 ' + recallTip.length + ' 条；from 分布: ' + JSON.stringify(recallTip.reduce((a, m) => (a[m.from] = (a[m.from] || 0) + 1, a), {})));
const rType = {};
recallTip.forEach(m => { const k = m.from + '/' + m.type + '/mt' + m.media_type; rType[k] = (rType[k] || 0) + 1; });
console.log('   类型: ' + JSON.stringify(rType));
recallTip.slice(0, 4).forEach(m => console.log('   ' + new Date(m.ts).toLocaleString('zh-CN') + '  ' + (m.text || '').slice(0, 30) + '  recalled=' + !!m.recalled));

console.log('\n=== 6. 撤回消息（recalled=1）的整体分布 ===');
const rec = M.filter(m => m.recalled);
const rk = {};
rec.forEach(m => { const k = m.from + '/' + (m.text || '').trim().slice(0, 16); rk[k] = (rk[k] || 0) + 1; });
Object.entries(rk).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, c]) => console.log('   ' + String(c).padStart(4) + '  ' + k));

console.log('\n=== 7. 正文恰好是 t.cn 短链的消息（动图表情占位符） ===');
const tcn = M.filter(m => /^http:\/\/t\.cn\/\S+$/.test((m.text || '').trim()));
console.log('   共 ' + tcn.length + ' 条；类型: ' + JSON.stringify(tcn.reduce((a, m) => (a[m.from + '/' + m.type] = (a[m.from + '/' + m.type] || 0) + 1, a), {})));

console.log('\n=== 8. 一年内按天分布形态（补 0 后的密度） ===');
const days = {};
M.forEach(m => {
  if (!m.ts) return;
  const d = new Date(m.ts), p = n => String(n).padStart(2, '0');
  const k = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  if (!days[k]) days[k] = { me: 0, peer: 0 };
  const gift = /助威|赞赏|vipclub/.test((m.text || '') + JSON.stringify(m.card || {}));
  const auto = (m.text || '').trim() === AUTO;
  if (gift || auto) return;
  if (m.from === 'me') days[k].me++; else days[k].peer++;
});
const first = new Date('2024-02-01T00:00:00+08:00'), last = new Date('2026-09-14T00:00:00+08:00');
let span = 0, zero = 0, meOnly = 0, both = 0, peerOnly = 0;
for (let t = first.getTime(); t <= last.getTime(); t += 86400000) {
  span++;
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  const k = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  const v = days[k] || { me: 0, peer: 0 };
  if (!v.me && !v.peer) zero++;
  else if (v.me && v.peer) both++;
  else if (v.me) meOnly++;
  else peerOnly++;
}
console.log('   跨度 ' + span + ' 天：全空 ' + zero + ' · 仅我 ' + meOnly + ' · 双方都有 ' + both + ' · 仅对方 ' + peerOnly);
const meArr = Object.values(days).map(v => v.me).sort((a, b) => a - b);
const pArr = Object.values(days).map(v => v.peer).sort((a, b) => a - b);
const q = (a, x) => a[Math.floor(a.length * x)] || 0;
console.log('   我/天 分位: p50=' + q(meArr, .5) + ' p90=' + q(meArr, .9) + ' p99=' + q(meArr, .99) + ' max=' + meArr[meArr.length - 1]);
console.log('   对方/天 分位: p50=' + q(pArr, .5) + ' p90=' + q(pArr, .9) + ' max=' + pArr[pArr.length - 1]);
