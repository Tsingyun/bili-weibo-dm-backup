import fs from 'fs';
import path from 'path';
const ROOT = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const M = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/messages.json'), 'utf8'));
console.log('总消息:', M.length);
console.log('meta:', JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT,'data/meta.json'),'utf8')), null, 1).slice(0,900));

// 1) 类型分布
const byType = {};
for (const m of M) byType[m.type] = (byType[m.type] || 0) + 1;
console.log('\n类型分布:', byType);

// 2) 自动回复统计
const autoTxt = (() => { try { const s = JSON.parse(fs.readFileSync(import.meta.dirname + '/../../sessions.json', 'utf8')); return ((s.sessions || []).find(x => x.key === 'weibo') || {}).autoReply || ''; } catch { return ''; } })(); // 自动回复文案取自 sessions.json（属个人内容，不写进代码）
let auto = M.filter(m => (m.text || '').trim() === autoTxt);
console.log('\n完全等于「' + autoTxt + '」:', auto.length);
// 找类似的短句高频
const cnt = {};
for (const m of M) { const t = (m.text || '').trim(); if (t && t.length <= 20) cnt[t] = (cnt[t] || 0) + 1; }
const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log('\n短句 TOP25（<=20字）:');
top.forEach(([t, c]) => console.log('  ' + String(c).padStart(5) + '  ' + t));

// 3) 卡片消息样例
const cards = M.filter(m => m.card);
console.log('\n带 card 的消息:', cards.length);
cards.slice(-8).forEach(m => console.log('  card:', JSON.stringify(m.card).slice(0, 220)));

// 4) 送礼相关
const gift = M.filter(m => /礼物|送|卡券|红包|礼包|打赏/.test(((m.card && (m.card.author + m.card.text)) || '') + ' ' + (m.text || '')));
console.log('\n疑似送礼相关:', gift.length);
gift.slice(0, 12).forEach(m => console.log('  [' + m.type + '] ' + (m.text || '').slice(0, 40) + ' | card=' + JSON.stringify(m.card||null).slice(0, 200)));

// 5) 表情 [xxx] 统计
const faces = {};
const re = /\[([^\[\]\s]{1,12})\]/g;
for (const m of M) { const t = m.text || ''; let r; re.lastIndex = 0; while ((r = re.exec(t))) faces[r[1]] = (faces[r[1]] || 0) + 1; }
const fe = Object.entries(faces).sort((a, b) => b[1] - a[1]);
console.log('\n文本表情种类:', fe.length, ' 总出现:', fe.reduce((s, x) => s + x[1], 0));
console.log(fe.map(([k, v]) => k + '(' + v + ')').join('  '));

// 6) 现有 emoji_map
const em = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/emoji_map.json'), 'utf8'));
console.log('\nemoji_map 条数:', Object.keys(em).length, JSON.stringify(em).slice(0, 400));

// 7) links 样例
const withLinks = M.filter(m => m.links && m.links.length);
console.log('\n带 links 的消息:', withLinks.length);
const lc = {}; withLinks.forEach(m => { const k = m.links.length; lc[k] = (lc[k] || 0) + 1; });
console.log('  每条链接数分布:', lc);
withLinks.slice(-5).forEach(m => console.log('  ', JSON.stringify(m.links).slice(0, 300)));
