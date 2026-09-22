import fs from 'fs';
const ROOT = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const M = JSON.parse(fs.readFileSync(ROOT + '/data/messages.json', 'utf8'));

function show(name, fn) {
  const r = M.filter(fn);
  console.log('\n=== ' + name + '  ->  ' + r.length + ' 条 ===');
  const seen = {};
  r.forEach(m => { const k = (m.text||'').replace(/\s+/g,' ').slice(0, 70); seen[k] = (seen[k]||0)+1; });
  Object.entries(seen).sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([k,v])=>console.log('   ' + String(v).padStart(3) + '× ' + k + (r[0] && r[0].links.length ? ' [有链接]' : '')));
}

show('含 助威/权益', m => /助威|权益/.test(m.text||''));
show('含 vipclub', m => JSON.stringify(m).includes('vipclub'));
show('含 感谢您的', m => /感谢您的/.test(m.text||''));
show('对方发的系统/模板类（含http且长度>25）', m => m.from==='peer' && /https?:\/\//.test(m.text||'') && (m.text||'').length>25);
show('含 礼物', m => /礼物/.test(m.text||''));
show('含 送出/送出', m => /送出/.test(m.text||''));

// 对方发的最长 10 条
console.log('\n=== 对方(peer)发出的最长 10 条 ===');
M.filter(m=>m.from==='peer').sort((a,b)=>((b.text||'').length-(a.text||'').length)).slice(0,10)
 .forEach(m=>console.log('  len='+(m.text||'').length+' mt='+m.media_type+' :: '+(m.text||'').replace(/\n/g,'\\n').slice(0,110)));
