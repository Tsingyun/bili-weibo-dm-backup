import fs from 'fs';
const ROOT = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const M = JSON.parse(fs.readFileSync(ROOT + '/data/messages.json', 'utf8'));

// card kind / author 分布
const kd = {}, au = {};
for (const m of M) if (m.card) { kd[m.card.kind || '?'] = (kd[m.card.kind || '?'] || 0) + 1; au[(m.card.author || '(空)') + '|' + (m.card.kind || '?')] = (au[(m.card.author || '(空)') + '|' + (m.card.kind || '?')] || 0) + 1; }
console.log('card.kind 分布:', kd);
console.log('\ncard.author|kind TOP20:');
Object.entries(au).sort((a,b)=>b[1]-a[1]).slice(0,20).forEach(([k,v])=>console.log('  '+String(v).padStart(4)+'  '+k));

// 找 uid 7847210480
const hit = M.filter(m => JSON.stringify(m).includes('7847210480'));
console.log('\n含 uid 7847210480 的消息:', hit.length);
hit.slice(0, 4).forEach(m => console.log('  ---\n' + JSON.stringify({type:m.type,from:m.from,text:m.text,card:m.card,links:m.links,images:(m.images||[]).map(i=>i.kind+':'+i.file)}, null, 1)));

// 找所有「送礼/礼物」字样的 card
const gc = M.filter(m => m.card && /礼|gift|红包|赞赏|打赏/i.test(JSON.stringify(m.card)));
console.log('\n卡片里含礼/红包/gift 的:', gc.length);
gc.slice(0,6).forEach(m => console.log('  ', JSON.stringify(m.card).slice(0,300), '| text=', (m.text||'').slice(0,30)));

// 空白 author 的 weibo 卡片
const empty = M.filter(m => m.card && m.card.kind === 'weibo' && !m.card.author);
console.log('\nweibo 卡片且作者为空:', empty.length);
empty.slice(0,5).forEach(m => console.log('  ', JSON.stringify(m.card).slice(0,300)));

// 统计 text 里含 http 的
const urls = M.filter(m => /https?:\/\//.test(m.text||''));
console.log('\ntext 里含 URL 的消息:', urls.length);
urls.slice(-6).forEach(m => console.log('  [' + m.type + '] ' + (m.text||'').slice(0,120) + ' | links=' + JSON.stringify(m.links||[]).slice(0,120)));

// 同时有 card 和 links 的
const both = M.filter(m => m.card && m.links && m.links.length);
console.log('\n同时有 card 与 links:', both.length);
both.slice(0,3).forEach(m => console.log(JSON.stringify({text:m.text,card:m.card,links:m.links},null,1).slice(0,700)));
