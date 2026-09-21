import fs from 'node:fs';
const ck = fs.readFileSync(import.meta.dirname.replace(/\\/g, '/') + '/../../data/cookie_header.txt', 'utf8');
const H = {
  Cookie: ck,
  Referer: 'https://api.weibo.com/chat',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/plain, */*',
};
const urls = [
  'https://api.weibo.com/webim/2/direct_messages/conversation.json?convert_emoji=1&count=5&max_id=0&uid=1234567890&is_include_group=0&from_contacts=1&source=209678993',
  'https://api.weibo.com/webim/query_primary_info.json?source=209678993',
];
for (const u of urls) {
  const t0 = Date.now();
  try {
    const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(25000) });
    const txt = await r.text();
    console.log('[' + r.status + ']', txt.length, 'bytes in', Date.now() - t0, 'ms ::', u.slice(0, 90));
    console.log('   head:', txt.slice(0, 160));
  } catch (e) { console.log('[FAIL]', e.message, 'after', Date.now() - t0, 'ms ::', u.slice(0, 80)); }
}
