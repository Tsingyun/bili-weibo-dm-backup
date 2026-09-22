// 真实浏览器渲染验证：顶部「微博 / B站」切换条
// 用 Playwright 打开查看页，截图两个视图 + 实测切换行为
import { loadDep } from './_deps.mjs';
import fs from 'fs';
import path from 'path';
import url from 'url';

// playwright 装在 managed workspace，ESM 不认 NODE_PATH，这里显式定位
const { chromium } = loadDep('playwright');

const ROOT = path.resolve(process.cwd());
const HTML = path.join(ROOT, '查看备份.html');
const OUT = path.join(ROOT, 'scripts', '_explore', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const chk = (ok, name, detail = '') => {
  results.push({ ok, name, detail });
  console.log((ok ? '  [ok] ' : '  [!!] ') + name + (detail ? '  — ' + detail : ''));
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errs = [];
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(url.pathToFileURL(HTML).href, { waitUntil: 'load' });
await page.waitForTimeout(1200);

// ---- 1) 切换条存在且可见 ----
const sw = page.locator('#srcSw');
chk(await sw.count() === 1, '顶部切换条 #srcSw 存在');
chk(await sw.isVisible(), '切换条可见');

const btns = page.locator('#srcSw button');
const n = await btns.count();
const labels = [];
for (let i = 0; i < n; i++) labels.push((await btns.nth(i).innerText()).replace(/\s+/g, ' ').trim());
console.log('    按钮:', JSON.stringify(labels));
chk(n === 2, '恰好两个来源按钮', labels.join(' | '));

const texts = labels.join('');
chk(texts.includes('微博'), '含「微博」按钮');
chk(texts.includes('B'), '含「B站」按钮');

// ---- 2) 默认落在微博视图 ----
const activeLabel = async () => {
  for (let i = 0; i < n; i++) {
    if ((await btns.nth(i).getAttribute('aria-pressed')) === 'true') {
      return (await btns.nth(i).innerText()).replace(/\s+/g, ' ').trim();
    }
  }
  return '';
};
const firstActive = await activeLabel();
chk(firstActive.includes('微博'), '默认选中微博', firstActive);

const wCount = await page.locator('.msg, .bubble, .wcard').count();
chk(wCount > 0, '微博视图渲染出气泡', wCount + ' 个');
await page.screenshot({ path: path.join(OUT, '01-weibo.png') });

// ---- 3) 切到 B站 ----
await btns.nth(1).click();
await page.waitForTimeout(900);
const afterB = await activeLabel();
chk(afterB.includes('B'), '点击后切到 B站', afterB);

const emptyHint = await page.locator('body').innerText();
// 2026-09-15 起 B站已有真实备份，所以这里要分两种情况都能过：
//   有数据 → 必须真的渲染出 B站气泡；无数据 → 必须给出引导文案。
const biliMsgs = await page.evaluate(() => (((window.DM_DATA_B || {}).messages) || []).length);
if (biliMsgs > 0) {
  const bBubbles = await page.locator('.msg .bubble, .msg .bcard, .wcard').count();
  chk(bBubbles > 0, 'B站有数据时渲染出气泡', biliMsgs + ' 条数据 → ' + bBubbles + ' 个气泡');
  await page.screenshot({ path: path.join(OUT, '02-bili-real.png') });
} else {
  const hasGuide = /更新B站备份|还没有|未生成|请先/.test(emptyHint);
  chk(hasGuide, 'B站无数据时给出引导文案');
  await page.screenshot({ path: path.join(OUT, '02-bili-empty.png') });
}

// ---- 4) 切回微博，确认没有监听器叠加 ----
for (let round = 0; round < 3; round++) {
  await btns.nth(0).click(); await page.waitForTimeout(250);
  await btns.nth(1).click(); await page.waitForTimeout(250);
}
await btns.nth(0).click();
await page.waitForTimeout(800);
const wCount2 = await page.locator('.msg, .bubble, .wcard').count();
chk(wCount2 === wCount, '来回切换 3 轮后气泡数不叠加', wCount + ' → ' + wCount2);

const activeFinal = await activeLabel();
chk(activeFinal.includes('微博'), '最终回到微博视图', activeFinal);
await page.screenshot({ path: path.join(OUT, '03-back-to-weibo.png') });

// ---- 5) 无 JS 报错（忽略可选数据集缺失）----
const real = errs.filter(e => !/Could not load|Failed to load resource|net::ERR_FILE_NOT_FOUND/i.test(e));
chk(real.length === 0, '页面无 JS 报错', real.slice(0, 3).join(' ; ') || '干净');

await browser.close();

const pass = results.filter(r => r.ok).length;
console.log('\n========================================');
console.log('  通过 ' + pass + ' / ' + results.length);
console.log('  截图目录: ' + OUT);
console.log('========================================');
process.exit(pass === results.length ? 0 : 1);
