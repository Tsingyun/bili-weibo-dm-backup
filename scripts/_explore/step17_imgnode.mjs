import fs from 'node:fs';
import { CDP, sleep } from './cdp_lib.mjs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const cdp = await CDP.attach(9333, 'api.weibo.com/chat');

const out = await cdp.eval(`(() => {
  const res = [];
  const nodes = [...document.querySelectorAll('img[class^="img"], .item-image, .large_img_container')];
  for (const n of nodes) {
    const info = {tag: n.tagName, cls: n.className, html: n.outerHTML.slice(0, 800)};
    if (n.tagName === 'IMG') info.src = n.src, info.currentSrc = n.currentSrc, info.dataSrc = n.getAttribute('data-src');
    const cs = getComputedStyle(n);
    info.bg = cs.backgroundImage;
    info.parentHtml = n.parentElement ? n.parentElement.outerHTML.slice(0, 1200) : '';
    res.push(info);
  }
  return JSON.stringify(res);
})()`);

const arr = JSON.parse(out);
console.log('nodes:', arr.length);
for (const a of arr) {
  console.log('\n=====', a.tag, a.cls);
  console.log('src:', a.src);
  console.log('currentSrc:', a.currentSrc);
  console.log('data-src:', a.dataSrc);
  console.log('bg:', a.bg);
  console.log('HTML:', a.html);
  console.log('PARENT:', a.parentHtml.slice(0, 900));
}
fs.writeFileSync(R + '/img_nodes.json', JSON.stringify(arr, null, 2), 'utf8');
cdp.close();
