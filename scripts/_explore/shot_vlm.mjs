/**
 * 真实 Chromium 渲染「搜图片内容描述」效果：截图 + 量真实渲染色
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
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(2500);

const meta = await page.evaluate(() => {
  const V = window.DM_VLM || {};
  const keys = Object.keys(V).filter(k => k !== '_meta');
  return {
    keys: keys.length,
    withDesc: keys.filter(k => (V[k] || {}).d).length,
    stats: document.getElementById('stats').textContent,
  };
});
console.log('VLM 索引 ' + meta.keys + ' 条，含描述 ' + meta.withDesc + ' 张');
console.log('侧栏统计：' + meta.stats.replace(/\s+/g, ' '));

await page.screenshot({ path: OUT + '/vlm-1-stats.png' });

// 挑一个「只在图片描述里出现」的词（既不在正文、也不在 OCR 文本里）
const word = await page.evaluate(() => {
  const V = window.DM_VLM || {}, O = window.DM_OCR || {};
  const M = window.DM_DATA.messages;
  const plain = M.map(m => (m.text || '') + ' ' + (m.card ? JSON.stringify(m.card) : '') +
    ' ' + JSON.stringify(m.links || [])).join(' ').toLowerCase();
  const ocrAll = Object.entries(O).filter(([k]) => k !== '_meta')
    .map(([, v]) => (v && v.t) || '').join(' ').toLowerCase();
  const cands = [];
  for (const [k, v] of Object.entries(V)) {
    if (k === '_meta' || !v || !v.d) continue;
    for (const w of (v.d.match(/[\u4e00-\u9fa5]{3,5}/g) || [])) cands.push({ k, w });
  }
  const pick = cands.filter(c => !plain.includes(c.w.toLowerCase()) &&
    !ocrAll.includes(c.w.toLowerCase())).sort((a, b) => b.w.length - a.w.length)[0];
  return pick || null;
});
console.log('选用搜索词：' + JSON.stringify(word));

if (word) {
  await page.fill('#q', word.w);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: OUT + '/vlm-2-search.png' });

  const geo = await page.evaluate(() => {
    const g = el => { if (!el) return null; const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const tip = document.querySelector('.ocrtip');
    const img = document.querySelector('.imgs img.vlmhit');
    const out = {
      found: (document.getElementById('found') || {}).textContent || '',
      msgs: document.querySelectorAll('.msg').length,
      tips: document.querySelectorAll('.ocrtip').length,
      vlmHits: document.querySelectorAll('.imgs img.vlmhit').length,
      ocrHits: document.querySelectorAll('.imgs img.ocrhit').length,
      marks: document.querySelectorAll('.ocrtip mark').length,
      tip: g(tip), img: g(img),
      tipText: tip ? tip.textContent.slice(0, 90) : '',
      markText: (document.querySelector('.ocrtip mark') || {}).textContent || '',
    };
    if (img) {
      const cs = getComputedStyle(img);
      out.outline = cs.outlineColor + ' / ' + cs.outlineWidth + ' ' + cs.outlineStyle;
    }
    if (tip) {
      const cs = getComputedStyle(tip);
      out.tipStyle = cs.fontSize + ', color ' + cs.color + ', bg ' + cs.backgroundColor;
    }
    return out;
  });
  console.log('搜索结果：' + JSON.stringify(geo, null, 1));

  await page.evaluate(() => {
    const t = document.querySelector('.ocrtip');
    if (t) t.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT + '/vlm-3-zoom.png' });
}

// 深色主题
await page.evaluate(() => {
  const b = document.getElementById('themeBtn');
  if (b) b.click();
});
await page.waitForTimeout(900);
await page.screenshot({ path: OUT + '/vlm-4-dark.png' });

console.log('JS 错误：' + (errs.length ? errs.join(' | ') : '无'));
console.log('截图输出：' + OUT);
await browser.close();
