import fs from 'fs';
const ROOT = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const M = JSON.parse(fs.readFileSync(ROOT + '/data/messages.json', 'utf8'));

const mt = {};
M.forEach(m => { const k = m.media_type; mt[k] = (mt[k]||0)+1; });
console.log('media_type 分布:', mt);

console.log('\n=== type=link 的消息 ===');
M.filter(m=>m.type==='link').slice(0,30).forEach(m=>console.log('  mt='+m.media_type+' from='+m.from+' text='+(m.text||'').slice(0,70)+' card='+(m.card?m.card.kind:'null')+' cardAuthor='+(m.card?m.card.author:'-')));

console.log('\n=== 文本最长 TOP15 ===');
M.slice().sort((a,b)=>((b.text||'').length-(a.text||'').length)).slice(0,15)
 .forEach(m=>console.log('  len='+(m.text||'').length+' mt='+m.media_type+' ['+m.from+'] '+ (m.text||'').replace(/\n/g,'\\n').slice(0,150)));

console.log('\n=== mt=13/14 且 card 为空 ===');
M.filter(m=>(m.media_type===13||m.media_type===14) && !m.card).forEach(m=>console.log('  '+JSON.stringify({mt:m.media_type,text:(m.text||'').slice(0,80),links:m.links,imgs:(m.images||[]).length}).slice(0,320)));

console.log('\n=== 含「送出/赠送/已送/送礼/心意」的消息 ===');
M.filter(m=>/送出|赠送|已送|送礼|心意|礼物卡|领取/.test(m.text||'')).slice(0,15).forEach(m=>console.log('  ['+m.type+'/'+m.media_type+'] '+ (m.text||'').slice(0,90)));
