import fs from 'node:fs';
import { CDP, sleep } from './cdp_lib.mjs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const cdp = await CDP.attach(9333, 'api.weibo.com/chat');
await cdp.send('Network.enable');

const reqs = new Map();
cdp.on('Network.requestWillBeSent', p => {
  if (['XHR', 'Fetch', 'Image'].includes(p.type)) reqs.set(p.request.url, p.type);
});

// 打开会话
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
if (box) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 });
}
await sleep(5000);

// 滚到最底部
await cdp.eval(`(() => {
  const cands = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 200);
  cands.sort((a,b) => b.scrollHeight - a.scrollHeight);
  if (cands[0]) cands[0].scrollTop = cands[0].scrollHeight;
  return cands.length;
})()`);
await sleep(5000);

const info = await cdp.eval(`(() => {
  const out = {imgs: [], html: ''};
  const all = [...document.querySelectorAll('img')];
  for (const i of all) {
    const s = i.currentSrc || i.src || i.getAttribute('data-src') || '';
    if (/sinaimg|weibocdn/.test(s)) out.imgs.push({src: s, w: i.naturalWidth, h: i.naturalHeight, cls: i.className});
  }
  // 找"分享图片"节点
  const leaf = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.textContent||'').trim() === '分享图片');
  out.msgCount = leaf.length;
  if (leaf.length) {
    let el = leaf[0];
    for (let i=0;i<6 && el.parentElement;i++) el = el.parentElement;
    out.html = el.outerHTML.slice(0, 4000);
  }
  // 也找带 pic 的容器
  const picEls = [...document.querySelectorAll('[class*=pic],[class*=img],[class*=image],[class*=photo]')].slice(0, 20);
  out.picClasses = picEls.map(e => e.className + ' || ' + (e.tagName) + ' || ' + (e.style && e.style.backgroundImage || '').slice(0,200));
  return JSON.stringify(out);
})()`);

const d = JSON.parse(info);
console.log('msgCount(分享图片):', d.msgCount);
console.log('=== IMGS ===');
d.imgs.forEach(i => console.log('  ', i.w + 'x' + i.h, i.cls, i.src));
console.log('=== PIC CONTAINERS ===');
d.picClasses.forEach(c => console.log('  ', c));
console.log('=== MSG HTML ===');
console.log(d.html);

console.log('=== NET (image/xhr) new ===');
[...reqs.entries()].forEach(([u, t]) => console.log('  ', t, u));

fs.writeFileSync(R + '/dom_probe.json', JSON.stringify(d, null, 2), 'utf8');
cdp.close();
