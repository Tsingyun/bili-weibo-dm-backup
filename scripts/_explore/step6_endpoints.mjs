import fs from 'node:fs';
import { CDP } from './cdp_lib.mjs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const cdp = await CDP.attach(9333, 'api.weibo.com/chat');

// 1) 列出页面已加载的 JS
const scripts = await cdp.eval(`JSON.stringify(performance.getEntriesByType('resource').map(r=>r.name).filter(n=>/\\.js(\\?|$)/.test(n)))`);
const list = JSON.parse(scripts);
console.log('js files:', list.length);
list.forEach(s => console.log('  ', s));

// 2) 逐个抓取并在其中搜接口路径
const found = new Map();
for (const url of list) {
  const txt = await cdp.eval(`(async () => {
    try { const r = await fetch(${JSON.stringify(url)}, {credentials:'include'}); return await r.text(); }
    catch(e){ return ''; }
  })()`);
  if (!txt || typeof txt !== 'string') continue;
  const pats = [
    /webim\/[A-Za-z0-9_\/\-]+\.json/g,
    /direct_messages\/[A-Za-z0-9_]+/g,
    /["'`](\/(?:2\/)?(?:direct_messages|attachments|chat)[A-Za-z0-9_\/\-]*)["'`]/g,
  ];
  for (const p of pats) {
    const m = txt.match(p);
    if (m) for (const x of m) found.set(x, (found.get(x) || 0) + 1);
  }
  console.log('scanned', url.split('/').pop().slice(0, 60), 'len', txt.length);
}

console.log('=== ENDPOINT CANDIDATES ===');
for (const [k, v] of [...found.entries()].sort()) console.log(v, k);
fs.writeFileSync(R + '/endpoints.json', JSON.stringify([...found.entries()], null, 2), 'utf8');

cdp.close();
