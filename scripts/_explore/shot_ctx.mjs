/**
 * 真实 Chromium 渲染「展开上下文」：截图 + 量真实渲染色 + 量净高变化
 */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const DIR = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const OUT = DIR + '/scripts/_explore/shots';
fs.mkdirSync(OUT, { recursive: true });
const url = 'file:///' + DIR + '/查看备份.html';

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(2500);

const TERM = '小岁晚安';
await page.fill('#q', TERM);
await page.waitForTimeout(1500);
console.log('搜索词「' + TERM + '」 → ' + await page.textContent('#found'));

const g = el => { if (!el) return null; const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };

const before = await page.evaluate(() => ({
  openBtns: document.querySelectorAll('[data-ctx="open"]').length,
  ctx: document.querySelectorAll('.msg.ctx').length,
  btnText: (document.querySelector('[data-ctx="open"]') || {}).textContent || '',
}));
console.log('展开前：按钮 ' + before.openBtns + ' 个，上下文 ' + before.ctx + ' 条，按钮文案「' +
  before.btnText.replace(/\s+/g, ' ').trim() + '」');
await page.screenshot({ path: OUT + '/ctx-1-before.png' });

/* 展开中间那条 */
const pickAi = await page.evaluate(() => {
  const bs = [...document.querySelectorAll('[data-ctx="open"]')].map(e => +e.dataset.ai);
  return bs.find(a => a > 200) ?? bs[Math.floor(bs.length / 2)];
});
await page.click(`[data-ctx="open"][data-ai="${pickAi}"]`);
await page.waitForTimeout(900);
console.log('展开会话下标 ' + pickAi + ' 的上下文');

const after = await page.evaluate(ai => {
  const out = {
    ctx: document.querySelectorAll('.msg.ctx').length,
    ctxAis: [...document.querySelectorAll('.msg.ctx')].map(e => +e.dataset.ai),
    hits: document.querySelectorAll('.msg.hit').length,
    hitAi: (document.querySelector('.msg.hit') || {}).dataset?.ai,
    badges: [...document.querySelectorAll('.hitbadge')].map(e => e.textContent),
    bars: [...document.querySelectorAll('.ctxmore')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
    barBtn: [...document.querySelectorAll('.ctxmore button')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
    ctxnum: (document.querySelector('.ctxnum') || {}).textContent || '',
    found: document.getElementById('found').textContent,
    dedup: (() => { const a = [...document.querySelectorAll('.msg')].map(e => e.dataset.ai);
      return a.length === new Set(a).size; })(),
    order: (() => { const a = [...document.querySelectorAll('.msg')].map(e => +e.dataset.ai);
      return a.every((v, i) => i === 0 || a[i - 1] < v); })(),
  };
  const hit = document.querySelector('.msg.hit');
  if (hit) {
    const cs = getComputedStyle(hit);
    const bd = getComputedStyle(hit.querySelector('.body'));
    out.hitStyle = 'bg ' + cs.backgroundColor + ', 描边 ' + cs.boxShadow + ', 圆角 ' + cs.borderRadius;
    out.ctxOpacity = getComputedStyle(document.querySelector('.msg.ctx .body')).opacity;
    out.ctxBorder = getComputedStyle(document.querySelector('.msg.ctx .body')).borderLeftColor +
      ' ' + getComputedStyle(document.querySelector('.msg.ctx .body')).borderLeftWidth;
    out.hitOpacity = bd.opacity;
    out.geo = (() => { const r = hit.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })();
    out.badgeStyle = (() => { const b = document.querySelector('.hitbadge');
      if (!b) return '';
      const s = getComputedStyle(b); return 'bg ' + s.backgroundColor + ', 字色 ' + s.color; })();
  }
  return out;
}, pickAi);
console.log('展开后：' + JSON.stringify(after, null, 1));

await page.evaluate(ai => {
  const el = document.querySelector(`.msg[data-ai="${ai}"]`);
  if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 220);
}, pickAi);
await page.waitForTimeout(500);
await page.screenshot({ path: OUT + '/ctx-2-expanded.png' });

/* 加载更多：各 +5 */
await page.click('[data-ctx="more1"][data-dir="up"]');
await page.waitForTimeout(700);
await page.click('[data-ctx="more1"][data-dir="down"]');
await page.waitForTimeout(700);
const more = await page.evaluate(() => ({
  ctx: document.querySelectorAll('.msg.ctx').length,
  first: Math.min(...[...document.querySelectorAll('.msg.ctx')].map(e => +e.dataset.ai)),
  last: Math.max(...[...document.querySelectorAll('.msg.ctx')].map(e => +e.dataset.ai)),
  barTop: (document.querySelector('.ctxmore') || {}).textContent?.replace(/\s+/g, ' ').trim(),
  ctxnum: (document.querySelector('.ctxnum') || {}).textContent || '',
  found: document.getElementById('found').textContent,
}));
console.log('加载更多后：' + JSON.stringify(more));
await page.screenshot({ path: OUT + '/ctx-3-more.png' });

/* 会话开头边界 */
await page.evaluate(() => { document.getElementById('q').value = ''; });
await page.fill('#q', '');
await page.waitForTimeout(300);
const M = await page.evaluate(() => window.DM_DATA.messages.map(m => (m.text || '').trim()));
const iHead = M.findIndex((t, i) => i < 8 && t.length >= 4);
const tail3 = M[iHead].slice(0, 3);
await page.fill('#q', tail3);
await page.waitForTimeout(1400);
const btnHead = await page.$(`[data-ctx="open"][data-ai="${iHead}"]`);
if (!btnHead) { await page.evaluate(() => document.getElementById('toTop')?.click()); await page.waitForTimeout(700); }
const b2 = await page.$(`[data-ctx="open"][data-ai="${iHead}"]`);
if (b2) {
  await b2.click();
  await page.waitForTimeout(800);
  const edge = await page.evaluate(() => ({
    top: (document.querySelector('.ctxmore') || {}).textContent?.replace(/\s+/g, ' ').trim(),
    hasBtn: !!document.querySelector('.ctxmore button'),
    ctx: document.querySelectorAll('.msg.ctx').length,
  }));
  console.log('会话开头：「' + edge.top + '」，有加载按钮=' + edge.hasBtn + '，上下文 ' + edge.ctx + ' 条');
  await page.screenshot({ path: OUT + '/ctx-4-head.png' });
}

/* 会话末尾边界 */
let iTail = -1;
for (let i = M.length - 1; i >= M.length - 8; i--) if (M[i].length >= 4) { iTail = i; break; }
await page.fill('#q', M[iTail].slice(0, 3));
await page.waitForTimeout(1400);
const bt = await page.$(`[data-ctx="open"][data-ai="${iTail}"]`);
if (bt) {
  await bt.click();
  await page.waitForTimeout(800);
  for (let i = 0; i < 300; i++) {
    const more = await page.$('[data-ctx="more1"][data-dir="down"]');
    if (!more) break;
    await more.click(); await page.waitForTimeout(40);
  }
  const edge = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.ctxmore')];
    const last = bs[bs.length - 1];
    return { bottom: last.textContent.replace(/\s+/g, ' ').trim(), hasBtn: !!last.querySelector('button'),
             last: Math.max(...[...document.querySelectorAll('.msg.ctx')].map(e => +e.dataset.ai)) };
  });
  console.log('会话末尾：「' + edge.bottom + '」，有加载按钮=' + edge.hasBtn +
    '，上下文末条下标 ' + edge.last + ' / 共 ' + (M.length - 1));
  await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.ctxmore')];
    bs[bs.length - 1].scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/ctx-5-tail.png' });
}

/* 深色主题 */
await page.evaluate(() => document.getElementById('themeBtn').click());
await page.waitForTimeout(800);
const dark = await page.evaluate(() => {
  const hit = document.querySelector('.msg.hit');
  return hit ? { bg: getComputedStyle(hit).backgroundColor, shadow: getComputedStyle(hit).boxShadow,
                 badge: getComputedStyle(document.querySelector('.hitbadge')).backgroundColor } : null;
});
console.log('深色主题命中条：' + JSON.stringify(dark));
await page.screenshot({ path: OUT + '/ctx-6-dark.png' });

/* 窄屏 */
await page.setViewportSize({ width: 420, height: 900 });
await page.waitForTimeout(800);
const narrow = await page.evaluate(() => {
  const bar = document.querySelector('.ctxbar');
  const r = bar.getBoundingClientRect();
  return { barW: Math.round(r.width), overflowX: document.documentElement.scrollWidth > window.innerWidth };
});
console.log('窄屏 420px：操作条宽 ' + narrow.barW + '，横向溢出=' + narrow.overflowX);
await page.screenshot({ path: OUT + '/ctx-7-mobile.png', fullPage: false });

console.log('JS 错误：' + (errs.length ? errs.join(' | ') : '无'));
console.log('截图输出：' + OUT);
await browser.close();
