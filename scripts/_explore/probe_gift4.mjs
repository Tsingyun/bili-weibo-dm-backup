import fs from 'fs';
const ROOT = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const M = JSON.parse(fs.readFileSync(ROOT + '/data/messages.json', 'utf8'));

console.log('=== 含 vipclub (赞赏/送礼) ===');
M.filter(m => JSON.stringify(m).includes('vipclub')).forEach(m =>
  console.log(JSON.stringify(m, null, 1).slice(0, 1500)));

console.log('\n=== 含 photo.weibo.com/h5/comment (动图卡片) 的样例 ===');
M.filter(m => m.card && /photo\.weibo\.com/.test(m.card.url || '')).slice(0,2).forEach(m =>
  console.log(JSON.stringify(m, null, 1).slice(0, 1300)));

console.log('\n=== 所有 kind=weibo 且有图片的卡片 ===');
M.filter(m => m.card && m.card.kind === 'weibo' && (m.images||[]).length).slice(0,3).forEach(m =>
  console.log(JSON.stringify({text:m.text, card:m.card, imgs:(m.images||[]).slice(0,3)}, null, 1).slice(0,1200)));
