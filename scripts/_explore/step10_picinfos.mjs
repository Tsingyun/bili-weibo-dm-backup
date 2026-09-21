import { CDP, sleep } from './cdp_lib.mjs';

const ATT = '5343066366937128';
const MID = '5343066368249809';
const cdp = await CDP.attach(9333, 'api.weibo.com/chat');

const tries = [
  `https://api.weibo.com/webim/pic_infos.json?pic_ids=${ATT}&source=209678993`,
  `https://api.weibo.com/webim/pic_infos.json?pic_ids=${ATT},${ATT}&source=209678993`,
  `https://api.weibo.com/webim/pic_infos.json?att_ids=${ATT}&source=209678993`,
  `https://api.weibo.com/webim/pic_infos.json?ids=${ATT}&source=209678993`,
  `https://api.weibo.com/webim/pic_infos.json?pic_id=${ATT}&source=209678993`,
  `https://api.weibo.com/webim/pic_infos.json?id=${ATT}&source=209678993`,
  `https://api.weibo.com/webim/pic_infos.json?mid=${MID}&source=209678993`,
  `https://api.weibo.com/webim/2/direct_messages/pic_infos.json?pic_ids=${ATT}&source=209678993`,
];

for (const url of tries) {
  const t = await cdp.eval(`(async () => {
    try { const r = await fetch(${JSON.stringify(url)}, {credentials:'include'}); return JSON.stringify({s:r.status, b:(await r.text()).slice(0,500)}); }
    catch(e){ return 'ERR:'+e.message; }
  })()`);
  console.log('---', url.replace('https://api.weibo.com/webim/', ''));
  console.log('   ', String(t).slice(0, 550));
  await sleep(300);
}

cdp.close();
