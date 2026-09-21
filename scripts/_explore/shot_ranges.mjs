/** 对比不同时间范围的图表观感（都开均线 + 独立量程） */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const DIR = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const OUT = DIR + '/scripts/_explore/shots';
const url = 'file:///' + DIR + '/查看备份.html';

const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(2200);
await page.click('#statBtn');
await page.waitForTimeout(500);

for (const r of ['30', '90', '365', '0']) {
  await page.click(`#rangeSeg button[data-r="${r}"]`);
  await page.waitForTimeout(450);
  await page.locator('#chartwrap').screenshot({ path: `${OUT}/range-${r || 'all'}.png` });
  const info = await page.evaluate(() => {
    const svg = document.getElementById('chart');
    const n = Number(svg.getAttribute('width').replace('px', ''));
    const d = document.getElementById('statRange').textContent;
    const k = document.getElementById('kpis').textContent.replace(/\s+/g, ' ');
    return { w: n, range: d.replace(/\s+/g, ' '), kpi: k.slice(0, 80) };
  });
  console.log(`范围=${r || '全部'}  图宽=${info.w}  ${info.range}`);
  console.log('   ' + info.kpi);
}

await browser.close();
console.log('\n输出: range-30 / range-90 / range-365 / range-all .png');
