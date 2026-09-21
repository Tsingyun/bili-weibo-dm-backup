import fs from 'fs';
const ROOT = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const M = JSON.parse(fs.readFileSync(ROOT + '/data/messages.json', 'utf8'));

console.log('=== 一条消息的完整字段（样例）===');
console.log(JSON.stringify(M[M.length-3], null, 1).slice(0, 1200));

console.log('\n=== 搜 5101302529657342 ===');
M.filter(m => JSON.stringify(m).includes('5101302529657342')).forEach(m =>
  console.log(JSON.stringify(m, null, 1).slice(0, 1400)));

console.log('\n=== 搜 P0xSQEwjA ===');
M.filter(m => JSON.stringify(m).includes('P0xSQEwjA')).forEach(m =>
  console.log(JSON.stringify({type:m.type,from:m.from,text:m.text,card:m.card,links:m.links,images:(m.images||[]).map(i=>i.kind)}, null, 1).slice(0, 1200)));

console.log('\n=== card.text 最长 TOP8 ===');
M.filter(m=>m.card).sort((a,b)=>((b.card.text||'').length-(a.card.text||'').length)).slice(0,8)
  .forEach(m => console.log('  len=' + (m.card.text||'').length + ' kind=' + m.card.kind + ' author=' + m.card.author + ' :: ' + (m.card.text||'').replace(/\n/g,'\\n').slice(0,120)));

console.log('\n=== 全文含「礼物」的消息（前20条结构）===');
M.filter(m => /礼物|心意|卡券|礼包/.test(m.text||'')).slice(0,20).forEach(m =>
  console.log('  [' + m.type + '|' + m.from + '] ' + (m.text||'').slice(0,60) + '  card=' + (m.card?m.card.kind:'-')));

console.log('\n=== 空文本 & 无图片 & 无卡片 的消息（可能是未知类型）===');
const weird = M.filter(m => !(m.text||'').trim() && !(m.images||[]).length && !m.card && !(m.links||[]).length);
console.log('  数量:', weird.length);
const wt = {}; weird.forEach(m => wt[m.type] = (wt[m.type]||0)+1);
console.log('  类型:', wt);
console.log(JSON.stringify(weird.slice(0,3), null, 1).slice(0,800));
