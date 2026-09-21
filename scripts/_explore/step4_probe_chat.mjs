import { CDP, sleep } from './cdp_lib.mjs';

const UID = '1234567890';
const BASE = 'https://api.weibo.com/webim/2/direct_messages/';
const candidates = [
  `chat.json?count=20&uid=${UID}&source=209678993`,
  `messages.json?count=20&uid=${UID}&source=209678993`,
  `message_list.json?count=20&uid=${UID}&source=209678993`,
  `conversation.json?count=20&uid=${UID}&source=209678993`,
  `history.json?count=20&uid=${UID}&source=209678993`,
  `chat_message.json?count=20&uid=${UID}&source=209678993`,
  `dialog.json?count=20&uid=${UID}&source=209678993`,
  `list.json?count=20&uid=${UID}&source=209678993`,
  `user_chat.json?count=20&uid=${UID}&source=209678993`,
];

const cdp = await CDP.attach(9333, 'api.weibo.com/chat');

for (const c of candidates) {
  const url = BASE + c;
  const res = await cdp.eval(`(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, {credentials:'include'});
      const t = await r.text();
      return JSON.stringify({status:r.status, len:t.length, head:t.slice(0,400)});
    } catch(e){ return 'ERR:'+e.message; }
  })()`);
  console.log('--- ' + c.split('?')[0]);
  console.log(String(res).slice(0, 600));
  await sleep(400);
}

// 另外试 webim 根路径下的几个
const more = [
  `https://api.weibo.com/webim/chat.json?count=20&uid=${UID}&source=209678993`,
  `https://api.weibo.com/webim/messages.json?count=20&uid=${UID}&source=209678993`,
];
for (const url of more) {
  const res = await cdp.eval(`(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, {credentials:'include'});
      const t = await r.text();
      return JSON.stringify({status:r.status, len:t.length, head:t.slice(0,400)});
    } catch(e){ return 'ERR:'+e.message; }
  })()`);
  console.log('--- ROOT ' + url.replace('https://api.weibo.com/webim/',''));
  console.log(String(res).slice(0, 600));
  await sleep(400);
}

cdp.close();
