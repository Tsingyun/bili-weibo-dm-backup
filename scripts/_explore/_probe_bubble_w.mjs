/* 探针：气泡宽度取证（修前 / 修后各跑一次，用 JSON 对比）
   用法：node _probe_bubble_w.mjs <输出.json>
   量什么：
     · 短文本气泡的「白留宽度」= 气泡宽 - 文本宽 - 左右 padding
       （>6px 就是用户说的「两个字的内容、四个字的气泡，后面一段空格」）
     · .plain 气泡（纯图 / 纯卡片）宽度 —— 修 fit-content 时的回归护栏
     · 成因取证：.meta 那一行（昵称+时间）的宽度
*/
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { loadDep } from './_deps.mjs';

const { chromium } = loadDep('playwright');
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = process.argv[2] || path.join(ROOT, 'scripts', '_explore', '_bubble_w.json');

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

const measure = () => page.evaluate(() => {
  const short = [], plain = [], cards = [];
  for (const msg of document.querySelectorAll('.msg')) {
    const b = msg.querySelector('.bubble');
    if (!b) continue;
    const g = getComputedStyle(b);
    const bw = +b.getBoundingClientRect().width.toFixed(2);
    const meta = msg.querySelector('.meta');
    const metaW = meta ? +meta.getBoundingClientRect().width.toFixed(2) : null;
    const isPlain = b.classList.contains('plain');
    const isSys = b.classList.contains('sys');
    if (isSys) continue;
    if (isPlain) { plain.push({ side: msg.className.includes('me') ? 'me' : 'peer', bw, kids: b.children.length, metaW }); continue; }
    if (b.children.length) {
      /* 有子元素 = 卡片类气泡（.links / .wcard 等），单独记 */
      if (b.querySelector('.wcard, .links, .card')) cards.push({ bw, kids: b.children.length });
      continue;
    }
    const txt = b.textContent || '';
    if (!txt.trim()) continue;
    const pl = parseFloat(g.paddingLeft) || 0, pr = parseFloat(g.paddingRight) || 0;
    const r = document.createRange(); r.selectNodeContents(b);
    const tw = +r.getBoundingClientRect().width.toFixed(2);
    short.push({
      t: txt, tl: txt.length, side: msg.className.includes('me') ? 'me' : 'peer',
      bw, tw, pad: pl + pr, leftover: +(bw - tw - pl - pr).toFixed(2), metaW,
    });
  }
  short.sort((a, b) => b.leftover - a.leftover);
  return { short, plain, cards };
});

const out = {};
for (const [src, label] of [['weibo', '微博'], ['bili', 'B站']]) {
  await page.goto(URL_);
  await page.waitForSelector('.msg', { timeout: 20000 });
  if (src !== 'weibo') {
    await page.click(`#srcSw button[data-src="${src}"]`);
    await page.waitForTimeout(900);
  }
  const skin = await page.evaluate(() => document.documentElement.getAttribute('data-skin'));
  const m = await measure();
  const bad = m.short.filter(r => r.leftover > 6);
  out[label] = { skin, ...m, badCount: bad.length };
  console.log(`\n== ${label}（data-skin=${skin}）：纯文本气泡 ${m.short.length} 条，白留>6px 的 ${bad.length} 条`);
  for (const r of m.short.slice(0, 5)) {
    console.log(`   ${JSON.stringify(r.t).padEnd(14)} 气泡${String(r.bw).padStart(7)} 文本${String(r.tw).padStart(7)}` +
      ` 白留${String(r.leftover).padStart(7)} meta宽=${r.metaW}`);
  }
  const p = m.plain.map(x => x.bw);
  console.log(`   .plain 气泡 ${m.plain.length} 个，宽度 min=${Math.min(...p)} max=${Math.max(...p)}`);
  console.log(`   卡片类气泡 ${m.cards.length} 个`);
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log('\n已写入 ' + OUT);
await browser.close();
srv.close();
