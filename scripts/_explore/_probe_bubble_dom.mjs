/* 探针2（改）：挑「文本最窄」的气泡 dump 全链，并把切源是否生效一并打出来 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { loadDep } from './_deps.mjs';

const { chromium } = loadDep('playwright');
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif' };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const p = path.join(ROOT, u.replace(/^\//, ''));
  if (!p.startsWith(ROOT)) { res.writeHead(403); res.end('no'); return; }
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    res.end(d);
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const URL_ = 'http://127.0.0.1:' + srv.address().port + '/查看备份.html';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await page.goto(URL_);
await page.waitForSelector('.msg', { timeout: 20000 });

const state = () => page.evaluate(() => ({
  skin: document.documentElement.getAttribute('data-skin'),
  src: document.documentElement.getAttribute('data-src'),
  n: document.querySelectorAll('.msg').length,
  first: (document.querySelector('.msg .bubble') || {}).textContent,
  head: (document.querySelector('.shead .sn') || {}).textContent,
}));
console.log('默认:', JSON.stringify(await state()));
await page.click('#srcSw button[data-src="bili"]').catch(e => console.log('点击失败:', e.message));
await page.waitForTimeout(1200);
console.log('切到B站后:', JSON.stringify(await state()));

const out = await page.evaluate(() => {
  const lines = [];
  const rows = [];
  for (const msg of document.querySelectorAll('.msg')) {
    const b = msg.querySelector('.bubble');
    if (!b) continue;
    if (b.classList.contains('plain') || b.classList.contains('sys')) continue;
    if (b.children.length) continue;
    const raw = b.textContent || '';
    if (!raw.trim()) continue;
    const rng = document.createRange(); rng.selectNodeContents(b);
    rows.push({ msg, b, raw, tw: rng.getBoundingClientRect().width, bw: b.getBoundingClientRect().width });
  }
  rows.sort((a, b2) => a.tw - b2.tw);
  for (const row of rows.slice(0, 2)) {
    const { msg, b, raw } = row;
    lines.push('=== 文本 ' + JSON.stringify(raw) + ' （码点 ' +
      [...raw].map(c => 'U+' + c.codePointAt(0).toString(16)).join(' ') + '）');
    lines.push('  气泡宽=' + row.bw.toFixed(2) + ' 文本宽=' + row.tw.toFixed(2));
    const dump = el => {
      const g = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      lines.push(`  <${el.tagName.toLowerCase()} class="${el.className}"> w=${r.width.toFixed(2)}` +
        ` disp=${g.display} flexBasis=${g.flexBasis} minW=${g.minWidth} width=${g.width}` +
        ` pad=${g.paddingLeft}/${g.paddingRight} box=${g.boxSizing} align=${g.alignItems}`);
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim()) {
          const rng = document.createRange(); rng.selectNodeContents(n);
          lines.push('     #text ' + JSON.stringify(n.textContent).slice(0, 24) +
            ' w=' + rng.getBoundingClientRect().width.toFixed(2));
        }
        if (n.nodeType === 1) dump(n);
      }
    };
    dump(msg);
  }
  return lines.join('\n');
});
console.log(out);
await browser.close();
srv.close();
