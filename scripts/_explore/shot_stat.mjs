/**
 * 真实 Chromium 渲染「互动统计」面板：截图 + 量真实几何
 */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const DIR = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const OUT = DIR + '/scripts/_explore/shots';
fs.mkdirSync(OUT, { recursive: true });
const url = 'file:///' + DIR + '/查看备份.html';

const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--hide-scrollbars'] });

for (const [w, h, name, mode] of [
  [2560, 1440, 'stat-2560', 'all'],
  [1280, 900, 'stat-1280', 'y90'],
  [420, 900, 'stat-420', 'all'],
]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(2200);
  await page.click('#statBtn');
  await page.waitForTimeout(600);
  if (mode === 'y90') { await page.click('#rangeSeg button[data-r="90"]'); await page.waitForTimeout(400); }
  await page.screenshot({ path: OUT + '/' + name + '.png' });

  const info = await page.evaluate(() => {
    const g = el => { if (!el) return null; const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const box = document.querySelector('.statbox');
    const svg = document.getElementById('chart');
    const paths = Array.from(svg.querySelectorAll('path'));
    const bl = paths.map(p => p.getBBox());
    const pw = paths.map(p => p.getAttribute('stroke-width'));
    // 折线上采样点是否真的有起伏（取「我」的原始线最后一个 path 前算）
    const texts = Array.from(svg.querySelectorAll('text')).map(t => t.textContent);
    return {
      box: g(box), svg: g(svg),
      boxOverflowX: box.scrollWidth > box.clientWidth + 1,
      boxOverflowY: box.scrollHeight > box.clientHeight + 1,
      docOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      paths: paths.length,
      bbox: bl.map(b => [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]),
      widths: pw,
      stroke: paths.slice(2, 4).map(p => getComputedStyle(p).stroke),
      stops: Array.from(svg.querySelectorAll('stop')).map(s => getComputedStyle(s).stopColor),
      titleFill: Array.from(svg.querySelectorAll('text')).map(t => getComputedStyle(t).fill).slice(0, 3),
      yAxis: texts.slice(0, 5),
      kpi: document.getElementById('kpis').textContent.replace(/\s+/g, ' ').trim(),
      range: document.getElementById('statRange').textContent.replace(/\s+/g, ' ').trim(),
      legendVisible: !!document.querySelector('.legend'),
      caliberOpen: document.querySelector('#caliber details') ? document.querySelector('#caliber details').open : false,
      tipHidden: !document.getElementById('tip').classList.contains('on'),
    };
  });
  console.log('\n===== ' + name + ' (' + w + '×' + h + ', 模式=' + mode + ') =====');
  console.log('页面报错:', errs.length ? errs.join(' | ') : '无');
  console.log('面板:', JSON.stringify(info.box), ' SVG:', JSON.stringify(info.svg));
  console.log('溢出:', '面板横' + (info.boxOverflowX ? '有' : '无') + ' / 面板纵' + (info.boxOverflowY ? '有' : '无') + ' / 文档横' + (info.docOverflowX ? '有' : '无'));
  console.log('折线 path:', info.paths, ' 线宽:', info.widths.join(','));
  console.log('真实渲染色 stroke:', JSON.stringify(info.stroke), ' 渐变 stop:', JSON.stringify(info.stops));
  console.log('文字色 sample:', JSON.stringify(info.titleFill));
  console.log('path bbox:', JSON.stringify(info.bbox));
  console.log('Y 轴刻度:', JSON.stringify(info.yAxis));
  console.log('KPI:', info.kpi);
  console.log('区间:', info.range);
  console.log('浮层默认隐藏:', info.tipHidden, ' 口径默认展开:', info.caliberOpen);

  // 悬停到图表中间，截第二张图看 tooltip
  if (name === 'stat-2560') {
    const box = await page.locator('#chart').boundingBox();
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.5);
    await page.waitForTimeout(300);
    await page.screenshot({ path: OUT + '/stat-hover.png' });
    const t = await page.evaluate(() => document.getElementById('tip').textContent.replace(/\s+/g, ' ').trim());
    console.log('悬停浮层内容:', t);
  }
  await page.close();
}

await browser.close();
console.log('\n截图输出目录: ' + OUT);
