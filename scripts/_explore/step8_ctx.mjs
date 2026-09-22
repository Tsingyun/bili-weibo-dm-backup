import fs from 'node:fs';
const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const t = fs.readFileSync(R + '/js_app.48f8ddda.js.txt', 'utf8');

function ctx(needle, before = 500, after = 500, max = 3) {
  let i = -1, n = 0;
  while ((i = t.indexOf(needle, i + 1)) !== -1 && n < max) {
    n++;
    console.log(`\n===== "${needle}" @${i} =====`);
    console.log(t.slice(Math.max(0, i - before), i + after));
  }
  if (!n) console.log(`(no match: ${needle})`);
}

ctx('pic_infos', 700, 400, 3);
ctx('oriImageId', 500, 500, 2);
ctx('media_type:1', 300, 300, 1);
ctx('att_ids', 400, 400, 3);
