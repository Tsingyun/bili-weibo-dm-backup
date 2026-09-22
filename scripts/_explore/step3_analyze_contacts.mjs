import fs from 'node:fs';
const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const j = JSON.parse(fs.readFileSync(R + '/contacts_raw.json', 'utf8'));

console.log('top keys:', Object.keys(j));
const cs = j.contacts;
console.log('contacts type:', Array.isArray(cs) ? 'array' : typeof cs, 'len:', Array.isArray(cs) ? cs.length : Object.keys(cs || {}).length);

const arr = Array.isArray(cs) ? cs : Object.values(cs || {});
if (arr.length) {
  console.log('item[0] keys:', Object.keys(arr[0]));
  console.log('item[0] sample:', JSON.stringify(arr[0]).slice(0, 1200));
}

// 找出所有含"对方"的位置
const raw = fs.readFileSync(R + '/contacts_raw.json', 'utf8');
let idx = -1; const hits = [];
while ((idx = raw.indexOf('对方', idx + 1)) !== -1) hits.push(idx);
console.log('occurrences of 对方:', hits.length);
for (const h of hits.slice(0, 5)) {
  console.log('---@' + h + '---');
  console.log(raw.slice(Math.max(0, h - 500), h + 300));
}

// 列出所有可辨识的名字
const names = arr.map(c => c.name || c.screen_name || c.nick || c.display_name).filter(Boolean);
console.log('names count:', names.length);
console.log(JSON.stringify([...new Set(names)].slice(0, 120)));
