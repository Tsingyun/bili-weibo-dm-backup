import fs from 'node:fs';
const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const files = fs.readdirSync(R).filter(f => /^body_.*conversation/.test(f));
console.log('files:', files);
const body = fs.readFileSync(R + '/' + files[0], 'utf8');

const pid = '002XJY2Tly8hpzhjgxi4vg6074074k0102';
const i = body.indexOf(pid);
console.log('pid index:', i);
console.log('=== CONTEXT ===');
console.log(body.slice(Math.max(0, i - 2500), i + 600));

// 用 JSON 精确定位
const j = JSON.parse(body);
for (const m of j.direct_messages) {
  const s = JSON.stringify(m);
  if (s.includes(pid) || m.att_ids) {
    console.log('\n===== MESSAGE with pid/att_ids =====');
    console.log('idstr:', m.idstr, 'media_type:', m.media_type, 'text:', JSON.stringify(m.text));
    console.log('att_ids:', JSON.stringify(m.att_ids), 'oriImageId:', m.oriImageId);
    console.log('keys:', JSON.stringify(Object.keys(m)));
    for (const [k, v] of Object.entries(m)) {
      const vs = JSON.stringify(v);
      if (vs && vs.includes(pid)) console.log('  >>> FIELD', k, '=', vs.slice(0, 600));
    }
  }
}
