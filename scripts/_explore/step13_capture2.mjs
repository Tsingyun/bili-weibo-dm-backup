import fs from 'node:fs';
import { CDP, sleep } from './cdp_lib.mjs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const cdp = await CDP.attach(9333, 'api.weibo.com/chat');
await cdp.send('Page.enable');
await cdp.send('Network.enable');

const idUrl = new Map();
const bodies = [];
cdp.on('Network.requestWillBeSent', p => {
  if (['XHR', 'Fetch'].includes(p.type) && /api\.weibo\.com/.test(p.request.url)) {
    idUrl.set(p.requestId, p.request.url);
  }
});
cdp.on('Network.loadingFinished', async p => {
  const u = idUrl.get(p.requestId);
  if (!u) return;
  try {
    const b = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
    bodies.push({ url: u, len: (b.body || '').length, body: b.body });
  } catch (e) { /* ignore */ }
});

console.log('[reload]');
await cdp.send('Page.reload', { ignoreCache: true });
await sleep(11000);

async function clickConv() {
  const box = await cdp.eval(`(() => {
    const hit = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.textContent||'').trim() === '示例UP主');
    if (!hit.length) return null;
    let el = hit[0];
    for (let i = 0; i < 8 && el; i++) {
      const r = el.getBoundingClientRect();
      if (r.width > 150 && r.height > 30) return {x: Math.round(r.left + 40), y: Math.round(r.top + r.height/2)};
      el = el.parentElement;
    }
    return null;
  })()`);
  if (box && box.x > 0) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 });
    await sleep(80);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 });
    console.log('[click]', JSON.stringify(box));
  } else console.log('[click] target not found');
}

await clickConv();
await sleep(8000);
await clickConv();
await sleep(8000);

console.log('=== captured', bodies.length, 'bodies ===');
for (const b of bodies) console.log('  ', b.len, b.url.replace('https://api.weibo.com/', ''));

fs.writeFileSync(R + '/captured_bodies.json', JSON.stringify(bodies.map(b => ({ url: b.url, len: b.len })), null, 2), 'utf8');
for (const b of bodies) {
  const name = b.url.split('/').slice(-1)[0].split('?')[0].replace(/[^\w.-]/g, '_');
  fs.writeFileSync(`${R}/body_${name}.json`, b.body || '', 'utf8');
}

const conv = bodies.filter(b => /conversation\.json/.test(b.url)).sort((a, b) => b.len - a.len)[0];
if (conv) {
  console.log('\n=== conv body head ===');
  console.log(conv.body.slice(0, 800));
  const m = conv.body.match(/"pids?":[^,\]]{0,200}/g);
  console.log('pids fields:', m ? JSON.stringify(m.slice(0, 5)) : 'none');
  // 找像 pid 的长串
  const longs = [...new Set(conv.body.match(/[0-9A-Za-z]{28,40}/g) || [])].filter(s => /[A-Za-z]/.test(s) && /\d/.test(s));
  console.log('long alnum tokens (sample 20):', JSON.stringify(longs.slice(0, 20)));
}
const pic = bodies.find(b => /pic_infos/.test(b.url));
if (pic) {
  console.log('\n=== pic_infos ===');
  console.log(pic.url);
  console.log(pic.body.slice(0, 1200));
}

cdp.close();
