/** 截「互动统计」面板的局部高清图 + 图表特写（含同轴对比模式） */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const DIR = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const OUT = DIR + '/scripts/_explore/shots';
fs.mkdirSync(OUT, { recursive: true });
const url = 'file:///' + DIR + '/查看备份.html';

const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(2200);
await page.click('#statBtn');
await page.waitForTimeout(600);

// 默认（独立量程 + 全部）
await page.locator('.statbox').screenshot({ path: OUT + '/stat-panel.png' });
await page.locator('#chartwrap').screenshot({ path: OUT + '/stat-chart-dual.png' });

// 切到同轴对比
await page.click('#dualTog');
await page.waitForTimeout(400);
await page.locator('#chartwrap').screenshot({ path: OUT + '/stat-chart-same.png' });

// 切回独立量程 + 近 90 天 + 关均线（看纯每日散点感）
await page.click('#dualTog');
await page.click('#rangeSeg button[data-r="90"]');
await page.click('#avgTog');
await page.waitForTimeout(400);
await page.locator('#chartwrap').screenshot({ path: OUT + '/stat-chart-90raw.png' });

// 悬停高亮
const box = await page.locator('#chart').boundingBox();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.45);
await page.waitForTimeout(300);
await page.locator('#chartwrap').screenshot({ path: OUT + '/stat-chart-hover.png' });

// 深浅主题各一张图表
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
await page.waitForTimeout(300);
await page.locator('.statbox').screenshot({ path: OUT + '/stat-panel-dark.png' });

// 手机端
const p2 = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
await p2.goto(url, { waitUntil: 'load' });
await p2.waitForTimeout(2000);
await p2.click('#statBtn');
await p2.waitForTimeout(600);
await p2.locator('.statbox').screenshot({ path: OUT + '/stat-panel-phone.png' });

console.log('页面报错:', errs.length ? errs.join(' | ') : '无');
console.log('已输出: stat-panel.png / stat-chart-dual.png / stat-chart-same.png / stat-chart-90raw.png / stat-chart-hover.png / stat-panel-dark.png / stat-panel-phone.png');
await browser.close();
