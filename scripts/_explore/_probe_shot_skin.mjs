/**
 * 探针：截图导出模块的皮肤度量表 + 时间分隔条（2026-10-13 微博网页版改版后新增）
 * ------------------------------------------------------------------
 * 不是回归套件（那活儿归 verify_screenshot.mjs），只回答三个问题：
 *   ① 三套皮肤的 SHOT_* 度量常量是否与各自 CSS 对得上（铁律 27：常量是 CSS 的镜子）
 *   ② 导出的块清单里，时间分隔条的条数/文案是否与「一手 isshowmsgtime
 *     （间隔 > 5 分钟、每个逻辑日首条必出）」独立复算一致
 *   ③ 真导出一张图：尺寸对、非空白，并把样图存到 _ref/ 供人工核对样式
 * 跑法：
 *   NODE_PATH=<node workspace>/node_modules node scripts/_explore/_probe_shot_skin.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { loadDep } from './_deps.mjs';

const { chromium } = loadDep('playwright');
const ROOT = path.resolve(import.meta.dirname, '..', '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

/* ---------- 期望值：从真实数据独立复算，不写死 ---------- */
const SESS = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions.json'), 'utf8'));
const first = (Array.isArray(SESS) ? SESS : SESS.sessions || []).find(s => !s.imported);
const relDir = (first.dir || 'data').replace(/\\/g, '/').replace(/\/$/, '');
const MSGS = JSON.parse(fs.readFileSync(path.join(ROOT, relDir, 'messages.json'), 'utf8'));
console.log('=== 数据 ===');
console.log('  ' + relDir + '：' + MSGS.length + ' 条消息');

/* ---------- 起本地静态服务（与 verify_screenshot 同套路） ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' };
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
const PORT = srv.address().port;
const URL_ = 'http://127.0.0.1:' + PORT + '/查看备份.html';
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-shot-'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL_);
await page.waitForFunction(() => document.querySelectorAll('#chat .msg').length > 0, null, { timeout: 30000 });

/* ==================================================================
   勾选前 40 条并真导出一次，后面所有断言都从这次导出读
   ================================================================== */
const bucket = [];
page.on('download', async d => {
  const p = path.join(DL, 'd' + bucket.length + '_' + d.suggestedFilename());
  await d.saveAs(p); bucket.push({ name: d.suggestedFilename(), path: p });
});

await page.click('#shotBtn');
await page.waitForTimeout(400);
// 勾选渲染出来的前 40 条（data-ai = 在 ALL 里的下标；shotPicked 会按下标排序后导出）
const aiList = await page.evaluate(() =>
  [...document.querySelectorAll('#chat .msg[data-ai]')].slice(0, 40).map(e => Number(e.dataset.ai)));
const N = Math.min(40, aiList.length);
for (let i = 0; i < N; i++) await page.locator('#chat .msg > .shotck').nth(i).click();
await page.waitForTimeout(200);
const picked = aiList.slice(0, N).sort((a, b) => a - b);
await page.click('#shotGo');
await page.waitForFunction(() => /已生成|失败|没能导出/.test(document.getElementById('shotProg').innerText), null, { timeout: 180000 });
await page.waitForTimeout(1000);
const stats = await page.evaluate(() => window.__shotStats || null);
ok('导出成功（不是失败）', /已生成/.test(await page.locator('#shotProg').innerText()),
   await page.locator('#shotProg').innerText());
ok('拿到只读快照 __shotStats', !!stats, JSON.stringify(stats && stats.msgs));
ok('勾选的 ' + N + ' 条一条不漏', stats && stats.msgs === N, stats && (stats.msgs + ' vs ' + N));

/* ==================================================================
   ① 度量表：与各自 CSS 逐条对
   ================================================================== */
console.log('\n=== ① 皮肤度量表（SHOT_* ↔ CSS） ===');
{
  const m = stats && stats.metrics;
  console.log('  ' + JSON.stringify(m));
  ok('当前皮肤是 weibo（跟着数据源）', m && m.skin === 'weibo', m && m.skin);
  ok('头像 30px（一手 .avator）', m.av === 30, m.av);
  ok('气泡↔头像 11px（一手 .bubble_cont margin）', m.avGap === 11, m.avGap);
  ok('行距 8px（一手 .message-item）', m.msgMy === 8, m.msgMy);
  ok('气泡内边距 16×11（一手 .card1）', m.bpadX === 16 && m.bpadY === 11, m.bpadX + '×' + m.bpadY);
  ok('气泡最大宽 390px（一手 .bubble_cont max-width）', m.body === 390, m.body);
  ok('行高 20/14（一手 .puretext）', Math.abs(m.lh - 20 / 14) < 1e-9, m.lh);
  ok('正文字号 14px', m.fs === 14, m.fs);
  ok('meta/时间字号 12px', m.fsMeta === 12, m.fsMeta);
  ok('圆角 5px 四角同半径', m.radius === 5, JSON.stringify(m.radius));
  ok('两边都描 1px 边', m.border === true, m.border);
  ok('画气泡尾', m.tail === true, m.tail);
  ok('1:1 不画昵称行', m.meta === false, m.meta);
  ok('时间分隔阈值 5 分钟', m.timeGap === 300000, m.timeGap);
  ok('日期分隔条是居中细字（无药丸）', m.dayPill === false, m.dayPill);
  ok('日期条高 33 = 7+19+7', m.dayH === 33, m.dayH);
  ok('图片上限 240px（一手 .card5 .img-mod）', m.imgMax === 240, m.imgMax);
}

/* ==================================================================
   ② 时间分隔条：一手 isshowmsgtime 独立复算
     规则：created_at==0 不显示；每个逻辑日首条必出；与上一条间隔 > 5 分钟才出
     ================================================================== */
console.log('\n=== ② 时间分隔条（isshowmsgtime） ===');
{
  const kinds = stats.kinds;
  const gotTime = kinds.filter(k => k === 'time').length;
  const gotMsg = kinds.filter(k => k === 'msg').length;
  const gotDay = kinds.filter(k => k === 'day').length;

  // 独立复算（与 render() 的口径逐字对应：换逻辑日重置 lastTs）
  // 逻辑日 = 时间戳减 5 小时后取本机年月日（页面 dayDate/dayKey 的同一条规则）
  const DAY_CUT = 5 * 3600 * 1000;
  const dkey = t => { const d = new Date(t - DAY_CUT); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
  let expTime = 0, last = 0, lastDay = null, expDay = 0;
  for (const ai of picked) {
    const m = MSGS[ai];
    if (!m || !m.ts) continue;
    const dk = dkey(m.ts);
    if (dk !== lastDay) { lastDay = dk; last = 0; expDay++; }
    if (!last || m.ts - last > 300000) expTime++;
    last = m.ts;
  }
  ok('消息块数量 == 勾选数', gotMsg === N, gotMsg + ' / ' + N);
  ok('时间分隔条数量与独立复算一致', gotTime === expTime, gotTime + ' vs ' + expTime);
  ok('日期分隔条数量与独立复算一致', gotDay === expDay, gotDay + ' vs ' + expDay);
  ok('样本里确实出现了时间分隔条（不是空过）', gotTime > 0, gotTime);

  // 文案：前几条标签必须是 HH:mm / 昨天HH:mm / 星期X HH:mm / MM-DD HH:mm / YYYY-MM-DD HH:mm
  const RE = /^(\d{1,2}:\d{2}|昨天\d{1,2}:\d{2}|星期[一二三四五六日]\d{1,2}:\d{2}|\d{2}-\d{2} \d{1,2}:\d{2}|\d{4}-\d{2}-\d{2} \d{1,2}:\d{2})$/;
  ok('时间条文案符合 formatDate 五档格式',
     stats.timeLabels.length === gotTime && stats.timeLabels.every(s => RE.test(s)),
     stats.timeLabels.slice(0, 4).join(' | '));

  // 每个逻辑日首条必须出时间条
  const firstOfDay = new Set();
  let ld = null;
  for (const ai of picked) {
    const m = MSGS[ai];
    if (!m || !m.ts) continue;
    const dk = dkey(m.ts);
    if (dk !== ld) { firstOfDay.add(m.ts); ld = dk; }
  }
  ok('逻辑日首条全部出了时间条', firstOfDay.size <= gotTime, firstOfDay.size + ' 个首条 / ' + gotTime + ' 条');
  console.log('  ' + N + ' 条消息 → ' + gotTime + ' 个时间条 · ' + gotDay + ' 个日期条 · ' +
              (stats.pages) + ' 张');
  console.log('  前几个时间条：' + stats.timeLabels.slice(0, 5).join(' | '));
}

/* ==================================================================
   ③ 真图：尺寸 / 非空白 / 落盘供人工核对
   ================================================================== */
console.log('\n=== ③ 导出产物 ===');
{
  const png = bucket.find(b => b.name.endsWith('.png'));
  ok('下载到 PNG', !!png, bucket.map(b => b.name).join(','));
  if (png) {
    const sz = pngSize(fs.readFileSync(png.path));
    ok('宽度 = 760×2 = 1520（真 2 倍重绘）', sz && sz.w === 1520, sz && (sz.w + '×' + sz.h));
    ok('高度合理', sz && sz.h > 200 && sz.h <= 16000, sz && String(sz.h));
    const keep = path.join(ROOT, '..', '_ref', 'probe_shot_weibo.png');
    try { fs.copyFileSync(png.path, keep); console.log('  样图已存 → ' + keep); }
    catch (e) { console.log('  （样图未存：' + e.message + '）'); }
  }
  ok('全程无 JS 报错', errs.length === 0, errs.join(' | '));
  await page.close();
}

await browser.close();
srv.close();
fs.rmSync(DL, { recursive: true, force: true });

console.log('\n============================================================');
console.log('探针（截图皮肤度量）：通过 ' + pass + ' · 失败 ' + fail + ' · 合计 ' + (pass + fail));
console.log('============================================================');
process.exit(fail ? 1 : 0);
