/**
 * 诊断左侧栏里那个可疑白色浮层是什么
 */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const DIR = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const OUT = DIR + '/scripts/_explore/shots';
const url = 'file:///' + DIR + '/查看备份.html';

const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(2000);

// 1) 点 (150, 200) 那个位置，看看命中的是什么元素
const hit = await page.evaluate(() => {
  const els = document.elementsFromPoint(150, 200);
  return els.slice(0, 6).map(e => e.tagName + '#' + (e.id || '') + '.' + (e.className || '').toString().slice(0, 60)
    + ' ← ' + (e.textContent || '').trim().slice(0, 40));
});
console.log('坐标(150,200)处的元素栈:');
hit.forEach(h => console.log('   ' + h));

// 2) 列出侧栏直接子元素的位置
const kids = await page.evaluate(() => {
  const side = document.querySelector('.sidebar');
  return [...side.children].map(e => {
    const r = e.getBoundingClientRect();
    return (e.className || e.tagName).toString().slice(0, 30).padEnd(32)
      + ' y=' + Math.round(r.y).toString().padStart(5) + ' h=' + Math.round(r.height).toString().padStart(4)
      + ' x=' + Math.round(r.x).toString().padStart(4) + ' w=' + Math.round(r.width);
  });
});
console.log('\n侧栏直接子元素:');
kids.forEach(k => console.log('   ' + k));

// 3) 页面里有没有位置异常的浮层（不在 layout 三栏里的 fixed/absolute 元素）
const floaters = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('body *').forEach(e => {
    const cs = getComputedStyle(e);
    if (cs.position === 'fixed' || cs.position === 'absolute') {
      const r = e.getBoundingClientRect();
      if (r.width > 40 && r.height > 40 && r.y < 600 && r.x < 400) {
        out.push(e.tagName + '#' + (e.id || '') + '.' + (e.className || '').toString().slice(0, 40)
          + ' pos=' + cs.position + ' z=' + cs.zIndex
          + ' rect=' + [r.x, r.y, r.width, r.height].map(Math.round).join(','));
      }
    }
  });
  return out;
});
console.log('\n侧栏区域内的 fixed/absolute 元素:');
console.log(floaters.length ? floaters.map(f => '   ' + f).join('\n') : '   无');

// 4) 单独截侧栏，看清细节
await page.locator('.sidebar').screenshot({ path: OUT + '/sidebar.png' });
await page.locator('.rail').screenshot({ path: OUT + '/rail.png' });
console.log('\n已单独截图 sidebar.png / rail.png');

await browser.close();
