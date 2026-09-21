// 诊断：找出没有本地文件的图片项
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const messages = JSON.parse(fs.readFileSync(path.join(DATA, 'messages.json'), 'utf8'));

const miss = [];
const byKind = {};
for (const m of messages) {
  for (const im of (m.images || [])) {
    byKind[im.kind] = (byKind[im.kind] || 0) + 1;
    if (!im.local) miss.push({ id: m.id, kind: im.kind, file: im.file, url: im.url || '', pid: im.pid || '', fid: im.fid || '', text: (m.text || '').slice(0, 40), time: (m.time || '').slice(0, 19) });
  }
}
console.log('图片项统计：', JSON.stringify(byKind));
console.log('缺失项数量：', miss.length);
const seen = new Set();
for (const x of miss) {
  const k = x.file + '|' + x.url;
  if (seen.has(k)) continue;
  seen.add(k);
  console.log(JSON.stringify(x));
}
