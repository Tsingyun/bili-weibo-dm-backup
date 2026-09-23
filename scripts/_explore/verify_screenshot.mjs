/**
 * 验证：高清截图导出（多选 → 重新排版 → 分页长图）
 * ------------------------------------------------------------------
 * 这个功能全靠「点一下才发生」，语法过了也可能整段是哑的
 * （比如按钮 id 写错、分页切歪、图根本没画上去）。
 * 所以这里用**真 Chromium** 走完整条链路，并且把真正下载到的文件
 * 拆开来看尺寸：
 *   · PNG  → 手工读 IHDR，断言像素宽高（不是「页面说它导出成功」）
 *   · ZIP  → 手工走 local file header，断言页数与文件名
 *   · 非空白 → 在浏览器里把导出的图重绘到 canvas 上采样，数非同色像素
 * 另外跑一次 file:// 双击场景，确认受限时**照样出图**、并给出正确的提示。
 *
 * 跑法：
 *   NODE_PATH=<node workspace>/node_modules node scripts/_explore/verify_screenshot.mjs
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
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------- 期望值从真实数据算，不写死 ---------- */
const SESS = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions.json'), 'utf8'));
const first = (Array.isArray(SESS) ? SESS : SESS.sessions || []).find(s => !s.imported);
const relDir = (first.dir || 'data').replace(/\\/g, '/').replace(/\/$/, '');
const MSGS = JSON.parse(fs.readFileSync(path.join(ROOT, relDir, 'messages.json'), 'utf8'));
const IMG_MSGS = MSGS.filter(m => (m.images || []).some(i => i.local)).length;
console.log('=== 数据 ===');
console.log('  ' + MSGS.length + ' 条消息，其中含本地图片的 ' + IMG_MSGS + ' 条');

/* ---------- 起一个本地静态服务（模拟 WebUI 的 /viewer） ---------- */
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
const HTTP_URL = 'http://127.0.0.1:' + PORT + '/查看备份.html';
const FILE_URL = 'file:///' + path.join(ROOT, '查看备份.html').replace(/\\/g, '/');
console.log('  本地服务：' + HTTP_URL);

const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-dl-'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });

/* ---------- 工具：解析 PNG 尺寸 / 解析我们自己的 STORE zip ---------- */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function zipEntries(buf) {
  const out = [];
  let o = 0;
  while (o + 30 <= buf.length && buf.readUInt32LE(o) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(o + 26), extra = buf.readUInt16LE(o + 28);
    const size = buf.readUInt32LE(o + 18);
    const name = buf.slice(o + 30, o + 30 + nameLen).toString('utf8');
    out.push({ name, size });
    o += 30 + nameLen + extra + size;
  }
  return out;
}
function collect(page, bucket) {
  page.on('download', async d => {
    try {
      const p = path.join(DL, 'd' + bucket.length + '_' + d.suggestedFilename());
      await d.saveAs(p);
      bucket.push({ name: d.suggestedFilename(), path: p });
    } catch (e) { bucket.push({ name: d.suggestedFilename(), err: e.message }); }
  });
}

async function openPage(url) {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelectorAll('#chat .msg').length > 0, null, { timeout: 30000 });
  return { page, errs };
}

/* 在浏览器里把导出的预览图重绘到 canvas 上采样，判断「不是一张空白图」。
   ⚠ 只数总墨迹比例是不够的：页头和页脚的边框就能凑出 1%，
   于是「分隔条之后整页没画上去」这种 bug 会假绿。
   所以再把整幅按高度切成 10 条横带，要求**几乎每条都有内容** ——
   内容必须一路铺到底，不许只有头尾有东西。 */
async function inkRatio(page) {
  return await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll('#shotGrid .shotcard img')];
    const out = [];
    for (const el of imgs.slice(0, 3)) {
      const im = new Image();
      im.src = el.src;
      await im.decode();
      const c = document.createElement('canvas');
      const W = Math.min(im.naturalWidth, 700), H = Math.min(im.naturalHeight, 1600);
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.drawImage(im, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      const r0 = d[0], g0 = d[1], b0 = d[2];       // 左上角 = 页边距 = 底色
      let diff = 0;
      const BANDS = 10, bandInk = new Array(BANDS).fill(0), bandTot = new Array(BANDS).fill(0);
      for (let y = 0; y < H; y++) {
        const band = Math.min(BANDS - 1, Math.floor(y / (H / BANDS)));
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          bandTot[band]++;
          if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 24) { diff++; bandInk[band]++; }
        }
      }
      const bands = bandInk.filter((v, i) => v / bandTot[i] > 0.004).length;
      out.push({ w: im.naturalWidth, h: im.naturalHeight, ink: diff / (W * H), bands: bands });
    }
    return out;
  });
}
const bandText = a => JSON.stringify(a.map(x => Math.round(x.ink * 1000) / 10 + '%/' + x.bands + '带'));

/* ==================================================================
   ① http:// （= WebUI 的 /viewer）：完整能力，图片应当真的画进去
   ================================================================== */
console.log('\n=== ① 本地服务打开（完整能力） ===');
{
  const bucket = [];
  const { page, errs } = await openPage(HTTP_URL);
  collect(page, bucket);

  const s0 = await page.evaluate(() => ({ proto: location.protocol }));
  ok('页面协议是 http（画布不会被污染）', s0.proto === 'http:', s0.proto);

  // 入口按钮
  ok('侧栏有「📸 截图导出」按钮', await page.locator('#shotBtn').count() === 1);
  await page.click('#shotBtn');
  await page.waitForTimeout(300);
  ok('进入选择模式（body.shot-on）', await page.evaluate(() => document.body.classList.contains('shot-on')));
  ok('底部浮动条出现', await page.evaluate(() => document.getElementById('shotBar').classList.contains('on')));
  ok('http 下不出现「图片合不进去」的受限警告',
     !(await page.evaluate(() => document.getElementById('shotWarn').classList.contains('on'))));

  const msgN = await page.locator('#chat .msg[data-ai]').count();
  const ckN = await page.locator('#chat .msg > .shotck').count();
  ok('每条消息都长出了勾选框', ckN === msgN && msgN > 0, ckN + ' / ' + msgN);
  ok('日期分隔条上有「选这天」', await page.locator('#chat .day .daysel').count() > 0);
  ok('初始计数为 0', /已选\s*0\s*条/.test(await page.locator('#shotCnt').innerText()));

  // 单点勾选
  await page.locator('#chat .msg > .shotck').nth(0).click();
  await page.locator('#chat .msg > .shotck').nth(1).click();
  await page.waitForTimeout(120);
  ok('点两下 → 已选 2 条', /已选\s*2\s*条/.test(await page.locator('#shotCnt').innerText()),
     await page.locator('#shotCnt').innerText());
  ok('选中的消息有高亮类', await page.locator('#chat .msg.shot-picked').count() === 2);
  ok('计数里给出了预计张数', /预计\s*\d+\s*张/.test(await page.locator('#shotCnt').innerText()));

  // Shift 连选
  await page.locator('#chat .msg > .shotck').nth(5).click();
  await page.locator('#chat .msg > .shotck').nth(9).click({ modifiers: ['Shift'] });
  await page.waitForTimeout(120);
  const afterShift = Number((await page.locator('#shotCnt').innerText()).match(/已选\s*(\d+)/)[1]);
  ok('Shift + 点击连选一段（5,6,7,8,9）', afterShift === 7, '已选 ' + afterShift + ' 条（期望 7 = 2 + 5）');

  // 清空
  await page.click('#shotClear');
  await page.waitForTimeout(120);
  ok('清空后归零', /已选\s*0\s*条/.test(await page.locator('#shotCnt').innerText()));
  ok('清空后没有残留高亮', await page.locator('#chat .msg.shot-picked').count() === 0);

  // 「选这天」
  await page.locator('#chat .day .daysel').first().click();
  await page.waitForTimeout(200);
  const dayN = Number((await page.locator('#shotCnt').innerText()).match(/已选\s*(\d+)/)[1]);
  ok('「选这天」选中了若干条', dayN > 0, dayN + ' 条');

  // ---------- 小批量导出：应当恰好 1 张 PNG ----------
  await page.click('#shotClear');
  await page.waitForTimeout(100);
  // 挑一组「至少这一组里有图片」的消息：从第一条含图消息往前取 3 条
  const pickIdx = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#chat .msg[data-ai]')];
    const withImg = els.findIndex(e => e.querySelector('.imgs img[data-ii]'));
    return withImg < 0 ? [0, 1, 2] : [Math.max(0, withImg - 1), withImg, withImg + 1];
  });
  for (const i of pickIdx) await page.locator('#chat .msg > .shotck').nth(i).click();
  await page.waitForTimeout(150);
  const smallN = Number((await page.locator('#shotCnt').innerText()).match(/已选\s*(\d+)/)[1]);

  await page.click('#shotGo');
  await page.waitForFunction(() => /已生成|失败|没能导出/.test(document.getElementById('shotProg').innerText), null, { timeout: 180000 });
  await page.waitForTimeout(1200);
  const progSmall = await page.locator('#shotProg').innerText();
  ok('小批量：显示「已生成」而不是失败', /已生成/.test(progSmall), progSmall);
  ok('小批量：确实产出了 1 张预览', await page.locator('#shotGrid .shotcard').count() === 1);
  const statsSmall = await page.evaluate(() => window.__shotStats || null);
  ok('内部统计：msgs == 勾选数（一条不漏）', statsSmall && statsSmall.msgs === smallN,
     JSON.stringify(statsSmall) + ' vs ' + smallN);
  ok('内部统计：每页条数之和 == 总条数（没有消息被丢掉）',
     statsSmall && statsSmall.perPage.reduce((a, b) => a + b, 0) === statsSmall.msgs);
  ok('内部统计：只有 1 页', statsSmall && statsSmall.pages === 1);

  const pngs = bucket.filter(b => b.name.endsWith('.png'));
  ok('下载到 1 个 PNG', pngs.length === 1, bucket.map(b => b.name).join(', '));
  if (pngs.length) {
    const buf = fs.readFileSync(pngs[0].path);
    const sz = pngSize(buf);
    ok('PNG 是合法文件（IHDR 可解析）', !!sz);
    ok('PNG 宽度 = 760 × 2 = 1520（真·2 倍重绘，不是网页截图放大）', sz && sz.w === 1520, sz && (sz.w + '×' + sz.h));
    ok('PNG 高度合理（一张长图）', sz && sz.h > 200 && sz.h <= 16000, sz && String(sz.h));
    const inks = await inkRatio(page);
    ok('导出的图不是空白（采样到足够多非背景像素）',
       inks.length > 0 && inks.every(x => x.ink > 0.01), bandText(inks));
    ok('内容一路铺到底（10 条横带里至少 8 条有墨迹）',
       inks.length > 0 && inks.every(x => x.bands >= 8), bandText(inks));
    ok('预览图的自然尺寸 == 文件尺寸', inks.length > 0 && inks[0].w === 1520, JSON.stringify(inks[0] || {}));
  }

  // ---------- 大批量：必须自动分成多张 ----------
  await page.click('#shotClose');
  await page.click('#shotClear');
  await page.click('#shotAll');
  await page.waitForTimeout(400);
  const bigN = Number((await page.locator('#shotCnt').innerText()).match(/已选\s*(\d+)/)[1]);
  ok('「全选已显示」选中了整屏消息', bigN > 100, bigN + ' 条');
  ok('预计张数随条数上升', /预计\s*[2-9]\d*\s*张/.test(await page.locator('#shotCnt').innerText()),
     await page.locator('#shotCnt').innerText());

  bucket.length = 0;
  await page.click('#shotGo');
  await page.waitForFunction(() => /已生成|失败|没能导出/.test(document.getElementById('shotProg').innerText), null, { timeout: 600000 });
  await page.waitForTimeout(1500);
  const progBig = await page.locator('#shotProg').innerText();
  ok('大批量：导出成功', /已生成/.test(progBig), progBig);
  const statsBig = await page.evaluate(() => window.__shotStats || null);
  ok('大批量：分成了多张（> 1 页）', statsBig && statsBig.pages > 1, JSON.stringify(statsBig && statsBig.pages));
  ok('大批量：条数守恒（每页之和 == 勾选数）',
     statsBig && statsBig.perPage.reduce((a, b) => a + b, 0) === statsBig.msgs && statsBig.msgs === bigN,
     JSON.stringify(statsBig));
  ok('大批量：单页都没超像素上限', statsBig && statsBig.perPageH.every(h => h * 2 <= 16000),
     JSON.stringify(statsBig && statsBig.perPageH.map(h => h * 2)));

  const zips = bucket.filter(b => b.name.endsWith('.zip'));
  ok('多张时打包成 1 个 zip 下载（避开浏览器的多文件拦截）', zips.length === 1 && bucket.length === 1,
     bucket.map(b => b.name).join(', '));
  if (zips.length) {
    const buf = fs.readFileSync(zips[0].path);
    const ents = zipEntries(buf);
    ok('zip 能被解析出条目（说明写出的是合法 zip）', ents.length > 0, ents.length + ' 条');
    ok('zip 里的张数 == 页数', statsBig && ents.length === statsBig.pages, ents.length + ' vs ' + (statsBig && statsBig.pages));
    ok('zip 内文件名是中文且带页码', ents.every(e => /^截图_.+_第\d+-\d+张\.png$/.test(e.name)),
       ents.map(e => e.name).slice(0, 2).join(' | '));
    // 从 zip 里抠出第一张 PNG 校验尺寸（直接用落盘路径，别靠文件名拼）
    const p0 = fs.readFileSync(zips[0].path);
    let o = 0;
    const nl = p0.readUInt16LE(26), el = p0.readUInt16LE(28), cs = p0.readUInt32LE(18);
    const inner = p0.slice(30 + nl + el, 30 + nl + el + cs);
    const sz2 = pngSize(inner);
    ok('zip 内 PNG 的宽度也是 1520', sz2 && sz2.w === 1520, sz2 && (sz2.w + '×' + sz2.h));
  }
  const inks2 = await inkRatio(page);
  ok('多张里每一张都非空白', inks2.length > 0 && inks2.every(x => x.ink > 0.01), bandText(inks2));
  ok('多张里每一张都一路铺到底（不是只有页头页脚）',
     inks2.length > 0 && inks2.every(x => x.bands >= 8), bandText(inks2));

  // ---------- 「打包成 ZIP」按钮：不重新排版也能再打一次 ----------
  bucket.length = 0;
  await page.click('#shotZip');
  await page.waitForTimeout(2500);
  ok('面板里的「打包成 ZIP」能再导一次', bucket.length === 1 && bucket[0].name.endsWith('.zip'),
     bucket.map(b => b.name).join(', '));

  // ---------- 退出选择模式 ----------
  await page.click('#shotClose');
  await page.click('#shotExit');
  await page.waitForTimeout(200);
  ok('退出后勾选框全部移除', await page.locator('#chat .shotck').count() === 0);
  ok('退出后浮动条收起', !(await page.evaluate(() => document.getElementById('shotBar').classList.contains('on'))));
  ok('全程无 JS 报错', errs.length === 0, errs.join(' | '));
  await page.close();
}

/* ==================================================================
   ② file:// 双击场景：浏览器禁止把本地图画进画布 → 必须「照样出图 + 讲清原因」
   ================================================================== */
console.log('\n=== ② 双击打开（file://）===')
{
  const bucket = [];
  const { page, errs } = await openPage(FILE_URL);
  collect(page, bucket);
  ok('协议是 file:', await page.evaluate(() => location.protocol) === 'file:');

  await page.click('#shotBtn');
  // 探针在进入时会先试一次、700ms 后再试一次（图片可能还没解码完），所以这里等够
  await page.waitForTimeout(1600);
  const warnOn = await page.evaluate(() => document.getElementById('shotWarn').classList.contains('on'));
  const warn = await page.locator('#shotWarn').innerText();
  ok('进选择模式就先给出 ⚠ 提示（不是等导出失败才说）', warnOn && /⚠/.test(warn), warn.slice(0, 90));
  ok('提示里点名了启动器', /高清截图\.cmd/.test(warn), warn.slice(0, 140));

  // 勾 3 条并导出：受限模式下应当**成功**出图（图片位置留占位框）
  for (const i of [0, 1, 2]) await page.locator('#chat .msg > .shotck').nth(i).click();
  await page.waitForTimeout(150);
  await page.click('#shotGo');
  await page.waitForFunction(() => /已生成|失败|没能导出/.test(document.getElementById('shotProg').innerText), null, { timeout: 180000 });
  await page.waitForTimeout(800);
  const prog = await page.locator('#shotProg').innerText();
  ok('受限模式下依然出图（不是丢一句报错）', /已生成/.test(prog), prog);
  ok('并且明确标注「本次未包含图片」', /未包含图片/.test(prog), prog);
  ok('仍然产出了预览', await page.locator('#shotGrid .shotcard').count() >= 1);
  const png = bucket.filter(b => b.name.endsWith('.png'))[0];
  ok('受限模式下也真的下载到了 PNG', !!png, bucket.map(b => b.name).join(', '));
  if (png) {
    const sz = pngSize(fs.readFileSync(png.path));
    ok('受限模式 PNG 宽度仍是 1520', sz && sz.w === 1520, sz && (sz.w + '×' + sz.h));
  }
  const inks = await inkRatio(page);
  ok('受限模式下图也不空白（文字是真的画上去了）', inks.length > 0 && inks[0].ink > 0.01, bandText(inks));
  ok('受限模式下内容也铺到底', inks.length > 0 && inks[0].bands >= 8, bandText(inks));
  ok('全程无 JS 报错', errs.length === 0, errs.join(' | '));
  await page.close();
}

await browser.close();
srv.close();
fs.rmSync(DL, { recursive: true, force: true });

console.log('\n============================================================');
console.log('高清截图导出：通过 ' + pass + ' · 失败 ' + fail + ' · 合计 ' + (pass + fail));
console.log('============================================================');
process.exit(fail ? 1 : 0);
