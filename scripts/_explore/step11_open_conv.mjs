import fs from 'node:fs';
import { CDP, sleep } from './cdp_lib.mjs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const cdp = await CDP.attach(9333, 'api.weibo.com/chat');

await cdp.send('Page.enable');
await cdp.send('Network.enable');

const reqs = [];
cdp.on('Network.requestWillBeSent', p => {
  if (['XHR', 'Fetch'].includes(p.type)) reqs.push(p.request.url);
});

// 找 示例UP主 会话条目位置
const box = await cdp.eval(`(() => {
  const all = [...document.querySelectorAll('*')];
  const hit = all.filter(e => e.children.length === 0 && (e.textContent||'').trim() === '示例UP主');
  if (!hit.length) return null;
  let el = hit[0];
  for (let i = 0; i < 8 && el; i++) {
    const r = el.getBoundingClientRect();
    if (r.width > 150 && r.height > 30) return {x: r.left + 40, y: r.top + r.height/2, w: r.width, h: r.height, cls: el.className};
    el = el.parentElement;
  }
  const r = hit[0].getBoundingClientRect();
  return {x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height, cls: 'leaf-fallback'};
})()`);
console.log('target box =', JSON.stringify(box));

if (box && box.x > 0) {
  const pt = { x: Math.round(box.x), y: Math.round(box.y) };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pt, button: 'none' });
  await sleep(200);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pt, button: 'left', clickCount: 1 });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pt, button: 'left', clickCount: 1 });
  console.log('clicked at', JSON.stringify(pt));
} else {
  console.log('!! target not found, will try hash navigation');
  await cdp.eval(`location.hash = '#/chat/1234567890'`);
}

await sleep(9000);

const uniq = [...new Set(reqs)].filter(u => !u.startsWith('chrome-extension'));
const pic = uniq.filter(u => /pic_infos|att|pic/i.test(u));
console.log('=== total XHR after click:', uniq.length, '===');
console.log('=== PIC-RELATED ===');
pic.forEach(u => console.log('  ', u));
console.log('=== ALL ===');
uniq.forEach(u => console.log('  ', u));

fs.writeFileSync(R + '/click_net.json', JSON.stringify(uniq, null, 2), 'utf8');

// 页面 DOM 里的图片
const imgs = await cdp.eval(`JSON.stringify([...new Set([...document.querySelectorAll('img')].map(i=>i.src).filter(s=>/sinaimg|weibocdn/.test(s)))].slice(0,40))`);
console.log('=== DOM IMGS ===');
console.log(String(imgs).slice(0, 3000));

cdp.close();
