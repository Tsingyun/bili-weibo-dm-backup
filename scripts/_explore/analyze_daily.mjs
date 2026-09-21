// 分析「按天互动统计」的统计口径：礼物 / 自动回复 / 分享内容
import fs from 'fs';
const DATA = import.meta.dirname.replace(/\\/g, '/') + '/../../data/';
const M = JSON.parse(fs.readFileSync(DATA + 'messages.json', 'utf8'));

console.log('总条数:', M.length);
console.log('字段样例:', JSON.stringify(M[M.length - 1], null, 1).slice(0, 900));

// ---- 1. from 分布 ----
const byFrom = {};
M.forEach(m => byFrom[m.from] = (byFrom[m.from] || 0) + 1);
console.log('\n[from 分布]', JSON.stringify(byFrom));

// ---- 2. 已撤回 ----
console.log('[撤回数]', M.filter(m => m.recalled).length);

// ---- 3. 「是的」自动回复候选 ----
const AUTO = (() => { try { const s = JSON.parse(fs.readFileSync(import.meta.dirname + '/../../sessions.json', 'utf8')); return ((s.sessions || []).find(x => x.key === 'weibo') || {}).autoReply || ''; } catch { return ''; } })(); // 自动回复文案取自 sessions.json（属个人内容，不写进代码）
const auto = M.filter(m => (m.text || '').trim() === AUTO);
console.log('\n[精确自动回复]', auto.length);
const autoByFrom = {};
auto.forEach(m => autoByFrom[m.from] = (autoByFrom[m.from] || 0) + 1);
console.log('  按发送方:', JSON.stringify(autoByFrom));

// 找相似模板：出现次数很高的短文本
const freq = {};
M.forEach(m => {
  const t = (m.text || '').trim();
  if (t && t.length <= 40) freq[t] = (freq[t] || 0) + 1;
});
console.log('  高频短文本 Top 12:');
Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([t, c]) => console.log('    ' + String(c).padStart(5) + '  ' + t.replace(/\n/g, ' ⏎ ')));

// ---- 4. 礼物 / 赞赏类 ----
const giftWords = ['助威', '赞赏', '礼物', '打赏', '权益', 'vipclub', '送礼'];
console.log('\n[礼物类候选]');
giftWords.forEach(w => {
  const hit = M.filter(m => {
    const s = (m.text || '') + ' ' + JSON.stringify(m.card || {}) + ' ' + JSON.stringify(m.links || []);
    return s.indexOf(w) >= 0;
  });
  if (hit.length) console.log('  「' + w + '」命中 ' + hit.length);
});
const gift = M.filter(m => {
  const s = (m.text || '') + ' ' + JSON.stringify(m.card || {}) + ' ' + JSON.stringify(m.links || []) + ' ' + JSON.stringify(m.raw || {});
  return /助威|赞赏|vipclub/.test(s);
});
console.log('  样例:');
gift.slice(0, 6).forEach(m => {
  console.log('    [' + m.from + '/' + m.type + '/mt' + m.media_type + '] ' +
    (m.text || '').replace(/\n/g, ' ').slice(0, 60) +
    (m.card ? '  card=' + m.card.kind : '') +
    (m.links && m.links.length ? '  links=' + m.links.length : ''));
});

// ---- 5. 卡片类型分布 ----
const cardKinds = {};
M.forEach(m => { if (m.card) cardKinds[m.card.kind || '?'] = (cardKinds[m.card.kind || '?'] || 0) + 1; });
console.log('\n[卡片 kind 分布]', JSON.stringify(cardKinds));

// ---- 6. 类型分布（当前） ----
const types = {};
M.forEach(m => types[m.type] = (types[m.type] || 0) + 1);
console.log('[type 分布]', JSON.stringify(types));

// ---- 7. 时间范围与本地时区 ----
const ts = M.map(m => m.ts).filter(Boolean).sort((a, b) => a - b);
console.log('\n[时间范围]', new Date(ts[0]).toLocaleString('zh-CN'), '→', new Date(ts[ts.length - 1]).toLocaleString('zh-CN'));

// ---- 8. 试算按天统计（本地时区自然日） ----
function dayKey(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
const GIFT_RE = /助威|赞赏|vipclub/;
function isGift(m) {
  const s = (m.text || '') + ' ' + JSON.stringify(m.card || {}) + ' ' + JSON.stringify(m.links || []);
  return GIFT_RE.test(s);
}
function isAuto(m) { return (m.text || '').trim() === AUTO; }

const days = {};
M.forEach(m => {
  if (!m.ts) return;
  const k = dayKey(m.ts);
  if (!days[k]) days[k] = { me: 0, peer: 0, meAll: 0, peerAll: 0, gift: 0, auto: 0 };
  const d = days[k];
  if (isGift(m)) { d.gift++; return; }
  if (isAuto(m)) { d.auto++; return; }
  if (m.from === 'me') { d.me++; d.meAll++; }
  else if (m.from === 'peer') { d.peer++; d.peerAll++; }
});
const keys = Object.keys(days).sort();
console.log('\n[按天统计] 有效天数:', keys.length, ' 首日:', keys[0], ' 末日:', keys[keys.length - 1]);
const tot = keys.reduce((a, k) => {
  a.me += days[k].me; a.peer += days[k].peer; a.gift += days[k].gift; a.auto += days[k].auto; return a;
}, { me: 0, peer: 0, gift: 0, auto: 0 });
console.log('  计入: 我', tot.me, ' 对方', tot.peer, ' | 排除: 礼物', tot.gift, ' 自动回复', tot.auto);
console.log('  合计核对:', tot.me + tot.peer + tot.gift + tot.auto, '(应等于有时间戳的条数)');

// 最近 14 天趋势
console.log('\n[最近 14 天]');
keys.slice(-14).forEach(k => console.log('  ' + k + '  我=' + String(days[k].me).padStart(3) + '  对方=' + String(days[k].peer).padStart(3) + '  礼物=' + days[k].gift + '  自动=' + days[k].auto));

// 极值
const maxMe = keys.reduce((a, k) => days[k].me > days[a].me ? k : a, keys[0]);
const maxPeer = keys.reduce((a, k) => days[k].peer > days[a].peer ? k : a, keys[0]);
console.log('\n最活跃: 我 ' + maxMe + '(' + days[maxMe].me + ')  对方 ' + maxPeer + '(' + days[maxPeer].peer + ')');
console.log('日均: 我 ' + (tot.me / keys.length).toFixed(1) + '  对方 ' + (tot.peer / keys.length).toFixed(1));
