import fs from 'node:fs';
import path from 'node:path';
import { CDP, sleep } from './cdp_lib.mjs';

const ROOT = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const OUT = path.join(ROOT, 'data', 'raw');
fs.mkdirSync(OUT, { recursive: true });

const cdp = await CDP.attach(9333, 'api.weibo.com/chat');
console.log('[cdp] target =', cdp.target.url);

// 1) 当前登录账号
const me = await cdp.eval(`(async () => {
  try {
    const r = await fetch('https://api.weibo.com/webim/query_primary_info.json?source=209678993', {credentials:'include'});
    return await r.text();
  } catch(e) { return 'ERR:'+e.message; }
})()`);
console.log('=== primary_info ===');
console.log(String(me).slice(0, 1500));

// 2) 联系人列表
const contactsRaw = await cdp.eval(`(async () => {
  try {
    const u = 'https://api.weibo.com/webim/2/direct_messages/contacts.json?special_source=3&add_virtual_user=3,4&is_include_group=0&need_back=0,0&is_include_folder=1&count=200&source=209678993';
    const r = await fetch(u, {credentials:'include'});
    const t = await r.text();
    return JSON.stringify({status: r.status, len: t.length, body: t.slice(0, 400000)});
  } catch(e) { return 'ERR:'+e.message; }
})()`);

let contacts = null;
try {
  const wrap = JSON.parse(contactsRaw);
  fs.writeFileSync(path.join(OUT, 'contacts_raw.json'), wrap.body, 'utf8');
  contacts = JSON.parse(wrap.body);
  console.log('=== contacts status', wrap.status, 'len', wrap.len, '===');
} catch (e) {
  console.log('contacts parse err', e.message, String(contactsRaw).slice(0, 500));
}

if (contacts) {
  const dump = JSON.stringify(contacts);
  // 找出所有字符串型 screen_name
  const names = [...dump.matchAll(/"screen_name":"([^"]*)"/g)].map(m => m[1]);
  console.log('screen_names:', JSON.stringify([...new Set(names)].slice(0, 200)));
  console.log('keys:', JSON.stringify(Object.keys(contacts)));
}

// 3) 探测聊天记录接口
const uid = process.argv[2] || '';
const candidates = [
  `https://api.weibo.com/webim/2/direct_messages/chat.json?count=20&uid=${uid}&source=209678993`,
  `https://api.weibo.com/webim/2/direct_messages/messages.json?count=20&uid=${uid}&source=209678993`,
  `https://api.weibo.com/webim/2/direct_messages/message_list.json?count=20&uid=${uid}&source=209678993`,
  `https://api.weibo.com/webim/2/direct_messages/conversation.json?count=20&uid=${uid}&source=209678993`,
  `https://api.weibo.com/webim/2/direct_messages/history.json?count=20&uid=${uid}&source=209678993`,
];

if (uid) {
  for (const c of candidates) {
    const res = await cdp.eval(`(async () => {
      try {
        const r = await fetch(${JSON.stringify(c)}, {credentials:'include'});
        const t = await r.text();
        return JSON.stringify({status:r.status, len:t.length, head:t.slice(0,700)});
      } catch(e){ return 'ERR:'+e.message; }
    })()`);
    console.log('--- PROBE', c.replace('https://api.weibo.com/webim/2/direct_messages/',''));
    console.log(String(res).slice(0, 900));
    await sleep(500);
  }
} else {
  console.log('[skip] no uid given, only contacts fetched');
}

cdp.close();
