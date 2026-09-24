/**
 * 验证：页面风格皮肤（**按数据源自动**：微博源 → 仿微博；B站源 → 仿B站）
 * ------------------------------------------------------------------
 * 这个功能的卖点就是「看起来像原站」，所以断言不能只写「按钮点了有反应」——
 * 必须把**真实计算样式**量出来，跟一手前端产物里的规格逐条对上：
 *
 *   微博 —— 新版 App 私信会话页（2026-09 定稿，官方 UDC 文章 + 定稿截图取色）：
 *     .self 气泡是**蓝**的 #3da7fb + 白字（微信才是绿；旧版那套绿气泡已弃用）
 *     对方气泡纯白；圆角 = 单行高度的 1/4（10px）；气泡角是平滑小弧角（旋转圆角方块）
 *     头像正圆 34px、气泡与头像间距 10px；聊天底 #ececec；日期分隔条居中细字无底色
 *     侧栏那一列仍取 pcweibochat：.chatbox .msglist{background:#33353a} 等
 *   B站 message.bilibili.com 的 message-pc 样式包：
 *     ._MsgTextIsMe_{background:#00aeec;color:#fff;border-radius:16px 0 16px 16px}
 *     ._MsgText_{background:#fff;border-radius:0 16px 16px;padding:8px 16px;width:fit-content}
 *     ._Msg__Avatar{border-radius:50%;width:30px;height:30px}
 *     --bg3:#f1f2f3  --text1:#18191c
 *
 * 另外四件容易被漏掉的事，这里都单独守：
 *   · 对比度用 WCAG 公式**算**出来（不是看颜色值顺眼）。两站的招牌蓝气泡 + 白字
 *     是**写明的例外清单**（微博 2.59:1 / B站 2.54:1），其余一律要过 4.5。
 *   · **气泡宽度**：短消息（两个字）不许被 .meta 撑成四个字的宽 —— 见第 11 节。
 *   · 皮肤恒等于数据源：`data-skin` 永远是 weibo / bili，不存在第三种；切换按钮已删。
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
/* 皮肤现在**没有开关**：它由数据源直接决定。所以「切到某个皮肤」= 切到对应的数据源。
   保留这个函数名只是为了让下面各节的写法不用大改 —— 它已经不是「点皮肤按钮」了。 */
async function goSkin(s) {
  await gotoSrc(s === 'bili' ? 'bili' : 'weibo');
  await page.waitForTimeout(180);
}

await page.goto(URL_);
await page.waitForTimeout(500);

/* ============================================================
   1. 入口：没有风格开关了，皮肤 = 数据源
   ============================================================ */
head('=== 1. 皮肤由数据源决定（切换按钮已删）===');
{
  /* 用户原话：「把那个切换按钮去掉吧，多此一举」。
     所以这一节钉的是「它真的没了」，而不是以前那样钉「它长在哪、叫什么名字」。 */
  const ctl = await page.evaluate(() => ({
    skinSw: document.querySelectorAll('#skinSw').length,
    skinbox: document.querySelectorAll('.skinbox').length,
    anyBtn: document.querySelectorAll('button[data-skin]').length,
    tabs: [...document.querySelectorAll('[role="tablist"]')].map(n => n.getAttribute('aria-label') || ''),
  }));
  ok('页面风格切换控件已从 DOM 里删掉（#skinSw / .skinbox / button[data-skin] 全为 0）',
    ctl.skinSw === 0 && ctl.skinbox === 0 && ctl.anyBtn === 0, JSON.stringify(ctl));

  const nSrc = await page.$$eval('#srcSw button[data-src]', ns => ns.length);
  ok('数据源切换还在（仍是 ' + SRC_KEYS.length + ' 个）—— 现在它是唯一决定外观的开关',
    nSrc === SRC_KEYS.length, nSrc);
  ok('role=tablist 只剩数据源这一条（不会再有两排胶囊让人认错）',
    ctl.tabs.length === 1 && /备份来源/.test(ctl.tabs[0]), JSON.stringify(ctl.tabs));

  /* 逐个数据源走一遍：皮肤必须等于「按源算出来」的那个，且永远不是第三种 */
  const seen = [];
  for (const k of SRC_KEYS) {
    await gotoSrc(k);
    seen.push(k + '→' + (await skinAttr(page)));
  }
  ok('每个数据源的皮肤都对得上（' + seen.join(' · ') + '）',
    seen.every(s => s.split('→')[1] === expectSkin(s.split('→')[0])), seen.join(' · '));
  ok('data-skin 永远只有 weibo / bili 两种取值（「原版」这条路已经不存在）',
    seen.every(s => ['weibo', 'bili'].indexOf(s.split('→')[1]) >= 0), seen.join(' · '));

  const first = SRC_KEYS[0];
  await gotoSrc(first);
  ok('回到首个数据源，皮肤也跟着回来（' + first + ' → ' + expectSkin(first) + '）',
    (await skinAttr(page)) === expectSkin(first), await skinAttr(page));
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
head('=== 3. 微博皮肤（照新版 App 定稿逐条对）===');
{
  await goSkin('weibo');
  await page.waitForTimeout(150);

  const me = await css(page, ME_BUB, ['backgroundColor', 'color', 'borderRadius', 'paddingTop',
    'paddingLeft', 'fontSize', 'borderTopWidth']);
  ok('我方气泡底色 = #3da7fb（官方定稿取色 mode #3ea8fc/#3da7fb；绿色是微信的/旧版的）',
    me && me.backgroundColor === 'rgb(61, 167, 251)', me && me.backgroundColor);
  ok('我方气泡文字 = 白色（官方定稿：白字压微博蓝）',
    me && me.color === 'rgb(255, 255, 255)', me && me.color);
  ok('我方气泡圆角 = 10px（官方口径：圆角 = 单行气泡高度的 1/4）',
    me && me.borderRadius === '10px', me && me.borderRadius);
  ok('我方气泡内边距 9px 13px、字号 16px（定稿截图量出来的）',
    me && me.paddingTop === '9px' && me.paddingLeft === '13px' && me.fontSize === '16px',
    me && [me.paddingTop, me.paddingLeft, me.fontSize].join(' / '));
  ok('我方气泡没有边框（官方定稿没有描边）',
    me && me.borderTopWidth === '0px', me && me.borderTopWidth);

  const peer = await css(page, PEER_BUB, ['backgroundColor', 'color', 'borderRadius']);
  ok('对方气泡 = 纯白（官方定稿：对方是白气泡 + 近黑字）',
    peer && peer.backgroundColor === 'rgb(255, 255, 255)', peer && peer.backgroundColor);
  ok('对方气泡文字 = #1a1a1a', peer && peer.color === 'rgb(26, 26, 26)', peer && peer.color);
  ok('对方气泡圆角 = 10px（与气泡角对称 —— 官方特意保住了这份对称性）',
    peer && peer.borderRadius === '10px', peer && peer.borderRadius);

  /* 气泡角 = 平滑小弧角（旋转 45° 的圆角方块，外角修圆 13px），不是旧版的尖锐三角。
     ⚠ 判定「画没画」只能看 content：探针实测**非生成**伪元素的 computed display 是
     inline 而不是 none，所以写成 display!=='none' 的断言永远不会失败（等于没断言）。 */
  const meTail = await css(page, ME_BUB, ['content', 'width', 'height', 'backgroundColor',
    'borderTopRightRadius'], '::after');
  ok('我方气泡角 = 14px 小方块 / 外角 13px 圆 / 底色跟着气泡（官方「平滑小弧角」）',
    meTail && meTail.content !== 'none' && meTail.width === '14px' && meTail.height === '14px'
      && meTail.borderTopRightRadius === '13px' && meTail.backgroundColor === 'rgb(61, 167, 251)',
    meTail && [meTail.content, meTail.width, meTail.borderTopRightRadius,
      meTail.backgroundColor].join(' / '));

  const peerTail = await css(page, PEER_BUB, ['content', 'borderTopLeftRadius', 'backgroundColor'], '::after');
  ok('对方气泡的角在左侧、外角 13px 圆、底色 = 对方气泡底色',
    peerTail && peerTail.content !== 'none' && peerTail.borderTopLeftRadius === '13px'
      && peerTail.backgroundColor === 'rgb(255, 255, 255)',
    peerTail && [peerTail.content, peerTail.borderTopLeftRadius, peerTail.backgroundColor].join(' / '));

  /* 旧版那套尖锐三角（border 6px 拼的）必须已经彻底退场 */
  const oldTri = await css(page, ME_BUB, ['borderLeftWidth', 'borderLeftColor'], '::after');
  ok('旧版的尖锐三角（border:6px 拼出来的）已经不在了',
    oldTri && oldTri.borderLeftWidth === '0px', oldTri && oldTri.borderLeftWidth);

  /* 反向验证：透明无框的气泡（.plain / .sys）**不能**挂小角 */
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
  ok('透明气泡（.plain / .sys）上不挂小角（本屏真实 ' + tails.total + ' 条 + 人造样本 '
    + tails.made + ' 条，都没挂）', tails.drawn === 0 && tails.made === 2 && tails.probe === 0,
    '真实挂 ' + tails.drawn + ' 条 / 人造挂 ' + tails.probe + ' 条');

  /* 气泡 ↔ 头像的间距：官方定稿两边都是「1 个单位」（10pt） */
  const gapP = await css(page, '.msg:not(.me)', ['columnGap']);
  const gapM = await css(page, '.msg.me', ['columnGap']);
  ok('气泡与头像间距 = 10px，两边一样（官方定稿：间距 1 个单位）',
    gapP && gapP.columnGap === '10px' && gapM && gapM.columnGap === '10px',
    (gapP && gapP.columnGap) + ' / ' + (gapM && gapM.columnGap));

  const av = await css(page, '.msg .av', ['borderRadius', 'width', 'height']);
  ok('头像是正圆 34px（官方定稿 ≈34pt 圆头像；旧版的方角头像是弃用那套）',
    av && av.borderRadius === '50%' && av.width === '34px',
    av && av.borderRadius + ' / ' + av.width);

  const day = await css(page, '.day span', ['backgroundColor', 'borderTopWidth', 'paddingTop', 'paddingLeft']);
  const dayLine = await css(page, '.day', ['display'], '::before');
  ok('日期分隔条 = 居中细字、**无底色**（官方定稿没有胶囊；微信式胶囊是明确避开的特征）',
    day && day.backgroundColor === 'rgba(0, 0, 0, 0)' && day.borderTopWidth === '0px'
      && day.paddingTop === '0px' && day.paddingLeft === '0px',
    day && [day.backgroundColor, day.paddingTop, day.paddingLeft].join(' / '));
  ok('日期分隔条去掉了横线（原站没有横线）',
    dayLine && dayLine.display === 'none', dayLine && dayLine.display);

  const dayM = await css(page, '.day', ['marginTop', 'marginBottom']);
  ok('日期分隔条上下间距 7px（一手 .time{margin:7px auto}）',
    dayM && dayM.marginTop === '7px' && dayM.marginBottom === '7px',
    dayM && dayM.marginTop + ' / ' + dayM.marginBottom);

  const sb = await css(page, '.sidebar', ['backgroundColor']);
  ok('侧栏 = 深色会话列表 #33353a（一手 .chatbox .msglist{background:#33353a}）',
    sb && sb.backgroundColor === 'rgb(51, 53, 58)', sb && sb.backgroundColor);

  /* 会话头里的头像跟 .av 是两套节点，别只改一处 */
  const sav = await css(page, '.shead .sav', ['borderRadius']);
  ok('会话头头像也是正圆（.shead .sav 与 .av 是两套节点）',
    sav && sav.borderRadius === '50%', sav && sav.borderRadius);

  /* 会话页 chrome 里不许出现微博橙 —— 官方定稿截图里一点橙都没有
     （橙属于信息流品牌层；这里只查 chrome，气泡里的链接文字是另一回事，见 CSS 注释）。 */
  const hue = await page.evaluate(() => {
    const toHue = s => {
      const m = (String(s).match(/[\d.]+/g) || []).map(Number);
      if (m.length < 3 || (m.length > 3 && m[3] === 0)) return null;
      const [r, g, b] = m.slice(0, 3).map(v => v / 255);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn < 0.12) return null;                  /* 灰阶/白，不算有色 */
      let h;
      if (mx === r) h = ((g - b) / (mx - mn)) % 6;
      else if (mx === g) h = (b - r) / (mx - mn) + 2;
      else h = (r - g) / (mx - mn) + 4;
      return { h: Math.round(((h * 60) + 360) % 360), sat: mx - mn };
    };
    const SEL = ['.shead', '.shead .sn', '.shead .stag', '.day', '.day span',
      '.msg .meta', '.msg .av', '.msg.me .bubble:not(.plain):not(.sys)',
      '.msg:not(.me) .bubble:not(.plain):not(.sys)'];
    const bad = [];
    let n = 0;
    SEL.forEach(s => {
      const el = document.querySelector(s);
      if (!el) return;
      n++;
      const cs = getComputedStyle(el);
      [['color', cs.color], ['background', cs.backgroundColor], ['border', cs.borderTopColor]]
        .forEach(([k, v]) => {
          const o = toHue(v);
          /* 橙：色相 15°–50° 且够饱和 */
          if (o && o.h >= 15 && o.h <= 50 && o.sat > 0.25) bad.push(`${s} 的 ${k} = ${v}（${o.h}°）`);
        });
    });
    return { n, bad };
  });
  ok('会话页 chrome（会话头 / 时间条 / 昵称 / 头像 / 两侧气泡）里没有一处微博橙'
    + '（扫了 ' + hue.n + ' 个节点的字色+底色+边框色）', hue.n >= 8 && hue.bad.length === 0,
    hue.bad.join('；'));
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
  /* 一手是 ._Msg__SenderName{font-size:13px;color:var(--text3)}，但 --text3 #9499a0 压在
     #f1f2f3 上只有 2.6:1 —— 按纪律换同色系深一档 --text2 #61666d（5.16:1），字号照旧。 */
  ok('昵称在气泡上方、13px（一手 ._Msg__SenderName{font-size:13px}；色值换可读档 #61666d）',
    meta && meta.fontSize === '13px' && meta.color === 'rgb(97, 102, 109)',
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
   5. 换肤要换干净（原来这一节守的是「原版还在」，原版已删）
   ⚠ 没有「原版」这条退路之后，更怕的是**只换了一半**：皮肤没盖住基础样式，
     于是出现「蓝气泡 + 基础 5px 圆角」这种四不像。这里逐条钉住。
   ============================================================ */
head('=== 5. 换肤要换干净：两套皮肤都不许残留基础外观 ===');
{
  const probe = () => page.evaluate(() => {
    const me = document.querySelector('.msg.me .bubble:not(.plain):not(.sys)');
    const cs = getComputedStyle(me);
    const day = document.querySelector('.day');
    return {
      meBg: cs.backgroundColor, meImg: cs.backgroundImage,
      meTLR: cs.borderTopLeftRadius, meTRR: cs.borderTopRightRadius,
      dayLine: day ? getComputedStyle(day, '::before').display : 'no-day',
      stats: getComputedStyle(document.querySelector('.stats')).color,
    };
  });

  await goSkin('weibo');
  const w = await probe();
  await goSkin('bili');
  const b = await probe();

  ok('两套皮肤的我方气泡各是各的（微博蓝 #3da7fb vs B站品牌蓝 #00aeec）',
    w.meBg === 'rgb(61, 167, 251)' && b.meBg === 'rgb(0, 174, 236)', w.meBg + ' / ' + b.meBg);
  ok('两套皮肤都没漏出基础气泡的「14px / 5px」那套圆角（它只属于本工具原生外观）',
    w.meTLR === '10px' && w.meTRR === '10px' && b.meTLR === '16px' && b.meTRR === '0px',
    `${w.meTLR}/${w.meTRR} · ${b.meTLR}/${b.meTRR}`);
  ok('两套皮肤的我方气泡都不是渐变底（基础外观里 --me 是 linear-gradient）',
    w.meImg === 'none' && b.meImg === 'none',
    (w.meImg || '').slice(0, 24) + ' / ' + (b.meImg || '').slice(0, 24));
  ok('两套皮肤都盖掉了基础日期横线（.day::before 的 display）',
    w.dayLine === 'none' && b.dayLine === 'none', w.dayLine + ' / ' + b.dayLine);
  ok('两套皮肤都把侧栏正文字色提到可读档（基础 --muted #8b939c 那档没漏出来）',
    w.stats !== 'rgb(139, 147, 156)' && b.stats !== 'rgb(139, 147, 156)',
    w.stats + ' / ' + b.stats);
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
    /* **写明的例外清单**（两条）：微博 #3da7fb、B站 #00aeec 的招牌蓝气泡 + 白字。
       官方定稿就是这么配的，改深了就不像那两个站了；所以这里写死放宽，
       并且把「例外只有这两条」当成断言的一部分（见本节末尾的系统扫）。 */
    ok('微博 · 我方气泡 ≥ 2.5（如实照搬官方定稿的招牌蓝 #3da7fb + 白字；实测 '
      + c + ':1；例外清单 1/2）', c >= 2.5, c);

    /* ⚠ --bg 是**变量 token 字符串**（'#ececec'），直接丢进对比度公式会得 NaN，
       必须用 resolveVar 挂到临时元素上解析成 rgb。 */
    const dayBg = await resolveVar(page, '--bg');    /* 时间条自己没有底，压在聊天底上 */
    const day = await css(page, '.day span', ['color']);
    const cd = contrast(day.color, dayBg);
    ok('微博 · 日期文字压聊天底 ≥ 4.5（原站那档 ≈1.6:1，这里保形状换可读色；实测 '
      + cd + ':1）', cd >= 4.5, day.color + ' / ' + dayBg + ' → ' + cd);

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
    /* 同一条例外的另一半：B站 自己的我方气泡就是白字压 #00aeec。
       如实照搬是「像原站」的前提 —— 原来还有「想读清楚就切回原版」这条退路，
       现在开关取消了，所以例外**只允许有这两条**（末尾的系统扫会兜住）。 */
    ok('B站 · 我方气泡 ≥ 2.5（如实照搬原站配色，实测 ' + c + ':1；例外清单 2/2）', c >= 2.5, c);

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

  /* ---- 聊天区的**系统扫** ----
     「原版」取消之后没有退路了，所以不能只量自己想到的那几个选择器（第 3/4 节是逐条量）。
     这里遍历聊天区所有「自己直接带可见文字」的节点，量字色 vs 最近的实底祖先：
       · 我方气泡是**写明的例外**，单独统计，不参与 4.5 判定；
       · 压在图片/卡片上的浮层文字（.ocrtip / .imgs / .links / .wcard）量不出意义，跳过；
       · 多选勾选框、按钮这些非正文也跳过。
     判据：除例外外，最小值必须 ≥ 4.5，而且至少要扫到 8 个节点（否则等于没扫）。 */
  for (const [key, lbl] of [['weibo', '微博'], ['bili', 'B站']]) {
    await goSkin(key);
    await page.waitForTimeout(120);
    const sweep = await page.evaluate(() => {
      /* ⚠ 颜色解析要吃两种写法：rgb()/rgba()，以及 Chromium 对 color-mix() 的
         computed 结果 `color(srgb 0.93 0.93 0.93 / 0.9)` —— 前三个是 0~1 的浮点。
         不处理这种写法会被误读成「rgb(1,1,1) = 近黑」，于是会话头昵称被算成 1.64:1
         （假失败，实测抓到过：sn@14.5px = 1.64:1）。 */
      const parse = s => {
        const str = String(s);
        const nums = (str.match(/[\d.]+/g) || []).map(Number);
        if (/^color\(/i.test(str) && nums.length >= 3
          && nums[0] <= 1 && nums[1] <= 1 && nums[2] <= 1) {
          return nums.slice(0, 3).map(v => v * 255);
        }
        return nums.slice(0, 3);
      };
      const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      const ratio = (a, b) => { const A = lum(parse(a)), B = lum(parse(b));
        const hi = Math.max(A, B), lo = Math.min(A, B); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };
      const bgOf = el => { let n = el; while (n && n !== document.documentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg; n = n.parentElement; }
        return 'rgb(255,255,255)'; };
      const SKIP = '.ocrtip, .imgs, .links, .wcard, .shotck, .tag, button, svg';
      let worst = { r: 99, who: '' }, n = 0, exc = null;
      document.querySelectorAll('#chat *').forEach(el => {
        if (el.closest(SKIP)) return;
        const r0 = el.getBoundingClientRect();
        if (!r0.width || !r0.height) return;
        const txt = [...el.childNodes].filter(x => x.nodeType === 3).map(x => x.textContent.trim()).join('');
        if (txt.length < 2) return;
        const cs = getComputedStyle(el);
        if (/^(none)$/i.test(cs.display) || cs.visibility === 'hidden') return;
        const r = ratio(cs.color, bgOf(el));
        n++;
        if (el.closest('.msg.me') && el.closest('.bubble')) { exc = r; return; }   /* 例外：我方气泡 */
        if (r < worst.r) worst = { r, who: (el.className || el.tagName) + '@' + cs.fontSize };
      });
      return { n, worst, exc };
    });
    ok(lbl + ' · 聊天区所有正文节点逐个扫：除「我方气泡」这条例外外，最差也 ≥ 4.5'
      + '（共扫 ' + sweep.n + ' 个；最差 ' + sweep.worst.who + ' = ' + sweep.worst.r + ':1；'
      + '我方气泡例外实测 ' + sweep.exc + ':1）',
      sweep.n >= 8 && sweep.worst.r >= 4.5, JSON.stringify(sweep));
  }
  await goSkin('weibo');
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

  /* ---- 微博 + 深色：形状要留着，但渐变底的**我方**气泡角必须藏掉 ----
     （小角用的是 background:inherit，14px 方块里渐变会「从头重放」，接缝看得出来） */
  await goSkin('weibo');
  await page.click('#themeBtn');
  await page.waitForTimeout(180);
  const dMe = await css(page, ME_BUB, ['borderRadius'], null);
  /* ⚠ 「藏掉」是用 display:none 实现的 —— 这时 content 仍然是 ""（生成的伪元素），
     所以只能看 display，不能看 content（看 content 会永远为真或永远为假）。 */
  const dMeTail = await css(page, ME_BUB, ['display'], '::after');
  const dPeerTail = await css(page, PEER_BUB, ['content', 'backgroundColor'], '::after');
  ok('深色主题 + 微博：仍是 10px 圆角那套排版（形状不跟着主题变）',
    dMe && dMe.borderRadius === '10px', dMe && dMe.borderRadius);
  ok('深色主题 + 微博：我方气泡角藏掉（--me 是渐变，小方块会露出接缝）',
    dMeTail && dMeTail.display === 'none', dMeTail && dMeTail.display);
  ok('深色主题 + 微博：对方气泡角照旧画着（--peer 是纯色，没这个问题）',
    dPeerTail && dPeerTail.content !== 'none' && dPeerTail.backgroundColor !== 'rgba(0, 0, 0, 0)',
    dPeerTail && dPeerTail.content + ' / ' + dPeerTail.backgroundColor);

  await page.click('#themeBtn');   // 切回浅色
  await page.waitForTimeout(180);
  const lMeTail = await css(page, ME_BUB, ['content', 'backgroundColor'], '::after');
  ok('切回浅色后我方气泡角又回来了（深色下藏掉的那条没有留在浅色里）',
    lMeTail && lMeTail.content !== 'none' && lMeTail.backgroundColor === 'rgb(61, 167, 251)',
    lMeTail && lMeTail.content + ' / ' + lMeTail.backgroundColor);
}

/* ============================================================
   8. 刷新后自洽 + 老偏好不许复活
   ============================================================ */
head('=== 8. 刷新后皮肤仍跟着数据源；老版本留下的偏好被忽略 ===');
{
  /* 老版本往 localStorage 里存过 dm-skin（原版/仿微博/仿B站）。
     现在不该再读它，更不该冒出 data-skin=plain 这种已经不存在的状态。 */
  await page.evaluate(() => { try { localStorage.setItem('dm-skin', 'plain'); } catch (e) {} });
  const curSrc = await page.$eval('#srcSw button[aria-pressed="true"]', n => n.dataset.src);
  await page.reload();
  await page.waitForTimeout(600);
  ok('localStorage 里塞了老的 dm-skin=plain，刷新后皮肤仍是按源算的（'
    + curSrc + ' → ' + expectSkin(curSrc) + '）',
    (await skinAttr(page)) === expectSkin(curSrc), await skinAttr(page));
  const left = await page.evaluate(() => {
    try { return localStorage.getItem('dm-skin'); } catch (e) { return 'n/a'; }
  });
  ok('页面顺手把这条例遗留清掉了（再读出来是 null）', left === null, String(left));

  /* 切源 → 刷新：皮肤得跟着「刷新后的数据源」走，而不是停在刷新前的样子 */
  const other = SRC_KEYS.find(k => k !== curSrc) || curSrc;
  await gotoSrc(other);
  await page.reload();
  await page.waitForTimeout(600);
  const after = await page.$eval('#srcSw button[aria-pressed="true"]', n => n.dataset.src);
  ok('刷新后皮肤 == 刷新后数据源对应的皮肤（' + after + ' → ' + expectSkin(after) + '）',
    (await skinAttr(page)) === expectSkin(after), await skinAttr(page) + ' / 源 ' + after);
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
   10. 窄屏：侧栏仍受限高约束，且没有风格控件残留
   ⚠ .sidebar 在 ≤980px 会变成横向吸附条，并且有 max-height 硬上限
     —— 当初不加限高时它长到 437px，把手机屏挡掉一大半（有测试记录）。
     皮肤那一块控件虽然删了，这条限高约束还是得回头验一遍。
   ============================================================ */
head('=== 10. 窄屏（390px）下侧栏仍受限高约束 ===');
{
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(320);
  const m = await page.evaluate(() => {
    const sb = document.querySelector('.sidebar');
    const cs = getComputedStyle(sb);
    const sr = sb.getBoundingClientRect();
    /* 侧栏里现在只剩「数据源」这一条 tab 要保证够得着；
       ⚠ 光判断「渲染出来了」不够（width/height > 0 只证明它在 DOM 里）：
       限高横条是可以内部滚动的，控件完全可能被推到可视区外面 ——
       必须判它在**可视框内**，否则手机上还得先滚这条细条才找得到。 */
    const sw = document.querySelector('#srcSw');
    const r = sw ? sw.getBoundingClientRect() : null;
    return {
      h: Math.round(sr.height), max: cs.maxHeight, dir: cs.flexDirection,
      inView: !!(r && r.top >= sr.top - 0.5 && r.bottom <= sr.bottom + 0.5 && r.height > 0),
      skinCtl: document.querySelectorAll('#skinSw, .skinbox, button[data-skin]').length,
      over: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  ok('侧栏仍是横向限高条（max-height ' + m.max + '，实测高 ' + m.h + 'px ≤ 上限）',
    m.dir === 'row' && m.max === '150px' && m.h <= 151, JSON.stringify(m));
  ok('窄屏下「数据源」就在可视区内（不用先滚这条细条才找得到）', m.inView, JSON.stringify(m));
  ok('窄屏下没有任何风格控件残留（判据：0）', m.skinCtl === 0, m.skinCtl);
  ok('窄屏下没有横向溢出（scrollWidth - innerWidth = ' + m.over + '）', m.over <= 0, m.over);

  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.waitForTimeout(300);
}

/* ============================================================
   11. 气泡宽度：短消息不许被 .meta 撑宽
   ------------------------------------------------------------
   用户报的现象：「B站有些聊天内容只有两个字、三个字，但是气泡大小是四个字的长度，
   后面留出了一段空格」。
   取证结论：**不是气泡的错** —— 气泡上方的 .meta（昵称 + 时间）比正文宽，
   而 .body 是 align-items:stretch 的纵向 flex，气泡被拉到了 meta 的宽度
   （实测：正文 28px 的「丑爆」气泡宽 83.16px，正好等于 meta 宽）。
   修法：照一手 B站 CSS 补上 .bubble{width:fit-content}（那条声明本来就该有，是漏抄）。
   ⚠ 光看「数字变小了」不算验证 —— 末尾那条反向验证把 fit-content 掰回 auto，
     断言必须重新失败，才算这条断言是活的。
   ============================================================ */
head('=== 11. 气泡宽度：短消息不留白（含反向验证）===');
{
  const measureOne = () => page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('.msg').forEach(msg => {
      const b = msg.querySelector('.bubble');
      if (!b || b.children.length) return;                     /* 只看纯文本气泡 */
      if (b.classList.contains('plain') || b.classList.contains('sys')) return;
      const t = (b.textContent || '').trim();
      if (!t) return;
      const cs = getComputedStyle(b);
      const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
      const r = document.createRange(); r.selectNodeContents(b);
      const rect = b.getBoundingClientRect();
      /* 单行气泡的判据：高度 ≈ 行高 + 上下 padding。
         多行气泡的最后一行本来就短，那个「白留」是正常的折行，别误判成 bug。 */
      const oneLine = rect.height <= (parseFloat(cs.lineHeight) || 0)
        + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 1;
      rows.push({ t, tl: t.length, side: msg.className.indexOf('me') >= 0 ? 'me' : 'peer',
        bw: rect.width, tw: r.getBoundingClientRect().width, pad: pl + pr,
        leftover: rect.width - r.getBoundingClientRect().width - pl - pr, oneLine });
    });
    return rows;
  });

  for (const [key, lbl] of [['bili', 'B站'], ['weibo', '微博']]) {
    await goSkin(key);
    await page.waitForTimeout(220);
    const one = (await measureOne()).filter(r => r.oneLine);
    const worst = one.slice().sort((a, b) => b.leftover - a.leftover)[0] || { leftover: 0, t: '' };
    ok(lbl + ' · 单行纯文本气泡的「白留宽度」≤ 2px（共 ' + one.length + ' 条；最差 '
      + JSON.stringify(worst.t).slice(0, 16) + ' = ' + R(worst.leftover) + 'px）',
      one.length >= 5 && one.every(r => r.leftover <= 2),
      '最差 ' + JSON.stringify({ t: worst.t, bw: R(worst.bw), tw: R(worst.tw), leftover: R(worst.leftover) }));

    const shorts = one.filter(r => r.tl <= 4);
    ok(lbl + ' · 其中 2~4 个字的短消息也贴边（' + shorts.length + ' 条；最差 '
      + R(Math.max(0, ...shorts.map(r => r.leftover))) + 'px）',
      shorts.length >= 1 && shorts.every(r => r.leftover <= 2),
      shorts.slice(0, 3).map(r => JSON.stringify(r.t) + '→' + R(r.leftover)).join('  '));
  }

  /* 反向验证：掰断 fit-content，白留必须重新回来 */
  await goSkin('bili');
  await page.waitForTimeout(200);
  const rev = await page.evaluate(() => {
    /* ⚠ 挑样本要挑对：必须挑「.meta 比正文还宽」的那种 —— 那正是当初出问题的一批。
       随手挑一条短消息可能它本来就比 meta 宽，掰断 fit-content 也不会有变化，
       验证就白做了（实测踩过：随手挑中「什么事呀」，0 → 0 → 0）。 */
    const cand = [];
    document.querySelectorAll('.msg').forEach(msg => {
      const b = msg.querySelector('.bubble');
      if (!b || b.children.length) return;
      if (b.classList.contains('plain') || b.classList.contains('sys')) return;
      const t = (b.textContent || '').trim();
      if (!t || t.length > 4) return;
      const cs = getComputedStyle(b);
      const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
      const r = document.createRange(); r.selectNodeContents(b);
      const need = r.getBoundingClientRect().width + pl + pr;        /* 气泡自己需要的宽度 */
      const meta = msg.querySelector('.meta');
      const metaW = meta ? meta.getBoundingClientRect().width : 0;   /* 上方那一行的宽度 */
      cand.push({ b, t, need, metaW, room: metaW - need });
    });
    if (!cand.length) return { n: 0 };
    cand.sort((a, b2) => b2.room - a.room);
    const pick = cand[0], b = pick.b;
    const gap = () => {
      const cs = getComputedStyle(b);
      const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
      const r = document.createRange(); r.selectNodeContents(b);
      return b.getBoundingClientRect().width - r.getBoundingClientRect().width - pl - pr;
    };
    const fixed = gap();
    b.style.width = 'auto';          /* 掰断：回到「被 .meta 撑宽」的老样子 */
    const broken = gap();
    b.style.width = '';              /* 还原 */
    const back = gap();
    return { n: cand.length, t: pick.t, room: Math.round(pick.room), metaW: Math.round(pick.metaW),
      fixed, broken, back };
  });
  ok('反向验证：把 width:fit-content 掰回 auto，同一条气泡立刻多出 '
    + R(rev.broken - rev.fixed) + 'px 白留（样本 ' + JSON.stringify(rev.t) + '，它上方 meta 宽 '
    + rev.metaW + 'px、自己只要 ' + Math.round(rev.metaW - rev.room) + 'px；'
    + R(rev.fixed) + ' → ' + R(rev.broken) + ' → ' + R(rev.back) + '）——这条断言是活的',
    rev.n >= 1 && rev.room >= 5 && rev.fixed <= 2 && rev.broken >= 5 && rev.back <= 2,
    JSON.stringify(rev));

  /* 回归护栏：图片 / 卡片气泡（.plain）不能因为 fit-content 变形 */
  const plains = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.msg .bubble.plain').forEach(b => {
      const kid = b.firstElementChild;
      out.push({
        bw: Math.round(b.getBoundingClientRect().width),
        kidW: kid ? Math.round(kid.getBoundingClientRect().width + parseFloat(getComputedStyle(b).paddingLeft) * 2) : null,
      });
    });
    return out;
  });
  const plainBad = plains.filter(p => p.kidW !== null && p.bw - p.kidW > 3);
  ok('图片 / 卡片气泡（.plain，共 ' + plains.length + ' 个）宽度仍等于内容宽度，没有被 fit-content 弄变形',
    plainBad.length === 0, JSON.stringify(plainBad));
}

/* ---------- 收尾：别把偏好留给别的套件（dm-skin 是老版本遗留的键）---------- */
await page.evaluate(() => { try { localStorage.removeItem('dm-skin'); } catch (e) {} });
await browser.close();
srv.close();

console.log('\n' + '='.repeat(56));
console.log('页面风格皮肤：通过 ' + pass + ' · 失败 ' + fail + ' · 合计 ' + (pass + fail));
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);
