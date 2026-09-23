/* 探针：截图导出报 createLinearGradient 非有限值 —— 找出是哪一条消息、哪个值。
   做法：在页面加载前劫持 createLinearGradient，把非法参数与当时的调用栈记下来。 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadDep } from './_deps.mjs';

const { chromium } = loadDep('playwright');
const ROOT = path.resolve(import.meta.dirname, '..', '..');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif' };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const p = path.join(ROOT, u.replace(/^\//, ''));
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    res.end(d);
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__bad = [];
  const P = CanvasRenderingContext2D.prototype;
  for (const fn of ['createLinearGradient', 'createRadialGradient', 'arcTo', 'arc', 'rect', 'fillRect', 'drawImage']) {
    const orig = P[fn];
    P[fn] = function (...a) {
      const bad = a.filter(x => typeof x === 'number' && !Number.isFinite(x));
      if (bad.length) {
        window.__bad.push({ fn, args: a.map(x => (typeof x === 'number' ? x : typeof x)), stack: new Error().stack.split('\n').slice(1, 6).join(' | ') });
      }
      return orig.apply(this, a);
    };
  }
});
page.on('pageerror', e => console.log('  [pageerror] ' + e.message));

await page.goto('http://127.0.0.1:' + PORT + '/查看备份.html');
await page.waitForFunction(() => document.querySelectorAll('#chat .msg').length > 0, null, { timeout: 30000 });
await page.click('#shotBtn');
await page.click('#shotAll');
await page.waitForTimeout(500);
console.log('已选：' + await page.locator('#shotCnt').innerText());

await page.click('#shotGo');
await page.waitForFunction(() => /已生成|失败|没能导出/.test(document.getElementById('shotProg').innerText), null, { timeout: 300000 });
console.log('结果：' + await page.locator('#shotProg').innerText());

const bad = await page.evaluate(() => window.__bad.slice(0, 6));
console.log('\n非法参数调用 ' + bad.length + ' 处（最多显示 6 处）：');
for (const b of bad) {
  console.log('  ' + b.fn + '(' + b.args.join(', ') + ')');
  console.log('     ' + b.stack);
}

// 顺带把每个块的宽高抖出来，看谁不有限
const shapes = await page.evaluate(() => {
  const out = [];
  // 借 preview 的图数量推断页数；真正的块信息只能从 __shotStats 拿
  return { stats: window.__shotStats || null };
});
console.log('\n__shotStats: ' + JSON.stringify(shapes.stats));

await browser.close();
srv.close();
process.exit(0);
