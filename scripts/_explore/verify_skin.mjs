/**
 * 验证：页面风格皮肤（原版 / 微博 / B站）
 * ------------------------------------------------------------------
 * 这个功能的卖点就是「看起来像原站」，所以断言不能只写「按钮点了有反应」——
 * 必须把**真实计算样式**量出来，跟一手前端产物里的规格逐条对上：
 *
 *   微博 api.weibo.com/chat/ 的 pcweibochat 样式包：
 *     .content{background:#fafafa;border-radius:4px;padding:6px 10px;
 *              line-height:24px;font-size:14px}
 *     .self .content{background-color:#b2e281}
 *     .self .content:before{border-left-color:#b2e281}
 *     .message-main .avatar{border-radius:3px}
 *     .time span{background-color:#dcdcdc}
 *     .chatbox .msglist{background:#33353a}
 *   B站 message.bilibili.com 的 message-pc 样式包：
 *     ._MsgTextIsMe_{background:#00aeec;color:#fff;border-radius:16px 0 16px 16px}
 *     ._MsgText_{background:#fff;border-radius:0 16px 16px;padding:8px 16px}
 *     ._Msg__Avatar{border-radius:50%;width:30px;height:30px}
 *     --bg3:#f1f2f3  --text1:#18191c
 *
 * 另外三件容易被漏掉的事，这里都单独守：
 *   · 对比度用 WCAG 公式**算**出来（不是看颜色值顺眼）——包括那个
 *     「原站白字压 #dcdcdc 只有 1.37:1」的地方，我们保留形状但换了深字。
 *   · 「原版」必须原样还在（万一皮肤把基础样式改坏了）。
 *   · 会话头不是 .msg，绝不能混进多选与高清截图。
 *
 * 跑法：
 *   NODE_PATH=<node workspace>/node_modules node scripts/_explore/verify_skin.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadDep } from './_deps.mjs';

const { chromium } = loadDep('playwright');
const ROOT = path.resolve(import.meta.dirname, '..', '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
function head(t) { console.log('\n' + t); }

/* ---------- 期望值从真实数据算，不写死 ---------- */
/* ⚠ 这里只读「结构性字段」，不打印任何昵称 / uid */
const SESS = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions.json'), 'utf8'));
const LIST = (Array.isArray(SESS) ? SESS : SESS.sessions || []).filter(s => !s.imported);
const SRC_KEYS = LIST.map(s => s.key);
const dirOf = k => ((LIST.find(s => s.key === k) || {}).dir || '');
const metaOf = k => JSON.parse(fs.readFileSync(
  path.join(ROOT, dirOf(k).replace(/\\/g, '/'), 'meta.json'), 'utf8'));

/* 期望的自动匹配结果：照实现里的判据重算一遍（而不是 import 页面代码） */
const expectSkin = key => (/bili|b站|哔哩/i.test(key) ? 'bili' : 'weibo');
/* 找一对「有正文」的我方 / 对方气泡，供量样式用 */
const ME_BUB = '.msg.me .bubble:not(.plain):not(.sys)';
const PEER_BUB = '.msg:not(.me) .bubble:not(.plain):not(.sys)';

/* ---------- 本地静态服务 ---------- */
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
const URL_ = 'http://127.0.0.1:' + srv.address().port + '/查看备份.html';

console.log('=== 环境 ===');
console.log('  数据源：' + SRC_KEYS.join(' / ') + '（共 ' + SRC_KEYS.length + ' 个）');

const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
const page = await ctx.newPage();

/* ---------- 颜色工具：WCAG 对比度 ---------- */
const rgbNums = s => (String(s).match(/[\d.]+/g) || []).map(Number).slice(0, 3);
function lum(nums) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(nums[0]) + 0.7152 * f(nums[1]) + 0.0722 * f(nums[2]);
}
function contrast(fg, bg) {
  const a = lum(rgbNums(fg)), b = lum(rgbNums(bg));
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
const R = n => Math.round(n * 100) / 100;

/* ---------- 取计算样式 ---------- */
const css = (page, sel, props, pseudo) => page.evaluate(([sel, props, pseudo]) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const g = getComputedStyle(el, pseudo || null);
  const o = {};
  for (const p of props) o[p] = g[p];
  return o;
}, [sel, props, pseudo]);

const skinAttr = page => page.evaluate(() => document.documentElement.getAttribute('data-skin'));
const rootVar = (page, v) => page.evaluate(n =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim(), v);

/* ⚠ rootVar 拿到的是**原样的 token 字符串**（'#00699d'），不是计算后的颜色，
   直接喂给对比度公式会得到 NaN。要算对比度必须先挂到一个元素上让它 resolve 成 rgb()。 */
const resolveVar = (page, name) => page.evaluate(n => {
  const d = document.createElement('div');
  d.style.cssText = 'position:absolute;opacity:0;background:var(' + n + ')';
  document.body.appendChild(d);
  const v = getComputedStyle(d).backgroundColor;
  d.remove();
  return v;
}, name);

/* 「居中」用几何量判：.day 是 flex 容器，居中体现在 justify-content 上，
   text-align 算出来是 start —— 量子节点组的中点与 .day 中点的偏差最诚实。 */
const dayCenterDelta = page => page.evaluate(() => {
  const d = document.querySelector('.day');
  if (!d) return -1;
  const kids = [...d.children].filter(k => getComputedStyle(k).display !== 'none');
  if (!kids.length) return -1;
  const rs = kids.map(k => k.getBoundingClientRect());
  const l = Math.min(...rs.map(r => r.left)), r2 = Math.max(...rs.map(r => r.right));
  const dr = d.getBoundingClientRect();
  return Math.abs((l + r2) / 2 - (dr.left + dr.right) / 2);
});

async function gotoSrc(key) {
  await page.click(`#srcSw button[data-src="${key}"]`);
  await page.waitForTimeout(260);
}
async function goSkin(s) {
  await page.click(`#skinSw button[data-skin="${s}"]`);
  await page.waitForTimeout(180);
}

await page.goto(URL_);
await page.waitForTimeout(500);

/* ============================================================
   1. 入口与自动匹配
   ============================================================ */
head('=== 1. 切换控件与「跟随数据源自动匹配」 ===');
{
  const btns = await page.$$eval('#skinSw button[data-skin]', ns => ns.map(n => n.dataset.skin));
  ok('侧栏有页面风格控件，三个选项 = 原版 / 仿微博 / 仿B站',
    JSON.stringify(btns) === JSON.stringify(['plain', 'weibo', 'bili']), JSON.stringify(btns));

  const nSrc = await page.$$eval('#srcSw button[data-src]', ns => ns.length);
  ok('数据源切换没被挤掉（仍是 ' + SRC_KEYS.length + ' 个）', nSrc === SRC_KEYS.length, nSrc);

  /* ---- 用户反馈：两排胶囊紧挨着、都叫「微博 / B站」，分不清哪个是切数据、哪个是换样子。
     下面四条把这个坑钉住：位置分开、有标题说明、选项改过名、每项有 tooltip。 ---- */
  const lbl = await page.$eval('#skinSw', n => {
    const box = n.closest('.skinbox');
    const l = box && box.querySelector('.skin-lbl');
    return { box: !!box, txt: l ? l.textContent.replace(/\s+/g, '') : '' };
  });
  ok('风格切换有可见标题与说明（不再是两排无字胶囊）',
    lbl.box && lbl.txt.indexOf('页面风格') >= 0 && lbl.txt.indexOf('只换样子') >= 0, lbl.txt);

  const names = await page.$$eval('#skinSw button[data-skin]', ns => ns.map(n => n.textContent.trim()));
  const srcNames = await page.$$eval('#srcSw button[data-src]', ns => ns.map(n => n.textContent.trim()));
  ok('风格选项改名成 原版 / 仿微博 / 仿B站（不再与数据源同名，光看字就分得开）',
    JSON.stringify(names) === JSON.stringify(['原版', '仿微博', '仿B站'])
      && !names.some(t => srcNames.indexOf(t) >= 0),
    JSON.stringify(names) + ' vs 数据源 ' + JSON.stringify(srcNames));

  const geo = await page.evaluate(() => {
    const a = document.querySelector('#srcSw').getBoundingClientRect();
    const b = document.querySelector('#skinSw').getBoundingClientRect();
    const mid = document.querySelector('.side-top');
    const r = mid && mid.getBoundingClientRect();
    /* 两块之间必须夹着标题行，而且垂直净距够大 —— 挨着摆才容易认错 */
    return { gap: Math.round(b.top - a.bottom), between: !!(r && r.top >= a.bottom - 1 && r.bottom <= b.top + 1) };
  });
  ok('位置上分开了（中间夹着标题行，垂直净距 ' + geo.gap + 'px ≥ 20）',
    geo.between && geo.gap >= 20, '夹着 title 行？' + geo.between + ' / 净距 ' + geo.gap);

  const tips = await page.$$eval('#skinSw button[data-skin]', ns => ns.map(n => (n.title || '').length));
  ok('每个风格选项都有 title 说明（鼠标停一下就知道是干什么的）',
    tips.length === 3 && tips.every(n => n >= 8), JSON.stringify(tips));

  const cur = await page.$eval('#srcSw button[aria-pressed="true"]', n => n.dataset.src);
  ok('首屏皮肤 = 按当前数据源自动匹配（' + cur + ' → ' + expectSkin(cur) + '）',
    (await skinAttr(page)) === expectSkin(cur), await skinAttr(page));

  /* 切到另一个源，皮肤要跟着走 */
  const other = SRC_KEYS.find(k => k !== cur);
  if (other) {
    await gotoSrc(other);
    ok('切到另一个数据源后皮肤跟着变（' + other + ' → ' + expectSkin(other) + '）',
      (await skinAttr(page)) === expectSkin(other), await skinAttr(page) + ' / 当前源 ' + other);
    await gotoSrc(cur);
  } else {
    ok('只有一个数据源，跳过「切源跟随」检查', true);
  }

  /* 手动选过的一直算数 */
  await goSkin('plain');
  ok('点「原版」→ data-skin=plain', (await skinAttr(page)) === 'plain', await skinAttr(page));
  await gotoSrc(other || cur);
  ok('手动选过之后，切数据源不再改变皮肤（用户说了算）',
    (await skinAttr(page)) === 'plain', await skinAttr(page));
  await gotoSrc(cur);
  await goSkin(expectSkin(cur));
}

/* ============================================================
   2. 仿站会话头
   ============================================================ */
head('=== 2. 仿站会话头（含「本地备份」标记）===');
{
  const cur = await page.$eval('#srcSw button[aria-pressed="true"]', n => n.dataset.src);
  const skin = expectSkin(cur);
  const meta = metaOf(cur);

  const d = await css(page, '.shead', ['display']);
  ok('皮肤模式下会话头出现（display=' + (d && d.display) + '）', d && d.display === 'flex', d && d.display);

  const sn = await page.$eval('.shead .sn', n => n.textContent.trim()).catch(() => null);
  ok('会话头里的名字 == 该数据源 meta 里的对方昵称（不写死，长度 ' + String(meta.peer_name || '').length + '）',
    sn === (meta.peer_name || '对方'));

  const stag = await page.$eval('.shead .stag', n => n.textContent.trim()).catch(() => null);
  ok('会话头带「本地备份」标记（不冒充真实站点）', !!stag && stag.indexOf('本地备份') >= 0, stag);

  const mixed = await page.evaluate(() => document.querySelectorAll('.shead.msg, .msg .shead').length);
  ok('会话头不是 .msg（不会被当成一条消息）', mixed === 0, mixed);

  /* 进多选模式：勾选框数量必须与消息数一一对应，会话头不能多出一个 */
  await page.click('#shotBtn');
  await page.waitForTimeout(400);
  const ck = await page.evaluate(() => ({
    boxes: document.querySelectorAll('#chat .shotck').length,
    msgs: document.querySelectorAll('#chat .msg[data-ai]').length,
  }));
  ok('进多选模式后：勾选框数 == 消息数（会话头没被算进去）',
    ck.boxes === ck.msgs && ck.msgs > 0, `勾选框 ${ck.boxes} / 消息 ${ck.msgs}`);
  await page.click('#shotExit');
  await page.waitForTimeout(200);
}

/* ============================================================
   3. 微博皮肤：逐条对上一手规格
   ============================================================ */
head('=== 3. 微博皮肤（照 pcweibochat 一手规格逐条对）===');
{
  await goSkin('weibo');
  await page.waitForTimeout(150);

  const me = await css(page, ME_BUB, ['backgroundColor', 'color', 'borderRadius', 'paddingTop',
    'paddingLeft', 'lineHeight', 'fontSize', 'borderTopWidth']);
  ok('我方气泡底色 = #b2e281（一手 .self .content{background-color:#b2e281}）',
    me && me.backgroundColor === 'rgb(178, 226, 129)', me && me.backgroundColor);
  ok('我方气泡圆角 = 4px（一手 .content{border-radius:4px}）',
    me && me.borderRadius === '4px', me && me.borderRadius);
  ok('我方气泡内边距 = 6px 10px（一手 .content{padding:6px 10px}）',
    me && me.paddingTop === '6px' && me.paddingLeft === '10px',
    me && me.paddingTop + ' ' + me.paddingLeft);
  ok('我方气泡行高 24px / 字号 14px（一手 .content{line-height:24px;font-size:14px}）',
    me && me.lineHeight === '24px' && me.fontSize === '14px',
    me && me.lineHeight + ' / ' + me.fontSize);
  ok('我方气泡没有边框（一手没有 border）',
    me && me.borderTopWidth === '0px', me && me.borderTopWidth);

  const peer = await css(page, PEER_BUB, ['backgroundColor', 'borderRadius']);
  ok('对方气泡底色 = #fafafa（一手 .content{background:#fafafa}）',
    peer && peer.backgroundColor === 'rgb(250, 250, 250)', peer && peer.backgroundColor);
  ok('对方气泡圆角 = 4px', peer && peer.borderRadius === '4px', peer && peer.borderRadius);

  /* 小三角是用 ::after 的 border 画的。
     ⚠ 判定「画没画」只能看 content：探针实测**非生成**伪元素的 computed display 是
     inline 而不是 none，所以写成 display!=='none' 的断言永远不会失败（等于没断言）。 */
  const tri = await css(page, ME_BUB, ['content', 'borderLeftColor', 'borderLeftWidth'], '::after');
  ok('我方气泡右侧小三角：6px、颜色 = 气泡底色'
    + '（一手 .self .content:before{right:-12px;border:6px solid transparent;border-left-color:#b2e281}）',
    tri && tri.content !== 'none' && tri.borderLeftColor === 'rgb(178, 226, 129)'
      && tri.borderLeftWidth === '6px',
    tri && [tri.content, tri.borderLeftColor, tri.borderLeftWidth].join(' / '));

  const ptri = await css(page, PEER_BUB, ['content', 'borderRightColor', 'borderRightWidth'], '::after');
  ok('对方气泡左侧也有小三角：颜色 = 对方气泡底色 #fafafa'
    + '（一手 .content:before{right:100%;border-right-color:#fafafa}）',
    ptri && ptri.content !== 'none' && ptri.borderRightColor === 'rgb(250, 250, 250)'
      && ptri.borderRightWidth === '6px',
    ptri && [ptri.content, ptri.borderRightColor, ptri.borderRightWidth].join(' / '));

  /* 反向验证：透明无框的气泡（.plain / .sys）**不能**挂小三角 */
  const tails = await page.evaluate(() => {
    /* ⚠ 本屏可能一条 .plain / .sys 都没有（实测就是 0 条）—— 那样这条断言就白过了。
       所以除了数真实样本，再**人造**两个样本：克隆一条现有气泡、挂上类名再量一次。 */
    const SEL = '.msg .bubble.plain, .msg .bubble.sys';
    const count = () => {
      const ns = [...document.querySelectorAll(SEL)];
      let drawn = 0;
      ns.forEach(n => { if (getComputedStyle(n, '::after').content !== 'none') drawn++; });
      return { total: ns.length, drawn };
    };
    const real = count();
    const host = document.querySelector('.msg.me');
    const bub = host && host.querySelector('.bubble');
    let made = 0, probe = 0;
    if (bub) {
      ['plain', 'sys'].forEach(cls => {
        const c = bub.cloneNode(true);
        c.classList.add(cls);
        host.appendChild(c);
        made++;
        if (getComputedStyle(c, '::after').content !== 'none') probe++;
        c.remove();
      });
    }
    return { total: real.total, drawn: real.drawn, made, probe };
  });
  ok('透明气泡（.plain / .sys）上不挂小三角（本屏真实 ' + tails.total + ' 条 + 人造样本 '
    + tails.made + ' 条，都没挂）', tails.drawn === 0 && tails.made === 2 && tails.probe === 0,
    '真实挂 ' + tails.drawn + ' 条 / 人造挂 ' + tails.probe + ' 条');

  /* 头像→气泡的间距：一手对方 10px、我方 15px */
  const gapP = await css(page, '.msg:not(.me)', ['columnGap']);
  const gapM = await css(page, '.msg.me', ['columnGap']);
  ok('间距照一手（对方 10px / 我方 15px；一手 .content{margin-left:10px}、.self .avatar{margin:0 15px}）',
    gapP && gapP.columnGap === '10px' && gapM && gapM.columnGap === '15px',
    (gapP && gapP.columnGap) + ' / ' + (gapM && gapM.columnGap));

  const av = await css(page, '.msg .av', ['borderRadius', 'width', 'height']);
  ok('头像是圆角方 3px / 30px（一手 .avatar{border-radius:3px}，不是圆）',
    av && av.borderRadius === '3px' && av.width === '30px',
    av && av.borderRadius + ' / ' + av.width);

  const day = await css(page, '.day span', ['backgroundColor', 'borderTopWidth',
    'paddingTop', 'paddingLeft', 'borderRadius']);
  const dayLine = await css(page, '.day', ['display'], '::before');
  ok('日期分隔条 = 灰底药丸 #dcdcdc、3px 圆角、内边距 4px 6px'
    + '（一手 .time span{padding:4px 6px;border-radius:3px;background-color:#dcdcdc}）',
    day && day.backgroundColor === 'rgb(220, 220, 220)' && day.borderTopWidth === '0px'
      && day.paddingTop === '4px' && day.paddingLeft === '6px' && day.borderRadius === '3px',
    day && [day.backgroundColor, day.paddingTop, day.paddingLeft, day.borderRadius].join(' / '));
  ok('日期分隔条去掉了横线（原站没有横线）',
    dayLine && dayLine.display === 'none', dayLine && dayLine.display);

  const dayM = await css(page, '.day', ['marginTop', 'marginBottom']);
  ok('日期分隔条上下间距 7px（一手 .time{margin:7px auto}）',
    dayM && dayM.marginTop === '7px' && dayM.marginBottom === '7px',
    dayM && dayM.marginTop + ' / ' + dayM.marginBottom);

  const sb = await css(page, '.sidebar', ['backgroundColor']);
  ok('侧栏 = 深色会话列表 #33353a（一手 .chatbox .msglist{background:#33353a}）',
    sb && sb.backgroundColor === 'rgb(51, 53, 58)', sb && sb.backgroundColor);
}

/* ============================================================
   4. B站皮肤：逐条对上一手规格
   ============================================================ */
head('=== 4. B站皮肤（照 message-pc 一手规格逐条对）===');
{
  await goSkin('bili');
  await page.waitForTimeout(150);

  const me = await css(page, ME_BUB, ['backgroundColor', 'color', 'borderRadius', 'paddingTop', 'paddingLeft', 'fontSize']);
  ok('我方气泡 = 实心品牌蓝 #00aeec（一手 ._MsgTextIsMe_{background:var(--brand_blue)}）',
    me && me.backgroundColor === 'rgb(0, 174, 236)', me && me.backgroundColor);
  ok('我方气泡文字 = 白色（一手 color:var(--text_white)）',
    me && me.color === 'rgb(255, 255, 255)', me && me.color);
  ok('我方气泡圆角 = 16px 0 16px 16px（一手：右上切角）',
    me && me.borderRadius === '16px 0px 16px 16px', me && me.borderRadius);
  ok('我方气泡内边距 = 8px 16px（一手 ._MsgText_{padding:8px 16px}）',
    me && me.paddingTop === '8px' && me.paddingLeft === '16px',
    me && me.paddingTop + ' ' + me.paddingLeft);

  const peer = await css(page, PEER_BUB, ['backgroundColor', 'borderRadius', 'paddingLeft']);
  ok('对方气泡 = 白底（一手 ._MsgText_{background:var(--bg1)}）',
    peer && peer.backgroundColor === 'rgb(255, 255, 255)', peer && peer.backgroundColor);
  ok('对方气泡圆角 = 0 16px 16px（一手：左上切角）',
    peer && peer.borderRadius === '0px 16px 16px', peer && peer.borderRadius);

  const av = await css(page, '.msg .av', ['borderRadius', 'width', 'height']);
  ok('头像 = 30px 正圆（一手 ._Msg__Avatar{border-radius:50%;width:30px;height:30px}）',
    av && av.borderRadius === '50%' && av.width === '30px' && av.height === '30px',
    av && av.borderRadius + ' / ' + av.width);

  const meta = await css(page, '.msg .meta', ['fontSize', 'color']);
  ok('昵称在气泡上方、13px 浅灰（一手 ._Msg__SenderName{font-size:13px;color:var(--text3)}）',
    meta && meta.fontSize === '13px' && meta.color === 'rgb(148, 153, 160)',
    meta && meta.fontSize + ' / ' + meta.color);

  const day = await css(page, '.day', ['fontSize', 'justifyContent', 'paddingTop', 'paddingBottom']);
  const dayLine = await css(page, '.day', ['display'], '::before');
  const dOff = await dayCenterDelta(page);
  ok('日期分隔条居中（实测偏离中心 ' + R(dOff) + 'px）、12px、上下留白 16px、无横线'
    + '（一手 ._Msg__Time{text-align:center;padding:16px 0;font-size:12px}）',
    day && day.justifyContent === 'center' && day.fontSize === '12px'
      && day.paddingTop === '16px' && day.paddingBottom === '16px'
      && dayLine && dayLine.display === 'none' && dOff >= 0 && dOff <= 2,
    day && [day.justifyContent, day.fontSize, day.paddingTop, dayLine && dayLine.display,
      R(dOff)].join(' / '));

  const gapB = await css(page, '.msg.me', ['columnGap']);
  ok('头像→气泡间距 10px（一手 ._Msg__Avatar{margin-right:10px}）',
    gapB && gapB.columnGap === '10px', gapB && gapB.columnGap);

  ok('页面底色 = #f1f2f3（一手 --bg3）', (await rootVar(page, '--bg')) === '#f1f2f3',
    await rootVar(page, '--bg'));
  ok('正文色 = #18191c（一手 --text1）', (await rootVar(page, '--text')) === '#18191c',
    await rootVar(page, '--text'));
}

/* ============================================================
   5. 「原版」必须原样还在
   ============================================================ */
head('=== 5. 切回「原版」后一切照旧 ===');
{
  await goSkin('plain');
  await page.waitForTimeout(150);

  const me = await css(page, ME_BUB, ['backgroundImage', 'borderTopRightRadius', 'borderTopLeftRadius']);
  ok('原版我方气泡仍是渐变底（--me 是 linear-gradient）',
    me && /linear-gradient/.test(me.backgroundImage), me && me.backgroundImage.slice(0, 40));
  ok('原版我方气泡圆角仍是 14px/5px 那套',
    me && me.borderTopRightRadius === '5px' && me.borderTopLeftRadius === '14px',
    me && me.borderTopLeftRadius + ' / ' + me.borderTopRightRadius);

  const dayLine = await css(page, '.day', ['display'], '::before');
  ok('原版日期分隔条的横线回来了', dayLine && dayLine.display !== 'none', dayLine && dayLine.display);

  const d = await css(page, '.shead', ['display']);
  ok('原版不出现会话头（DOM 里根本没渲染，或 display:none）',
    !d || d.display === 'none', d ? d.display : '未渲染');

  const av = await css(page, '.msg .av', ['borderRadius']);
  ok('原版头像恢复成正圆/34px 那套（border-radius=' + (av && av.borderRadius) + '）',
    av && av.borderRadius === '50%', av && av.borderRadius);

  /* 反向验证：皮肤那条 .stats 规则不能漏到原版来 */
  const sOrig = await css(page, '.stats', ['color']);
  ok('原版侧栏汇总正文保持原样（基础 --muted #8b939c，皮肤规则没漏出来）',
    sOrig && sOrig.color === 'rgb(139, 147, 156)', sOrig && sOrig.color);
}

/* ============================================================
   6. 对比度：算出来，不是看顺眼
   ============================================================ */
head('=== 6. 对比度（WCAG 实算）===');
{
  /* 先做一条自检：公式本身要对（白/黑 = 21:1） */
  ok('对比度公式自检：白字压黑底 = 21:1', contrast('rgb(255,255,255)', 'rgb(0,0,0)') === 21,
    contrast('rgb(255,255,255)', 'rgb(0,0,0)'));

  await goSkin('weibo');
  await page.waitForTimeout(150);
  {
    const me = await css(page, ME_BUB, ['color', 'backgroundColor']);
    const c = contrast(me.color, me.backgroundColor);
    ok('微博 · 我方气泡文字 vs 气泡底 ≥ 4.5（实测 ' + c + ':1）', c >= 4.5, c);

    const day = await css(page, '.day span', ['color', 'backgroundColor']);
    const cd = contrast(day.color, day.backgroundColor);
    ok('微博 · 日期药丸 ≥ 4.5（原站是白字压 #dcdcdc = 1.37:1，这里保留形状换深字；实测 ' + cd + ':1）',
      cd >= 4.5, cd);

    const st = await css(page, '.stats', ['color']);
    const sb = await css(page, '.sidebar', ['backgroundColor']);
    const cs = contrast(st.color, sb.backgroundColor);
    ok('微博 · 侧栏汇总正文 vs 深色侧栏底 ≥ 4.5（实测 ' + cs + ':1）', cs >= 4.5, cs);

    /* ⚠ 别只挑自己想到的选择器 —— 上一轮就是这么漏掉品牌行的：
       只量了 .stats，而 .brand / #title 因为「自己不声明 color、靠继承」拿到的是
       body 上算完的 #2b333f，压在深色侧栏上 1.04:1（等于看不见）。
       这里改成**系统扫**：侧栏里所有带直接文字的节点，逐个量对比度取最小值。 */
    const sweep = await page.evaluate(() => {
      const parse = s => (String(s).match(/[\d.]+/g) || []).map(Number).slice(0, 3);
      const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      const ratio = (a, b) => { const A = lum(parse(a)), B = lum(parse(b));
        const hi = Math.max(A, B), lo = Math.min(A, B); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };
      const bgOf = el => { let n = el; while (n && n !== document.documentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg; n = n.parentElement; }
        return 'rgb(255,255,255)'; };
      const sb = document.querySelector('.sidebar'), sbr = sb.getBoundingClientRect();
      let worst = { r: 99, who: '' }, n = 0, checked = 0;
      sb.querySelectorAll('*').forEach(el => {
        const r0 = el.getBoundingClientRect();
        if (!r0.width || !r0.height || r0.bottom < sbr.top || r0.top > sbr.bottom) return;
        /* 只看「自己直接带可见文字」的节点，避免把容器也算进来 */
        const txt = [...el.childNodes].filter(x => x.nodeType === 3).map(x => x.textContent.trim()).join('');
        if (txt.length < 2) return;
        if (/^(ALL|none)$/i.test(getComputedStyle(el).display)) return;
        n++;
        const cs2 = getComputedStyle(el);
        const r = ratio(cs2.color, bgOf(el));
        checked++;
        if (r < worst.r) worst = { r, who: el.className || el.id || el.tagName, fs: cs2.fontSize, op: cs2.opacity };
      });
      return { n: checked, worst };
    });
    ok('微博 · 侧栏**所有**带文字的元素逐个扫，最差也有 4.5:1（共 ' + sweep.n + ' 个；'
      + '最差是 ' + sweep.worst.who + ' @' + sweep.worst.fs + ' = ' + sweep.worst.r + ':1）',
      sweep.n >= 8 && sweep.worst.r >= 4.5, JSON.stringify(sweep.worst));
  }

  await goSkin('bili');
  await page.waitForTimeout(150);
  {
    const me = await css(page, ME_BUB, ['color', 'backgroundColor']);
    const c = contrast(me.color, me.backgroundColor);
    /* 这一条**故意**放宽：B站 自己的我方气泡就是白字压 #00aeec。
       如实照搬是「像原站」的前提，想读得更清楚可以切回「原版」。 */
    ok('B站 · 我方气泡 ≥ 2.5（如实照搬原站配色，实测 ' + c + ':1；原站同款）', c >= 2.5, c);

    const st = await css(page, '.stats', ['color']);
    const sb = await css(page, '.sidebar', ['backgroundColor']);
    const cs = contrast(st.color, sb.backgroundColor);
    /* 皮肤模式把这处提到了 --muted-strong：它写的是条数 / 日期区间，是要人读的正文。
       原版同位置用 --muted，实测只有 3:1 出头（见下），这里不跟它对齐。 */
    ok('B站 · 侧栏汇总正文 vs 侧栏底 ≥ 4.5（皮肤提到 --muted-strong；'
      + '原版同位置的 --muted 只有 ' + contrast('rgb(139, 147, 156)', sb.backgroundColor) + ':1；实测 '
      + cs + ':1）', cs >= 4.5, cs);

    const chipOn = await resolveVar(page, '--chip-on');
    const cc = contrast('rgb(255, 255, 255)', chipOn);
    ok('B站 · 选中态按钮白字 vs 底色 ≥ 4.5（没用品牌蓝当底：那个只有 2.54:1；实测 ' + cc + ':1）',
      cc >= 4.5, chipOn + ' → ' + cc);
  }

  await goSkin('weibo');
  await page.waitForTimeout(150);
  {
    const wlink = await resolveVar(page, '--link');
    const wbg = await resolveVar(page, '--bg');
    const c = contrast(wlink, wbg);
    ok('微博 · 链接色压聊天底 ≥ 4.5（没用品牌橙当字色：那个只有 2.1:1；实测 ' + c + ':1）',
      c >= 4.5, wlink + ' / ' + wbg + ' → ' + c);
  }
}

/* ============================================================
   7. 深色主题 × 皮肤：配色交回给深色主题，排版保留
   ============================================================ */
head('=== 7. 深色主题下不能变成「深底压深字」===');
{
  await goSkin('bili');
  await page.waitForTimeout(120);
  const bgLight = await rootVar(page, '--bg');
  await page.click('#themeBtn');
  await page.waitForTimeout(150);
  const dark = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const bgDark = await rootVar(page, '--bg');
  ok('切到深色主题后，底色不再是皮肤的浅色值（' + bgLight + ' → ' + bgDark + '）',
    dark === 'dark' && bgDark !== bgLight && bgDark !== '#f1f2f3', bgDark);

  const me = await css(page, ME_BUB, ['borderRadius', 'color', 'backgroundColor']);
  ok('深色主题下仍保留 B站 的气泡形状（排版照旧）',
    me && me.borderRadius === '16px 0px 16px 16px', me && me.borderRadius);
  const c = contrast(me.color, 'rgb(16,18,22)');
  ok('深色主题 + B站皮肤：我方气泡文字压在深色页底上仍读得清（≥ 4.5，实测 ' + c + ':1）', c >= 4.5, c);

  await page.click('#themeBtn');   // 切回浅色
  await page.waitForTimeout(150);
  ok('切回浅色主题后皮肤配色恢复', (await rootVar(page, '--bg')) === '#f1f2f3', await rootVar(page, '--bg'));
}

/* ============================================================
   8. 持久化
   ============================================================ */
head('=== 8. 记住用户的选择（刷新后还在）===');
{
  await goSkin('plain');
  await page.waitForTimeout(120);
  await page.reload();
  await page.waitForTimeout(500);
  ok('选「原版」→ 刷新后仍是原版（不被自动匹配抢回去）',
    (await skinAttr(page)) === 'plain', await skinAttr(page));

  await goSkin('bili');
  await page.waitForTimeout(120);
  await page.reload();
  await page.waitForTimeout(500);
  ok('选「B站」→ 刷新后仍是 B站', (await skinAttr(page)) === 'bili', await skinAttr(page));

  const pressed = await page.$eval('#skinSw button[data-skin="bili"]', n => n.getAttribute('aria-pressed'));
  ok('刷新后按钮的选中态也点亮了（快照重建后要重新点一次）', pressed === 'true', pressed);
}

/* ============================================================
   9. 皮肤下高清截图照样能用
   ============================================================ */
head('=== 9. 皮肤模式下高清截图导出不受影响 ===');
{
  const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-dl-'));
  const got = [];
  page.on('download', async d => {
    try { const p = path.join(DL, d.suggestedFilename()); await d.saveAs(p); got.push(p); }
    catch (e) { got.push({ err: e.message }); }
  });

  await goSkin('bili');
  await page.waitForTimeout(150);
  await page.click('#shotBtn');
  await page.waitForTimeout(500);
  await page.click('#shotClear');
  /* 只选前几条，保证落在单页里 → 直接下 PNG */
  await page.evaluate(() => {
    const cks = [...document.querySelectorAll('#chat .shotck')].slice(0, 4);
    cks.forEach(c => c.click());
  });
  await page.waitForTimeout(200);
  await page.click('#shotGo');
  await page.waitForTimeout(2600);

  const png = got.find(p => typeof p === 'string' && /\.png$/i.test(p));
  ok('B站皮肤下导出成功，拿到 PNG', !!png, got.map(p => (typeof p === 'string' ? path.basename(p) : p.err)).join(','));

  if (png) {
    const buf = fs.readFileSync(png);
    const w = buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 ? buf.readUInt32BE(16) : 0;
    ok('导出图宽度仍是 1520（皮肤不影响导出画布）', w === 1520, w);

    const bands = await page.evaluate(async () => {
      const el = document.querySelector('#shotGrid .shotcard img');
      if (!el) return -1;
      const im = new Image(); im.src = el.src; await im.decode();
      const c = document.createElement('canvas');
      const W = Math.min(im.naturalWidth, 700), H = Math.min(im.naturalHeight, 1600);
      c.width = W; c.height = H;
      const g = c.getContext('2d'); g.drawImage(im, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      const r0 = d[0], g0 = d[1], b0 = d[2];
      const B = 10, ink = new Array(B).fill(0), tot = new Array(B).fill(0);
      for (let y = 0; y < H; y++) {
        const bi = Math.min(B - 1, Math.floor(y / (H / B)));
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4; tot[bi]++;
          if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 24) ink[bi]++;
        }
      }
      return ink.filter((v, i) => v / tot[i] > 0.004).length;
    });
    ok('导出图不是空白（10 条横带里 ' + bands + ' 条有墨迹）', bands >= 8, bands);
  }
  /* 退出前必须先关掉预览面板：它是覆盖层，会替 #shotExit 接住点击 */
  await page.click('#shotClose');
  await page.click('#shotExit');
  await page.waitForTimeout(200);
  ok('退出多选模式后勾选框清干净（皮肤模式没留下残影）',
    await page.locator('#chat .shotck').count() === 0);
  try { fs.rmSync(DL, { recursive: true, force: true }); } catch (e) {}
}

/* ============================================================
   10. 窄屏：新加的这一块不能把「限高横条」撑高
   ⚠ .sidebar 在 ≤980px 会变成横向吸附条，并且有 max-height 硬上限
     —— 当初不加限高时它长到 437px，把手机屏挡掉一大半（有测试记录）。
     这次往侧栏里加了「页面风格」一整块，必须回头验一遍。
   ============================================================ */
head('=== 10. 窄屏（390px）下侧栏仍受限高约束 ===');
{
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(320);
  const m = await page.evaluate(() => {
    const sb = document.querySelector('.sidebar');
    const cs = getComputedStyle(sb);
    const sr = sb.getBoundingClientRect();
    const sw = document.querySelector('#skinSw').getBoundingClientRect();
    /* ⚠ 光判断「渲染出来了」不够（width/height > 0 只证明它在 DOM 里）：
       限高横条是可以内部滚动的，控件完全可能被推到可视区外面，
       那样手机上就得先滚这条细条才找得到 —— 必须判它在**可视框内**。 */
    return {
      h: Math.round(sr.height), max: cs.maxHeight, dir: cs.flexDirection,
      inView: sw.top >= sr.top - 0.5 && sw.bottom <= sr.bottom + 0.5 && sw.height > 0,
      over: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  ok('侧栏仍是横向限高条（max-height ' + m.max + '，实测高 ' + m.h + 'px ≤ 上限）',
    m.dir === 'row' && m.max === '150px' && m.h <= 151, JSON.stringify(m));
  ok('窄屏下「页面风格」就在可视区内（不用先滚这条细条才找得到）', m.inView, JSON.stringify(m));
  ok('窄屏下没有横向溢出（scrollWidth - innerWidth = ' + m.over + '）', m.over <= 0, m.over);

  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.waitForTimeout(300);
}

/* ---------- 收尾：别把偏好留给别的套件 ---------- */
await page.evaluate(() => { try { localStorage.removeItem('dm-skin'); } catch (e) {} });
await browser.close();
srv.close();

console.log('\n' + '='.repeat(56));
console.log('页面风格皮肤：通过 ' + pass + ' · 失败 ' + fail + ' · 合计 ' + (pass + fail));
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);
