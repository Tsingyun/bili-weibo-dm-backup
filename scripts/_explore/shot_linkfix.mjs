/* 分享卡片「链接可读性」修复的证据截图：截单张卡片（元素级），浅色/深色各一张。
   用法：node scripts/_explore/shot_linkfix.mjs */
import { loadDep } from './_deps.mjs';
import fs from 'fs';
import path from 'path';

const { chromium } = loadDep('playwright');

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, 'scripts', '_explore', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('file:///' + path.join(ROOT, '查看备份.html').replace(/\\/g, '/'));
await page.waitForTimeout(700);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#srcSw button')].find(x => x.dataset.src === 'bili');
  if (b) b.click();
});
await page.waitForTimeout(900);

let i = 0;
for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(400);
  const card = page.locator('.msg.me .wcard.bc').first();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const name = '1' + (4 + i) + '-linkfix-' + theme + '.png';
  await card.screenshot({ path: path.join(OUT, name) });
  console.log('已截图: ' + name);
  i++;
  // 顺便把整页也留一张，方便看上下文
  await page.screenshot({ path: path.join(OUT, '1' + (4 + i) + '-linkfix-' + theme + '-full.png') });
  console.log('已截图: 1' + (4 + i) + '-linkfix-' + theme + '-full.png');
  i++;
}
await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
await browser.close();
