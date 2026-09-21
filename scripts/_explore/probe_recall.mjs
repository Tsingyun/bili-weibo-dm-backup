import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const cookie = fs.readFileSync(path.join(DATA, 'cookie_header.txt'), 'utf8').trim();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
async function api(u) {
  const r = await fetch('https://api.weibo.com/webim/' + u, { headers: { Cookie: cookie, Referer: 'https://api.weibo.com/chat', 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest' } });
  return await r.text();
}
// 抽 3 条本地判为 recalled 的 id，回源看真实字段
const messages = JSON.parse(fs.readFileSync(path.join(DATA, 'messages.json'), 'utf8'));
const ids = messages.filter(m => m.type === 'recalled').slice(0, 3).map(m => m.id);
ids.push(...messages.filter(m => m.recalled && m.media_type !== 9).slice(0, 2).map(m => m.id));
for (const id of ids) {
  const t = await api(`2/direct_messages/conversation.json?convert_emoji=1&count=20&max_id=${id}&uid=1234567890&is_include_group=0&from_contacts=1&source=209678993`);
  let j; try { j = JSON.parse(t); } catch { console.log(id, 'PARSE FAIL'); continue; }
  const hit = (j.direct_messages || []).find(m => String(m.idstr) === id);
  if (!hit) { console.log(id, '未命中'); continue; }
  console.log('=====', id, 'media_type=' + hit.media_type,
    'recall_status=' + JSON.stringify(hit.recall_status),
    'text=' + JSON.stringify((hit.text || '').slice(0, 30)));
  const keys = Object.keys(hit).filter(k => /recall|del|withdraw|status/i.test(k));
  for (const k of keys) console.log('    ', k, '=', JSON.stringify(hit[k]));
}
console.log('\n本地 recalled 总数:', messages.filter(m => m.type === 'recalled').length);
const rcMt = {};
messages.filter(m => m.type === 'recalled').forEach(m => { rcMt[m.media_type] = (rcMt[m.media_type] || 0) + 1; });
console.log('recalled 的 media_type 分布:', JSON.stringify(rcMt));
