// 真实数据 × 真实浏览器 渲染验证（B站视图）
// ===========================================================================
// 与 shot_sources.mjs 的分工：
//   shot_sources.mjs —— 用「空/假」状态验证切换条行为（不依赖真实数据）
//   本脚本          —— 用**真实抓下来的 B站备份**验证渲染，并实测两个只有
//                       真实数据才会遇到的边界：
//                         · 备份时就 404 的图片（相簿封面被删）→ 必须降级成
//                           「原图已失效」占位，而不是一个破图图标
//                         · B站表情记号（不带方括号的字典键）→ 必须渲染成图
import { loadDep } from './_deps.mjs';
import fs from 'fs';
import path from 'path';
import url from 'url';

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

// 先确认真实数据在，否则报错退出（避免「假通过」）
const MJ = path.join(ROOT, 'bili', 'messages.json');
if (!fs.existsSync(MJ)) { console.error('[×] 没有 bili/messages.json，先跑一次「更新B站备份.cmd」'); process.exit(2); }
const REAL = JSON.parse(fs.readFileSync(MJ, 'utf8'));
console.log('  真实数据：' + REAL.length + ' 条消息');

// 找一个必然 404 的图片条目（下载时就没落盘 local 的），作为降级用例
let deadCase = null;
for (const m of REAL) for (const im of (m.images || [])) {
  if (im.url && !im.local) { deadCase = { m, im }; break; }
  if (deadCase) break;
}
console.log('  失效图用例：' + (deadCase ? deadCase.im.url.slice(0, 72) + '…' : '(当前数据里没有，跳过该项)'));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
// 本脚本要反复点「自动回复」开关，先清掉上次留下的持久化状态，保证每次都从「未隐藏」起步
await page.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
const errs = [];
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(url.pathToFileURL(HTML).href, { waitUntil: 'load' });
await page.waitForTimeout(1000);

// ---- 1) 切到 B站，确认用的是真实数据而不是兜底 ----
const btns = page.locator('#srcSw button');
await btns.nth(1).click();
await page.waitForTimeout(1200);

const n = await page.evaluate(() => ((window.DM_DATA_B || {}).messages || []).length);
chk(n === REAL.length, 'B站数据集条数与 messages.json 一致', n + ' / ' + REAL.length);

const peerName = await page.evaluate(() => ((window.DM_DATA_B || {}).meta || {}).peer_name || '');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'bili', 'meta.json'), 'utf8'));
chk(peerName === meta.peer_name && !!peerName, '聊天对象昵称正确', peerName);

const av = await page.evaluate(() => ((window.DM_DATA_B || {}).meta || {}).peer_avatar_local || '');
chk(av === 'bili/images/avatar_peer.jpg', '对方头像已接入查看页（名片解析 bug 的最终验收）', av);

const bubbles = await page.locator('.msg .bubble, .msg .bcard, .wcard').count();
chk(bubbles > 50, 'B站视图渲染出大量气泡', bubbles + ' 个');
await page.screenshot({ path: path.join(OUT, '10-bili-real.png'), fullPage: false });

// ---- 2) B站表情渲染成图 ----
const emoInfo = await page.evaluate(() => {
  const dict = window.DM_FACES_B || {};
  const n = Object.keys(dict.phrase || {}).length + Object.keys(dict.ee || {}).length;
  const imgs = document.querySelectorAll('.imgs img.emoji');
  return { keys: n, top: Object.keys(dict), imgs: imgs.length, firstSrc: imgs[0] ? imgs[0].getAttribute('src') : '' };
});
chk(emoInfo.keys > 1000, 'B站表情字典已载入（phrase + ee）', emoInfo.keys + ' 条');
chk(emoInfo.imgs > 0, '渲染出表情图（img.emoji）', emoInfo.imgs + ' 张，示例 ' + (emoInfo.firstSrc || '-'));
// 两条本地路径都合法：
//   · 内置面板表情（[tv_doge] 这类）→ bili/faces/<sha1>.png
//   · 用户发的自定义大表情        → bili/images/face_xxxx.gif
const esrc = emoInfo.firstSrc || '';
chk(!/^https?:/.test(esrc) && /^bili\/(faces|images)\//.test(esrc), '表情图指向本地文件（不是远端 URL）', esrc);

// ---- 3) 失效图降级：搜索到那条消息，看是否出现「原图已失效」占位 ----
if (deadCase) {
  const q = (deadCase.m.card && deadCase.m.card.title) || deadCase.m.id;
  await page.fill('#q', q);
  await page.waitForTimeout(1500);
  const dead = await page.locator('.imgdead').count();
  const broken = await page.evaluate(() => {
    // 仍在页面上、且 naturalWidth===0 的 <img>（= 破图）
    return Array.prototype.filter.call(document.querySelectorAll('.imgs img'), el => el.complete && el.naturalWidth === 0).length;
  });
  chk(dead >= 1 || broken === 0, '失效图被降级成占位，页面上没有破图',
    '占位 ' + dead + ' 个 / 破图 ' + broken + ' 个');
  await page.screenshot({ path: path.join(OUT, '11-bili-deadimg.png') });
  await page.fill('#q', '');
  await page.waitForTimeout(600);
} else {
  chk(true, '失效图降级（当前数据无此用例，跳过）');
}

// ---- 4) 统计面板：与独立重算一致 ----
// ⚠ 换日口径（2026-09-18 起）：一天 = 当天 05:00 → 次日 05:00，
//   所以这里也必须先减 5 小时再取年月日，否则算出来的天数与页面差一档。
const CUT5 = 5 * 3600 * 1000;
const ldayOf = (ts) => {
  const d = new Date(ts - CUT5);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const stat = await page.evaluate((cut) => {
  const t = document.body.innerText;
  const d = ((window.DM_DATA_B || {}).messages) || [];
  const byDay = {};
  for (const m of d) {
    if (m.ts == null) continue;
    const dt = new Date(m.ts - cut);
    const k = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    byDay[k] = (byDay[k] || 0) + 1;
  }
  return { days: Object.keys(byDay).length, total: d.length, text: t };
}, CUT5);
chk(stat.total === REAL.length, '统计口径读到全部消息', stat.total + ' 条');
chk(stat.days > 100, '覆盖天数合理', stat.days + ' 天');
const hasBiliWord = /B站|Bilibili/i.test(stat.text) || /示例UP主/.test(stat.text);
chk(hasBiliWord, 'B站视图文案/对象正确');

// ---- 5) 图片内容描述 / 图内文字索引是否接上 ----
// 注意：两个索引里都有一个 `_meta` 统计块（微博那套本来也有），计数时要排除。
const idxCnt = await page.evaluate(() => {
  const c = o => Object.keys(o || {}).filter(k => !k.startsWith('_')).length;
  return { ocr: c(window.DM_OCR_B), vlm: c(window.DM_VLM_B), ocrW: c(window.DM_OCR), vlmW: c(window.DM_VLM) };
});
console.log('    索引条数：B站 OCR ' + idxCnt.ocr + ' / VLM ' + idxCnt.vlm + '　微博 OCR ' + idxCnt.ocrW + ' / VLM ' + idxCnt.vlmW);
chk(idxCnt.ocr > 0 && idxCnt.vlm > 0, 'B站 OCR / 图片描述索引都已接入页面');
chk(idxCnt.ocrW > 0 && idxCnt.vlmW > 0, '微博索引未被 B站数据串掉（双源隔离）');

// ---- 6) 「自动回复」一键隐藏（B站：msg_source 结构化判定，不是猜文案）----
console.log('\n  --- 6. 自动回复一键隐藏 ---');
// 期望值用真实数据独立重算，绝不复用页面里的 msgKind，否则等于自己验自己
const isAuto = m => (m.msg_source >= 8 && m.msg_source <= 11) || m.msg_source === 17 || m.media_type === 16;
const autoExpect = REAL.filter(isAuto).length;
const AUTO_TEXT = '（对方的自动回复文案）';   // 对方的固定自动回复文案之一，正常聊天里不会出现

/* 复现页面的「可搜索字段」haystack：text / sender / type，加卡片的 title·sub·text·url·bvid，
   再加图片的 OCR 与 VLM 文本。必须按同一口径重算，期望值才站得住 ——
   实测就有一条：**用户发的截图**，它的 OCR 里含「（对方的自动回复文案）?」，
   它不是自动回复消息，隐藏自动回复后理应留在列表里。 */
const hay = (() => {
  const O = JSON.parse(fs.readFileSync(path.join(ROOT, 'bili', 'ocr.json'), 'utf8'));
  const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'bili', 'vlm.json'), 'utf8'));
  return m => {
    let s = (m.text || '') + ' ' + (m.sender || '') + ' ' + (m.type || '');
    for (const im of (m.images || [])) {
      if (!im.local) continue;
      const f = path.basename(im.local);
      if (O[f] && O[f].t) s += ' ' + String(O[f].t).replace(/\s+/g, ' ');
      if (V[f] && V[f].d) s += ' ' + String(V[f].d).replace(/\s+/g, ' ');
    }
    if (m.card) s += ' ' + [m.card.author, m.card.kind, m.card.title, m.card.sub,
      m.card.text, m.card.url, m.card.bvid, m.card.extra].join(' ');
    for (const l of (m.links || [])) s += ' ' + (l.short || '') + ' ' + (l.long || '') + ' ' + (l.title || '');
    return s.toLowerCase();
  };
})();
const W_LC = AUTO_TEXT.toLowerCase();
const hitsAll = REAL.filter(m => hay(m).includes(W_LC)).length;
const hitsKept = REAL.filter(m => hay(m).includes(W_LC) && !isAuto(m)).length;
console.log('    期望隐藏 ' + autoExpect + ' 条；检索词「' + AUTO_TEXT + '」命中 ' + hitsAll +
  ' 条，其中非自动回复 ' + hitsKept + ' 条（截图 OCR 里的那类，应保留）');

const chip = page.locator('#autoChip');
chk(await chip.count() === 1, '存在「自动回复」切换按钮');
const chipTip = (await chip.getAttribute('title')) || '';
chk(/B站/.test(chipTip), '按钮说明按数据源切换（当前为 B站 口径）', chipTip.slice(0, 34) + '…');

const readHidden = async () => {           // -1 = 页面上压根没有「已隐藏 N 条」这句
  const t = await page.locator('#found').innerText().catch(() => '');
  const m = /已隐藏自动回复\s*([\d,]+)\s*条/.exec(t);
  return m ? Number(m[1].replace(/,/g, '')) : -1;
};
const hitCount = async (word) => {
  await page.fill('#q', word == null ? '' : word);
  await page.waitForTimeout(1300);
  const t = await page.locator('#found').innerText();
  const m = /命中\s*([\d,]+)\s*条/.exec(t);
  return { n: m ? Number(m[1].replace(/,/g, '')) : -1, txt: t.replace(/\s+/g, ' ') };
};

chk(await readHidden() === -1, '初始为「未隐藏」状态');

await chip.click(); await page.waitForTimeout(900);
chk(await chip.getAttribute('aria-pressed') === 'true', '点击后按钮进入选中态');
const h1 = await readHidden();
chk(h1 === autoExpect, '自报隐藏条数 = 独立重算', h1 + ' / ' + autoExpect);

const afterHide = await hitCount(AUTO_TEXT);
chk(afterHide.n === hitsKept, '隐藏后只剩「非自动回复」的那几条命中',
  afterHide.n + ' / ' + hitsKept + '　' + afterHide.txt);
await page.screenshot({ path: path.join(OUT, '12-bili-hideauto.png') });

await chip.click(); await page.waitForTimeout(900);
const afterShow = await hitCount(AUTO_TEXT);
chk(afterShow.n === hitsAll, '取消隐藏后命中数完全恢复', afterShow.n + ' / ' + hitsAll);
await hitCount(null); await page.waitForTimeout(400);
chk(await readHidden() === -1, '关闭后不再自报隐藏条数');

// 双源状态隔离：切到微博，按钮说明与隐藏状态都应各归各
await page.locator('#srcSw button').nth(0).click(); await page.waitForTimeout(1100);
const wTip = (await page.locator('#autoChip').getAttribute('title')) || '';
chk(/对方的自动回复/.test(wTip), '切回微博后说明回到微博口径（双源状态隔离）', wTip.slice(0, 24) + '…');
await page.locator('#srcSw button').nth(1).click(); await page.waitForTimeout(1100);

// ---- 7) 图片 OCR / 图片理解（VLM）：索引真的能在页面上用起来 ----
console.log('\n  --- 7. 图片 OCR / 图片理解 ---');
const OCRB = JSON.parse(fs.readFileSync(path.join(ROOT, 'bili', 'ocr.json'), 'utf8'));
const VLMB = JSON.parse(fs.readFileSync(path.join(ROOT, 'bili', 'vlm.json'), 'utf8'));
// 取一段「不含空格的连续片段」当检索词 —— 含空格的片段会被 DOM 的换行拆开而误判
const segOf = (raw, min) => {
  const parts = String(raw).split(/[\s，。、；：！？…—\-【】（）()「」“”"'’/|]+/).filter(s => s.length >= min);
  parts.sort((a, b) => b.length - a.length);
  return parts.length ? parts[0].slice(0, 12) : null;
};
const findCase = (obj, field, min) => {
  let best = null;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_') || !v || !v[field]) continue;
    const seg = segOf(v[field], min);
    if (seg && (!best || seg.length > best.seg.length)) best = { file: k, seg };
  }
  return best;
};
const ocrCase = findCase(OCRB, 't', 5);
const vlmCase = findCase(VLMB, 'd', 6);
chk(!!ocrCase, 'OCR 索引里有可检索的图内文字', ocrCase ? ocrCase.file + ' → 「' + ocrCase.seg + '」' : '无');
chk(!!vlmCase, '图片描述索引里有可检索的条目', vlmCase ? vlmCase.file + ' → 「' + vlmCase.seg + '」' : '无');

const statBar = (await page.locator('#stats').innerText()).replace(/\s+/g, ' ');
chk(/图片可搜索/.test(statBar), '顶部统计显示「图片可搜索 N 张」', statBar.slice(0, 68));

if (ocrCase) {
  const r = await hitCount(ocrCase.seg);
  chk(r.n > 0, '按图内文字（OCR）能搜到对应消息', '命中 ' + r.n + ' 条 · 词「' + ocrCase.seg + '」');
  const vis = await page.evaluate(s => document.body.innerText.includes(s), ocrCase.seg);
  chk(vis, '图内文字在气泡上可见（不只是躺在索引里）');
}
if (vlmCase) {
  const r = await hitCount(vlmCase.seg);
  chk(r.n > 0, '按图片描述（VLM）能搜到对应消息', '命中 ' + r.n + ' 条 · 词「' + vlmCase.seg + '」');
  const vis = await page.evaluate(s => document.body.innerText.includes(s), vlmCase.seg);
  chk(vis, '图片描述在气泡上可见（不只是躺在索引里）');
  await page.screenshot({ path: path.join(OUT, '13-bili-imgidx.png') });
}
await hitCount(null); await page.waitForTimeout(500);

// ---- 8) 统计口径：真实数据里 gift 桶为 0，该走的「不渲染」分支 ----
// （verify_bili.mjs 跑的是仿真数据，覆盖的是 gift>0 那一支；这里补上另一半）
const sysReal = REAL.filter(m => [5, 10, 18].includes(m.media_type)).length;
const giftReal = REAL.filter(m => !isAuto(m) && ![5, 10, 18].includes(m.media_type) &&
  (m.media_type === 13 || (m.media_type >= 301 && m.media_type <= 306) ||
   (m.from !== 'me' && m.from !== 'peer'))).length;
await page.locator('#statBtn').click(); await page.waitForTimeout(900);
const statTxt = (await page.locator('#stat').innerText()).replace(/\s+/g, ' ');
chk(/不计入（\d+ 类/.test(statTxt), '口径标题按实际桶数动态显示',
  (/不计入（\d+ 类/.exec(statTxt) || ['未匹配'])[0]);
chk(/系统通知与撤回提示/.test(statTxt), '官方通知（开播/视频上线/预约）已并入「系统通知与撤回提示」');
chk(new RegExp('系统通知与撤回提示[^0-9]{0,12}?' + sysReal + '\\s*条').test(statTxt),
  '系统通知+撤回条数 = 独立重算', sysReal + ' 条');
chk(giftReal === 0 ? !/其它非双方消息/.test(statTxt) : true,
  'gift 桶为空时不渲染该行（真实数据 gift=' + giftReal + '）');

/* ---- 8b) 换日口径（每天 05:00）：真实浏览器里的日轴复核 ----
   独立重算「逻辑日」→ 与热力图方格逐一对照。这部分 jsdom 那边由 verify_daycut.mjs 覆盖，
   这里补的是「真实浏览器 + 真实布局」这一层。 */
const dayInfo = await page.evaluate((cut) => {
  const pad = n => String(n).padStart(2, '0');
  const dset = new Set();
  for (const m of ((window.DM_DATA_B || {}).messages) || []) {
    if (m.ts == null) continue;
    const d = new Date(m.ts - cut);
    dset.add(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
  }
  const cells = [...document.querySelectorAll('#heat rect[data-day]')].map(e => e.getAttribute('data-day'));
  return {
    days: dset.size, cells: cells.length,
    first: cells[0] || null, last: cells[cells.length - 1] || null,
    range: document.getElementById('statRange').textContent.replace(/\s+/g, ' '),
    hint: document.getElementById('chartHint').textContent.replace(/\s+/g, ' '),
  };
}, CUT5);
chk(/05:00 分界/.test(dayInfo.range), '统计面板区间行标注「按每天 05:00 分界」', dayInfo.range.slice(0, 66));
chk(/05:00 分界/.test(dayInfo.hint), '趋势图提示行也写明 05:00 分界');
chk(dayInfo.cells >= dayInfo.days && dayInfo.days > 100,
  '热力图方格覆盖所有出现过的逻辑日', '方格 ' + dayInfo.cells + ' / 逻辑日 ' + dayInfo.days);

const tsB = REAL.filter(m => m.ts != null).map(m => m.ts);
const firstLog = ldayOf(Math.min(...tsB)), lastLog = ldayOf(Math.max(...tsB));
const firstNat = (() => { const d = new Date(Math.min(...tsB)); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
chk(dayInfo.first === firstLog && dayInfo.last === lastLog,
  '★ 热力图首尾 = 最早 / 最新消息的**逻辑日**', `${dayInfo.first} → ${dayInfo.last} ｜ 期望 ${firstLog} → ${lastLog}`);
chk(firstLog !== firstNat, '★ 最早消息压在 00:00~05:00 里 → 逻辑日比自然日早一天',
  `逻辑日 ${firstLog} vs 自然日 ${firstNat}`);
await page.locator('#statClose').click(); await page.waitForTimeout(600);

// ---- 9) 分享卡片可读性：链接 / 正文的对比度 + 标题不重复 ----
// 真实故障（2026-09-15 用户报「我这边分享内容下方的链接是白字，看不清」）：
//   分享视频卡片是「有封面图 + 无文字」→ 气泡带 .plain（背景透明），
//   但 .msg.me .bubble 的「白字」还在 → 白字直接落在浅色页面上，对比度 1.06:1。
// 这里把「对比度」本身固化成断言，而不是只断言颜色值，免得再退化。
console.log('\n  --- 9. 分享卡片可读性（对比度）---');
const MEASURE = () => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(',').map(s => parseFloat(s.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  // 把元素自身的底色 + 所有祖先的底色（含渐变色标）由外向内合成出「实际渲染背景」
  const bgOf = (el) => {
    const layers = [];
    let n = el;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0) layers.push(bg);
      const bi = cs.backgroundImage;
      if (bi && bi !== 'none' && /gradient/.test(bi)) {
        const cols = bi.match(/rgba?\([^)]+\)/g) || [];
        if (cols.length) layers.push(parse(cols[0]));
      }
      n = n.parentElement;
    }
    let acc = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
    return acc;
  };
  const effBg = (el) => {
    const own = parse(getComputedStyle(el).backgroundColor);
    const base = bgOf(el.parentElement || el);
    return own && own.a > 0 ? over(own, base) : base;
  };
  const out = { links: [], plainBubs: [], gradBubs: [], dupTitle: 0, cardCount: 0 };
  for (const el of document.querySelectorAll('.wcard.bc .wcard-link')) {
    out.links.push({ me: !!el.closest('.msg.me'),
      contrast: +ratio(parse(getComputedStyle(el).color), effBg(el)).toFixed(2) });
  }
  for (const bub of document.querySelectorAll('.msg.me .bubble')) {
    const cs = getComputedStyle(bub);
    const item = { contrast: +ratio(parse(cs.color), effBg(bub)).toFixed(2),
      white: /rgb\(255,\s*255,\s*255\)/.test(cs.color) };
    (bub.classList.contains('plain') ? out.plainBubs : out.gradBubs).push(item);
  }
  for (const c of document.querySelectorAll('.wcard.bc')) {
    const ts = [...c.querySelectorAll('.wcard-t')].map(x => (x.textContent || '').trim()).filter(Boolean);
    if (ts.length > 1) {
      out.cardCount++;
      if (new Set(ts).size !== ts.length) out.dupTitle++;
    }
  }
  return out;
};
const themeData = [];
for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(350);
  themeData.push({ theme, ...(await page.evaluate(MEASURE)) });
}
await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
await page.waitForTimeout(300);

for (const t of themeData) {
  const meLinks = t.links.filter(l => l.me);
  chk(meLinks.length > 0, '[' + t.theme + '] 我方分享卡片渲染出链接', meLinks.length + ' 个');
  const worst = t.links.length ? Math.min(...t.links.map(l => l.contrast)) : 0;
  chk(t.links.length > 0 && worst >= 4.5, '[' + t.theme + '] 卡片链接文字对比度 ≥ 4.5:1（原 1.06:1 不可见）',
    '最低 ' + worst + ':1 / 共 ' + t.links.length + ' 个');
  const pworst = t.plainBubs.length ? Math.min(...t.plainBubs.map(b => b.contrast)) : 0;
  chk(t.plainBubs.length > 0 && pworst >= 4.5,
    '[' + t.theme + '] 透明底气泡（.plain，分享卡片的真实形态）正文字色对比度 ≥ 4.5:1',
    '最低 ' + pworst + ':1 / 共 ' + t.plainBubs.length + ' 个');
  // 反向守卫：带紫渐变气泡上的白字是刻意设计，别被这次的改动顺手抹掉
  chk(t.gradBubs.length > 0 && t.gradBubs.every(b => b.white),
    '[' + t.theme + '] 紫渐变气泡仍用白字（未被本次改动波及）', t.gradBubs.length + ' 个');
  chk(t.dupTitle === 0, '[' + t.theme + '] 卡片标题不重复渲染（title===text 时只出一次）',
    t.dupTitle + ' / ' + t.cardCount + ' 条多段卡片重复');
}

// ---- 10) 无 JS 报错 ----
const real = errs.filter(e => !/Could not load|Failed to load resource|net::ERR|ERR_FILE_NOT_FOUND/i.test(e));
chk(real.length === 0, '页面无 JS 报错', real.slice(0, 3).join(' ; ') || '干净');

await browser.close();

const pass = results.filter(r => r.ok).length;
console.log('\n========================================');
console.log('  通过 ' + pass + ' / ' + results.length);
console.log('  截图目录: ' + OUT);
console.log('========================================');
process.exit(pass === results.length ? 0 : 1);
