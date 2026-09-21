import fs from 'node:fs';
import { CDP, sleep } from './cdp_lib.mjs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const TARGET_PID = '002XJY2Tly8hpzhjgxi4vg6074074k0102';

const cdp = await CDP.attach(9333, 'api.weibo.com/chat');
await cdp.send('Page.enable');
await cdp.send('Network.enable');

const idUrl = new Map();
const bodies = [];

cdp.on('Network.requestWillBeSent', p => {
  if (['XHR', 'Fetch'].includes(p.type) && /conversation\.json|pic_infos\.json|recent_messages/.test(p.request.url)) {
    idUrl.set(p.requestId, p.request.url);
  }
});
cdp.on('Network.loadingFinished', async p => {
  const u = idUrl.get(p.requestId);
  if (!u) return;
  try {
    const b = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
    bodies.push({ url: u, len: (b.body || '').length, body: b.body });
  } catch (e) { bodies.push({ url: u, err: e.message }); }
});

// 重新加载页面以便完整捕获
await cdp.send('Page.navigate', { url: 'https://api.weibo.com/chat#/chat' });
await sleep(9000);

// 点击会话
const box = await cdp.eval(`(() => {
  const hit = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.textContent||'').trim() === '示例UP主');
  if (!hit.length) return null;
  let el = hit[0];
  for (let i = 0; i < 8 && el; i++) {
    const r = el.getBoundingClientRect();
    if (r.width > 150 && r.height > 30) return {x: Math.round(r.left + 40), y: Math.round(r.top + r.height/2)};
    el = el.parentElement;
  }
  const r = hit[0].getBoundingClientRect();
  return {x: Math.round(r.left), y: Math.round(r.top)};
})()`);
console.log('box=', JSON.stringify(box));
if (box) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 });
}
await sleep(9000);

console.log('=== captured bodies ===');
for (const b of bodies) {
  console.log(b.url.replace('https://api.weibo.com/', ''), 'len=', b.len, b.err || '');
}

const conv = bodies.find(b => /conversation\.json/.test(b.url) && b.body);
if (conv) {
  fs.writeFileSync(R + '/app_conv.json', conv.body, 'utf8');
  const has = conv.body.includes(TARGET_PID);
  console.log('\napp conversation.json contains target pid?', has);
  if (has) {
    const i = conv.body.indexOf(TARGET_PID);
    console.log('CTX:', conv.body.slice(Math.max(0, i - 1200), i + 400));
  } else {
    console.log('first 1200:', conv.body.slice(0, 1200));
  }
}
const pic = bodies.find(b => /pic_infos/.test(b.url) && b.body);
if (pic) {
  console.log('\n=== pic_infos response ===');
  console.log(pic.url);
  console.log(pic.body.slice(0, 1500));
}

cdp.close();
