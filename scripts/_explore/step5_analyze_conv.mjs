import fs from 'node:fs';
import { CDP, sleep } from './cdp_lib.mjs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const UID = '1234567890';
const cdp = await CDP.attach(9333, 'api.weibo.com/chat');

async function got(url) {
  const s = await cdp.eval(`(async () => {
    try { const r = await fetch(${JSON.stringify(url)}, {credentials:'include'}); return await r.text(); }
    catch(e){ return 'ERR:'+e.message; }
  })()`);
  return s;
}

const base = `https://api.weibo.com/webim/2/direct_messages/conversation.json?uid=${UID}&source=209678993`;

const page1 = await got(base + '&count=50');
fs.writeFileSync(R + '/conv_p1.json', page1, 'utf8');
let j1 = JSON.parse(page1);
console.log('P1 keys:', Object.keys(j1));
console.log('P1 total_number:', j1.total_number, 'prev_cursor:', j1.previous_cursor, 'next_cursor:', j1.next_cursor);
const dm1 = j1.direct_messages || [];
console.log('P1 count:', dm1.length);
console.log('P1 first:', dm1[0] && (dm1[0].idstr + ' | ' + dm1[0].created_at + ' | ' + String(dm1[0].text).slice(0,60)));
console.log('P1 last :', dm1[dm1.length-1] && (dm1[dm1.length-1].idstr + ' | ' + dm1[dm1.length-1].created_at + ' | ' + String(dm1[dm1.length-1].text).slice(0,60)));
console.log('msg keys:', JSON.stringify(Object.keys(dm1[0] || {})));

const oldest = dm1[dm1.length-1].idstr;

// 试不同分页参数
const variants = [
  `&max_id=${oldest}`,
  `&since_id=${oldest}`,
  `&max_mid=${oldest}`,
  `&prev_cursor=${j1.previous_cursor}&cursor=${j1.previous_cursor}`,
];
for (const v of variants) {
  const t = await got(base + '&count=50' + v);
  try {
    const j = JSON.parse(t);
    const dm = j.direct_messages || [];
    console.log(`--- ${v} -> count=${dm.length}`, dm.length ? (dm[0].created_at + ' .. ' + dm[dm.length-1].created_at) : JSON.stringify(j).slice(0,200));
  } catch {
    console.log(`--- ${v} -> ERR`, String(t).slice(0, 200));
  }
  await sleep(600);
}

// 看看媒体字段长什么样
const withMedia = dm1.filter(m => m.media_type || m.pic_id || (m.url_objects && m.url_objects.length));
console.log('P1 msgs with media-ish fields:', withMedia.length);
for (const m of withMedia.slice(0, 3)) {
  console.log('MEDIA SAMPLE:', JSON.stringify(m).slice(0, 1500));
  console.log('---');
}

cdp.close();
