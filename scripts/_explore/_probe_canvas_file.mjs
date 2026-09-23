/* 探针：file:// 下能不能把本地图片合成进 canvas 再导出 PNG？
   ------------------------------------------------------------------
   这个答案决定「多选消息高清截图」怎么实现：
     · 能导出 → 纯 canvas 重绘（文字矢量级清晰、想几分页就几分页）
     · 不能   → 必须另找出路（比如用本地 http 服务打开）
   不猜，直接上真 Chromium 试。顺带试三个开关的效果差异。 */
import path from 'node:path';
import { loadDep } from './_deps.mjs';

const { chromium } = loadDep('playwright');
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const IMG = 'data/images/card_10fojji.webp';

const HTML = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<img id="im" src="${IMG}" style="width:80px">
<script>
window.__probe = async function(){
  const out = { protocol: location.protocol, results: {} };
  const im = document.getElementById('im');
  try { await im.decode(); out.results.imgLoaded = [im.naturalWidth, im.naturalHeight]; }
  catch(e){ out.results.imgLoaded = 'ERR ' + e.message; }

  const c = document.createElement('canvas'); c.width = 60; c.height = 60;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 60, 60);
  try { g.drawImage(im, 0, 0, 60, 60); out.results.drawImage = 'ok'; }
  catch(e){ out.results.drawImage = 'ERR ' + e.message; }
  try { g.getImageData(0, 0, 1, 1); out.results.getImageData = 'ok（未污染）'; }
  catch(e){ out.results.getImageData = 'ERR ' + e.name + ': ' + e.message; }
  try { c.toDataURL('image/png'); out.results.toDataURL = 'ok'; }
  catch(e){ out.results.toDataURL = 'ERR ' + e.name + ': ' + e.message; }
  try {
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    out.results.toBlob = b ? ('ok ' + b.size + 'B') : 'null';
  } catch(e){ out.results.toBlob = 'ERR ' + e.name + ': ' + e.message; }

  // 万一 <img> 不行，试试 fetch 能不能读到本地字节
  try { const r = await fetch('${IMG}'); out.results.fetch = r.ok ? 'ok' : ('status ' + r.status); }
  catch(e){ out.results.fetch = 'ERR ' + e.message; }

  // 试试 createImageBitmap（有些实现走另一条路径）
  try { const bl = await (await fetch('${IMG}')).blob(); await createImageBitmap(bl); out.results.createImageBitmap = 'ok'; }
  catch(e){ out.results.createImageBitmap = 'ERR ' + e.message; }
  return out;
};
<\/script></body>`;

// 放在项目根：这样 <img src="data/images/…"> 的相对路径才和真实查看页一致
const PAGE = path.join(ROOT, '_probe_tmp.html');
const fs = await import('node:fs');
fs.writeFileSync(PAGE, HTML, 'utf8');

async function run(label, launchArgs, fileUrl) {
  const browser = await chromium.launch({ args: launchArgs });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(fileUrl);
  await page.waitForTimeout(600);
  let r;
  try { r = await page.evaluate(() => window.__probe()); }
  catch (e) { r = { error: e.message }; }
  console.log('\n=== ' + label + ' ===');
  console.log('  协议: ' + (r.protocol || r.error));
  for (const [k, v] of Object.entries(r.results || {})) console.log('  ' + k.padEnd(18) + ': ' + v);
  if (errs.length) console.log('  页面错误: ' + errs.join(' | '));
  await browser.close();
}

const asFile = 'file:///' + PAGE.replace(/\\/g, '/');
await run('① file:// 默认参数（用户双击的情形）', [], asFile);
await run('② file:// + --allow-file-access-from-files', ['--allow-file-access-from-files'], asFile);

// ③ 本地 http：模拟用本地服务打开
const http = await import('node:http');
const MIME = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.html': 'text/html; charset=utf-8' };
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
const port = srv.address().port;
const htmlRel = path.relative(ROOT, PAGE).replace(/\\/g, '/');
await run('③ http://127.0.0.1（本地服务打开）', [], 'http://127.0.0.1:' + port + '/' + htmlRel);

srv.close();
fs.rmSync(PAGE, { force: true });
process.exit(0);
