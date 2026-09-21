import fs from 'node:fs';
const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const j = JSON.parse(fs.readFileSync(R + '/conv_p1.json', 'utf8'));
const dm = j.direct_messages;

// 统计 media_type 分布
const mt = {};
for (const m of dm) mt[m.media_type] = (mt[m.media_type] || 0) + 1;
console.log('media_type dist:', JSON.stringify(mt));

// 找 media_type==1 的完整字段
const img = dm.find(m => m.media_type === 1);
console.log('\n=== FULL IMAGE MESSAGE KEYS ===');
console.log(JSON.stringify(Object.keys(img)));
console.log('\n=== FULL IMAGE MESSAGE ===');
console.log(JSON.stringify(img, null, 1).slice(0, 6000));

// 是否是回复/其他类型
const mt9 = dm.find(m => m.media_type === 9);
console.log('\n=== media_type 9 keys ===');
if (mt9) console.log(JSON.stringify(Object.keys(mt9)), '| att_ids=', JSON.stringify(mt9.att_ids), '| oriImageId=', mt9.oriImageId);

// 全量字段名汇总
const allKeys = new Set();
for (const m of dm) Object.keys(m).forEach(k => allKeys.add(k));
console.log('\n=== ALL KEYS ACROSS MESSAGES ===');
console.log(JSON.stringify([...allKeys]));
