/**
 * 用真实 Chromium 渲染查看页，按多种窗口宽度截图 + 量真实布局
 */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const DIR = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const OUT = DIR + '/scripts/_explore/shots';
fs.mkdirSync(OUT, { recursive: true });
const url = 'file:///' + DIR + '/查看备份.html';

const SIZES = [
  [2560, 1440, 'wide-2560'],
  [1600, 1000, 'mid-1600'],
  [1280, 900, 'narrow-1280'],
  [420, 860, 'phone-420'],
];

const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--hide-scrollbars'] });

for (const [w, h, name] of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + '/' + name + '.png' });

  const info = await page.evaluate(() => {
    const g = el => { if (!el) return null; const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }; };
    const side = document.querySelector('.sidebar');
    const rail = document.querySelector('.rail');
    const main = document.querySelector('main');
    const onEl = document.querySelector('#months .mo.on');
    return {
      sidebar: g(side), rail: g(rail), main: g(main),
      sidePos: getComputedStyle(side).position,
      railShown: getComputedStyle(rail).display !== 'none',
      months: document.querySelectorAll('#months .mo[data-m]').length,
      hlMonth: onEl ? onEl.textContent.trim() : null,
      msgs: document.querySelectorAll('.msg').length,
      faces: document.querySelectorAll('img.face').length,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      sidebarScroll: side.scrollHeight > side.clientHeight,
      railScroll: rail.scrollHeight > rail.clientHeight,
      // 侧栏控件是否都可见（未被裁掉）
      ctrlVisible: ['q', 'chips', 'jump', 'themeBtn', 'toTop', 'toBot']
        .every(id => { const e = document.getElementById(id); if (!e) return false;
          const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }),
    };
  });
  console.log('[' + name + '] ' + JSON.stringify(info));
  if (errs.length) console.log('   ⚠️ JS 错误: ' + errs.join(' | '));

  // 宽屏额外截一张「跳转后」的状态，验证高亮
  if (w >= 1340) {
    await page.evaluate(() => {
      const all = [...document.querySelectorAll('#months .mo[data-m]')];
      all[Math.floor(all.length / 2)].click();
    });
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => {
      const onEl = document.querySelector('#months .mo.on');
      const d = document.querySelector('#chat .day[data-m]');
      return { hl: onEl ? onEl.textContent.trim() : null, firstDay: d ? d.dataset.m : null };
    });
    console.log('   跳转后 → 高亮 ' + after.hl + ' / 首个日期分隔 ' + after.firstDay);
    await page.screenshot({ path: OUT + '/' + name + '-jump.png' });
  }
  await page.close();
}

await browser.close();
console.log('截图输出目录: ' + OUT);
