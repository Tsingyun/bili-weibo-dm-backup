import fs from 'node:fs';
import { CDP, sleep } from './cdp_lib.mjs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const cdp = await CDP.attach(9333, 'api.weibo.com/chat');

const want = new Set([4, 10, 11, 13, 14, 15]);
const found = {};
let cursor = '0';
for (let p = 0; p < 40; p++) {
  const t = await cdp.eval(`(async () => {
    try { const r = await fetch('https://api.weibo.com/webim/2/direct_messages/conversation.json?convert_emoji=1&count=50&max_id=${cursor}&uid=1234567890&is_include_group=0&from_contacts=1&source=209678993',{credentials:'include'}); return await r.text(); }
    catch(e){ return 'ERR:'+e.message; }
  })()`);
  let j; try { j = JSON.parse(t); } catch { break; }
  const list = j.direct_messages || [];
  if (!list.length) break;
  for (const m of list) {
    if (want.has(m.media_type) && !found[m.media_type]) {
      const { sender, recipient, ...slim } = m;
      found[m.media_type] = slim;
      console.log('FOUND media_type', m.media_type);
    }
  }
  if (Object.keys(found).length === want.size) break;
  cursor = String(list[list.length - 1].idstr);
  await sleep(200);
  if (p % 5 === 0) console.log('...page', p, 'found', Object.keys(found).join(','));
}

fs.writeFileSync(R + '/special_types.json', JSON.stringify(found, null, 2), 'utf8');
for (const [k, v] of Object.entries(found)) {
  console.log('\n========== media_type ' + k + ' ==========');
  console.log(JSON.stringify(v, null, 1));
}
cdp.close();
