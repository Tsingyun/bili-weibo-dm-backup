import fs from 'fs';
const ROOT = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const EX = ROOT + '/scripts/_explore';
const M = JSON.parse(fs.readFileSync(ROOT + '/data/messages.json', 'utf8'));
const api = JSON.parse(fs.readFileSync(EX + '/emo_api.json', 'utf8'));
const map = {};
api.forEach(x => { if (x.phrase) map[x.phrase] = x.url; });
console.log('官方表情映射条数:', Object.keys(map).length);

// 数据里出现的表情名
const stat = {};
const re = /\[([^\[\]\s]{1,12})\]/g;
for (const m of M) {
  const t = m.text || '';
  let r; re.lastIndex = 0;
  while ((r = re.exec(t))) stat[r[1]] = (stat[r[1]] || 0) + 1;
}
const names = Object.keys(stat);
const hit = names.filter(n => map['[' + n + ']']);
const miss = names.filter(n => !map['[' + n + ']']);
console.log('\n出现表情名:', names.length, ' 命中官方:', hit.length, ' 未命中:', miss.length);
console.log('\n未命中的（按出现次数）:');
miss.sort((a, b) => stat[b] - stat[a]).forEach(n => console.log('   ' + String(stat[n]).padStart(4) + '×  [' + n + ']'));
console.log('\n命中样例:');
hit.slice(0, 6).forEach(n => console.log('   [' + n + '] -> ' + map['[' + n + ']']));

// 检查 eeXXXX 形式的图片是否已在本地
const eeNames = new Set();
for (const m of M) { const t = m.text || ''; let r; const r2 = /\/?(ee[0-9a-f]{6})\.png/g; while ((r = r2.exec(t))) eeNames.add(r[1]); }
console.log('\n文本中出现的 eeXXXX 表情名:', eeNames.size, [...eeNames].slice(0, 12).join(' '));
const imgs = fs.readdirSync(ROOT + '/data/images');
console.log('本地图片文件数:', imgs.length);
console.log('本地含 ee 的文件:', imgs.filter(f => /ee/i.test(f)).slice(0, 20));
console.log('本地文件名样例:', imgs.filter(f => f.startsWith('emoji') || f.startsWith('compic')).slice(0, 8));
