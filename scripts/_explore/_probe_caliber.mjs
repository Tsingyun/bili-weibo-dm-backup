/* 只读探针：把「互动统计」面板里的口径原文与 KPI 原样打出来（2026-09-18）
   用途：改文档时逐字对齐页面，避免手抄错数字。
   用法：node scripts/_explore/_probe_caliber.mjs [weibo|bili|both]
*/
import path from 'node:path';
import { loadDep } from './_deps.mjs';

const { chromium } = loadDep('playwright');

const ROOT = path.resolve(process.cwd());
const want = (process.argv[2] || 'both').toLowerCase();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('file:///' + path.join(ROOT, '查看备份.html').replace(/\\/g, '/'));
await page.waitForTimeout(900);

for (const src of ['weibo', 'bili']) {
  if (want !== 'both' && want !== src) continue;
  if (src === 'bili') {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#srcSw button[data-src]')].find(x => x.dataset.src === 'bili');
      if (b) b.click();
    });
    await page.waitForTimeout(800);
  }
  await page.locator('#statBtn').click();
  await page.waitForTimeout(500);

  const dump = await page.evaluate(() => {
    const range = (document.querySelector('#statRange') || {}).innerText || '';
    const kpi = [...document.querySelectorAll('#statBody .kpi, #statBody .kpirow > *')]
      .map(e => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const cal = (document.querySelector('#caliber') || document.querySelector('.caliber') || {}).innerText || '';
    return { range, kpi, cal };
  });
  console.log('\n######## ' + src.toUpperCase() + ' ########');
  console.log('[范围] ' + dump.range.replace(/\s+/g, ' ').trim());
  if (dump.kpi.length) console.log('[KPI] ' + dump.kpi.join(' ｜ '));
  console.log('[口径]\n' + dump.cal.trim());
  await page.locator('#statClose').click();
  await page.waitForTimeout(300);
}
await browser.close();
