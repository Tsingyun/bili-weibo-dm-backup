import fs from 'node:fs';
import { CDP } from './cdp_lib.mjs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const cdp = await CDP.attach(9333, 'api.weibo.com/chat');

const ATT = '5343066366937128';
const tries = [
  `pids=${ATT}`,
  `pids=${ATT},${ATT}`,
  `pids=1022:${ATT}`,
  `pids=${ATT}&type=1`,
];
for (const q of tries) {
  const t = await cdp.eval(`(async () => {
    try { const r = await fetch('https://api.weibo.com/webim/pic_infos.json?${q}&source=209678993',{credentials:'include'}); return (await r.text()).slice(0,300); }
    catch(e){ return 'ERR:'+e.message; }
  })()`);
  console.log('pids probe:', q, '=>', t);
}

// 在 JS 里搜 pic_infos / att_ids / oriImageId 的用法
const jsFiles = fs.readdirSync(R).filter(f => /^js_.*\.txt$/.test(f));
for (const f of jsFiles) {
  const t = fs.readFileSync(R + '/' + f, 'utf8');
  for (const needle of ['pic_infos', 'oriImageId', 'att_ids']) {
    let i = -1, n = 0;
    while ((i = t.indexOf(needle, i + 1)) !== -1 && n < 2) {
      n++;
      console.log(`\n### ${f} :: ${needle} @${i}`);
      console.log(t.slice(Math.max(0, i - 400), i + 400).replace(/\s+/g, ' '));
    }
  }
}

cdp.close();
