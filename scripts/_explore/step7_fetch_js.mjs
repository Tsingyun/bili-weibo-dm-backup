import fs from 'node:fs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const files = [
  'https://h5.sinaimg.cn/m/pcweibochat/js/app.48f8ddda.js',
  'https://h5.sinaimg.cn/m/pcweibochat/js/chunk-vendors.9bd01a1a.js',
  'https://h5.sinaimg.cn/m/pcweibochat/js/async-cards.ebf02a24.js',
  'https://h5.sinaimg.cn/m/pcweibochat/js/async-largepic.4c30a96d.js',
];

const found = new Map();
for (const url of files) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    const name = url.split('/').pop();
    fs.writeFileSync(`${R}/js_${name}.txt`, t, 'utf8');
    console.log('fetched', name, 'len', t.length);
    const pats = [
      /webim\/[A-Za-z0-9_\/\-]+\.json/g,
      /\/2\/direct_messages\/[A-Za-z0-9_]+/g,
      /["'`]\/?(?:2\/)?(?:direct_messages|attachments|groupchat|notice_center)[A-Za-z0-9_\/\-]*\.json/g,
      /att_[a-z_]+\.json/g,
    ];
    for (const p of pats) {
      const m = t.match(p);
      if (m) for (const x of m) found.set(x.replace(/^["'`]/, ''), (found.get(x.replace(/^["'`]/, '')) || 0) + 1);
    }
    // 找 attachments 相关上下文
    const idx = t.indexOf('attachments');
    if (idx >= 0) console.log('  attachments ctx:', JSON.stringify(t.slice(idx - 300, idx + 300)));
    const idx2 = t.indexOf('att_ids');
    if (idx2 >= 0) console.log('  att_ids ctx:', JSON.stringify(t.slice(idx2 - 300, idx2 + 300)));
  } catch (e) {
    console.log('fetch err', url, e.message);
  }
}

console.log('=== ENDPOINT CANDIDATES ===');
for (const [k, v] of [...found.entries()].sort()) console.log(v, k);
fs.writeFileSync(R + '/endpoints.json', JSON.stringify([...found.entries()], null, 2), 'utf8');
