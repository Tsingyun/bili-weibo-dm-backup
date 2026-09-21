/* 真实浏览器验证：换日口径「每天 05:00」（2026-09-18）
   ------------------------------------------------------------
   为什么 jsdom 那边（verify_daycut.mjs）之外还要再开一份：
     · 「对比度」必须逐层合成**实际渲染背景**再算 —— jsdom 没有渲染器，
       getComputedStyle 拿不到合成后的底色，量不出来（本项目的老规矩：
       颜色值对 ≠ 背景对，见 ui-contrast-audit 技能）。
     · 这次顺手把「分隔条日期」的字色从 --muted（浅底 3.1:1，不达标）换成了
       --muted-strong，需要有真实测量来背书。
     · 截图留档：一眼看到「03:19 的消息挂在 1 月 31 日下面」。

   用法：node scripts/_explore/shot_daycut.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import { loadDep } from './_deps.mjs';

const { chromium } = loadDep('playwright');

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, 'scripts', '_explore', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const pass = [], fail = [];
const chk = (ok, label, extra) => {
  (ok ? pass : fail).push(label);
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  → ' + String(extra).slice(0, 150) : ''));
};
const info = t => console.log('  · ' + t);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto('file:///' + path.join(ROOT, '查看备份.html').replace(/\\/g, '/'));
await page.waitForTimeout(1000);

/* 对比度：逐层合成实际渲染背景 + WCAG 相对亮度（与 shot_hide / shot_bili_real 同一套） */
const measureContrast = (sel) => page.evaluate((s) => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x.trim()));
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
  const el = document.querySelector(s);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const fg = parse(cs.color);
  const layers = [];
  let n = el;
  while (n && n.nodeType === 1) {
    const bg = parse(getComputedStyle(n).backgroundColor);
    if (bg && bg.a > 0) layers.push(bg);
    n = n.parentElement;
  }
  let acc = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
  const l1 = lum(fg), l2 = lum(acc);
  return {
    color: cs.color, bg: `rgb(${Math.round(acc.r)},${Math.round(acc.g)},${Math.round(acc.b)})`,
    ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100,
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90),
  };
}, sel);

/* 页面内取「第一条分隔条 + 它下面第一条消息」的信息，用来看归属对不对 */
const head = await page.evaluate(() => {
  const day = document.querySelector('#chat .day');
  const msg = document.querySelector('#chat .msg[data-ai]');
  const W = window;
  const M = ((W.DM_DATA || {}).messages) || [];
  const m = msg ? M[Number(msg.getAttribute('data-ai'))] : null;
  const stamp = msg ? (msg.textContent.match(/\b\d{1,2}:\d{2}\b/) || [''])[0] : '';
  return {
    dayLabel: day ? day.textContent.replace(/\s+/g, ' ').trim() : null,
    dayTitle: day ? day.getAttribute('title') : null,
    dayMonth: day ? day.getAttribute('data-m') : null,
    stamp, ts: m ? m.ts : null,
    iso: m && m.ts ? new Date(m.ts).toLocaleString('sv-SE') : null,
  };
});

console.log('=== 1. 凌晨消息归到哪一天（改动最该被看见的位置）===');
chk(!!head.dayLabel && !!head.iso, '取到分隔条与首条消息', `${head.dayLabel} ｜ ${head.iso} ${head.stamp}`);
info('首屏分隔条：' + head.dayLabel + '（data-m=' + head.dayMonth + '）');
info('tooltip：' + head.dayTitle);

const logDay = head.ts != null ? (() => { const d = new Date(head.ts - 5 * 3600 * 1000);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; })() : '';
chk(!!head.dayLabel && head.dayLabel.indexOf(logDay) === 0,
  '★ 分隔条上的日期 = 该消息的**逻辑日**（自然日 − 1 天）', `${head.dayLabel} ｜ 期望以 ${logDay} 开头`);
chk(/05:00 分界/.test(head.dayTitle || '') && /前一天/.test(head.dayTitle || ''),
  '★ 分隔条 tooltip 说明 05:00 分界与「算前一天」', head.dayTitle);

/* 上面那条断言依赖「首屏第一条消息恰好是凌晨的」，是撞运气 —— 数据一变就误报红。
   改成：自己挑一条**确实落在 00:00~05:00** 的消息，跳到它所属的逻辑日，看它挂在谁下面。
   两个挑选约束，都是被真实数据教出来的：
     · 挑「数组中间」的逻辑日 —— 聊天列表是**窗口化渲染**的（DOM 里只留约 CHUNK 条气泡），
       跳到离末尾太近的日期会被窗口夹住、DOM 首条不再是落点，就测不出边界。
     · 挑「当天消息条数少」的逻辑日 —— 分隔条在组首、凌晨消息在组尾，中间隔着一整天；
       组太大时两者同屏不了，截图就看不出「凌晨消息挂在昨天下面」。
   CHUNK 从首屏气泡数量量出来，不写死。 */
const CHUNK = await page.evaluate(() => document.querySelectorAll('#chat .msg[data-ai]').length);

const tgtRaw = await page.evaluate(() => {
  const p2 = n => String(n).padStart(2, '0');
  const lday = t => { const d = new Date(t - 5 * 3600 * 1000);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
  const M = ((window.DM_DATA || {}).messages) || [];
  const byDay = new Map();
  for (let i = 0; i < M.length; i++) {
    const m = M[i];
    if (!m || !m.ts) continue;
    const k = lday(m.ts);
    let e = byDay.get(k);
    if (!e) { e = { day: k, idx: [], pre: [] }; byDay.set(k, e); }
    e.idx.push(i);
    if (new Date(m.ts).getHours() < 5) e.pre.push(i);   // 00:00~05:00 → 算前一天
  }
  const mid = M.length / 2;
  const pick = maxN => {
    let best = null;
    for (const e of byDay.values()) {
      if (!e.pre.length || e.idx.length > maxN) continue;
      const dist = Math.abs(e.idx[0] - mid);
      if (!best || dist < best.dist) best = { dist, e };
    }
    return best ? best.e : null;
  };
  const e = pick(6) || pick(12) || pick(Infinity);        // 先找「短组」，找不到再放宽
  if (!e) return null;
  const ai = e.pre[0];                    // 该逻辑日里最早的那条凌晨消息
  const start = e.idx[0];                 // 该逻辑日的第一条 = 跳转落点
  /* 独立算一遍落点时间戳：第一条 ts ≥ 当日 05:00 */
  const d0 = new Date(e.day + 'T05:00:00').getTime();
  let startTs = null;
  for (let i = 0; i < M.length; i++) {
    if (M[i] && M[i].ts && M[i].ts >= d0) { startTs = M[i].ts; break; }
  }
  return { ai, day: e.day, ts: M[ai].ts, iso: new Date(M[ai].ts).toLocaleString('sv-SE'),
           natural: new Date(M[ai].ts).toLocaleString('sv-SE').slice(0, 10),
           start, startTs, total: M.length, groupSize: e.idx.length };
});
chk(!!tgtRaw, '★ 数据里确实存在 00:00~05:00 的消息（否则这条改动看不见效果）',
  tgtRaw && `${tgtRaw.iso}（自然日 ${tgtRaw.natural} → 逻辑日 ${tgtRaw.day}）`);
/* 拿不到就退回空对象，让下面每条断言都照常跑、照常报红 —— 不要静默跳过 */
const T = tgtRaw || { ai: -1, day: '', iso: '—', natural: '', start: -1, startTs: null, total: 0 };
info('挑中的凌晨消息：' + T.iso + '　逻辑日 ' + T.day
  + '　（该逻辑日共 ' + (T.groupSize || '?') + ' 条 · 窗口大小 ' + CHUNK + '）');

await page.locator('#jump').fill(T.day);
await page.locator('#jump').dispatchEvent('change');
await page.waitForTimeout(700);

/* 在真实 DOM 里核对两件事：
   ① 这条凌晨消息头顶最近的那条分隔条写的是它的**逻辑日**；
   ② 「跳到日期」落点是当天 05:00 后的第一条，而不是当天 00:00。
   用 compareDocumentPosition 找「前驱 .day」，不依赖分隔条与消息的嵌套层级。 */
const under = await page.evaluate((ai) => {
  const msgs = [...document.querySelectorAll('#chat .msg[data-ai]')];
  const days = [...document.querySelectorAll('#chat .day')];
  const M = ((window.DM_DATA || {}).messages) || [];
  const out = { rendered: msgs.length, dayCount: days.length,
                firstAi: null, firstTs: null, hit: null };
  const first = msgs[0];
  if (first) {
    out.firstAi = Number(first.dataset.ai);
    const fm = M[Number(first.dataset.ai)];
    out.firstTs = fm && fm.ts ? fm.ts : null;
  }
  const el = msgs.find(x => x.getAttribute('data-ai') === String(ai));
  if (el && M[ai]) {
    const d = days.filter(x => x.compareDocumentPosition(el) & 4).pop();
    out.hit = { iso: new Date(M[ai].ts).toLocaleString('sv-SE'),
                label: d ? d.textContent.replace(/\s+/g, ' ').trim() : null,
                dataM: d ? d.getAttribute('data-m') : null };
    el.scrollIntoView({ block: 'center' });
  }
  return out;
}, T.ai);
info('DOM 里渲染了 ' + under.dayCount + ' 条分隔条 / ' + under.rendered + ' 条消息气泡');

/* 先证明测点本身有效：落点没被窗口夹住，否则下面的「DOM 首条 = 落点」不成立 */
chk(T.start <= T.total - CHUNK, '测点没被窗口夹住（选中的凌晨消息离末尾足够远）',
  `落点下标 ${T.start} · 窗口 ${CHUNK} · 总数 ${T.total}`);
chk(!!under.hit, '跳到该逻辑日后那条凌晨消息仍在渲染窗口里（能核对归属）', under.hit && under.hit.iso);

const fmtCn = ymd => ymd.replace(/^(\d{4})-(\d{2})-(\d{2})$/,
  (_, y, m, d) => `${+y}年${+m}月${+d}日`);
const expLabel = fmtCn(T.day), naturalLabel = fmtCn(T.natural), expMonth = T.day.slice(0, 7);
chk(!!under.hit && !!under.hit.label && under.hit.label.indexOf(expLabel) === 0,
  '★ 凌晨消息挂在「逻辑日」那条分隔条下',
  under.hit ? `${under.hit.iso} → ${under.hit.label} ｜ 期望以 ${expLabel} 开头` : '没找到');
chk(!!under.hit && !!under.hit.label && under.hit.label.indexOf(naturalLabel) !== 0,
  '★ 它**没有**挂在自然日那条分隔条下（旧口径会挂错）',
  under.hit ? `它的自然日是 ${T.natural}（${naturalLabel}）` : '没找到');
chk(!!under.hit && under.hit.dataM === expMonth,
  '★ 它所在的月份也按逻辑日归属（月份栏同口径）',
  under.hit ? `data-m=${under.hit.dataM} ｜ 期望 ${expMonth}` : '没找到');
chk(under.firstAi === T.start && under.firstTs === T.startTs,
  '★ 跳转落点 = 独立算出的「当天 05:00 后的第一条」（不是当天 00:00）',
  `DOM 首条 #${under.firstAi} `
  + (under.firstTs != null ? new Date(under.firstTs).toLocaleString('sv-SE') : '—')
  + ` ｜ 期望 #${T.start} `
  + (T.startTs != null ? new Date(T.startTs).toLocaleString('sv-SE') : '—'));
chk(under.firstTs != null && T.day && under.firstTs >= Date.parse(T.day + 'T05:00:00'),
  '★ 落点时间戳 ≥ 当天 05:00（没落到前一天凌晨）',
  under.firstTs != null ? new Date(under.firstTs).toLocaleString('sv-SE') : '取不到');

console.log('\n=== 2. 对比度（浅色 / 深色）===');
const ratios = {};
for (const theme of ['light', 'dark']) {
  await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(250);

  const d = await measureContrast('#chat .day span');
  chk(!!d, '[' + theme + '] 取到分隔条日期元素');
  if (d) {
    ratios[theme] = { day: d.ratio };
    chk(d.ratio >= 4.5, '[' + theme + '] ★ 分隔条日期对比度 ≥ 4.5:1（旧为 --muted，浅底仅 3.1:1）',
      `${d.ratio}:1（字色 ${d.color} / 底 ${d.bg}）`);
  }

  const note = await measureContrast('#dayCutNote');
  chk(!!note && note.ratio >= 4.5, '[' + theme + '] 侧栏换日提示对比度 ≥ 4.5:1',
    note ? note.ratio + ':1（字色 ' + note.color + ' / 底 ' + note.bg + '）' : '取不到');
  if (note) ratios[theme].note = note.ratio;

  // 统计面板里的「附带说明」那一行
  await page.locator('#statBtn').click();
  await page.waitForTimeout(500);
  const hint = await measureContrast('#chartHint');
  chk(!!hint && hint.ratio >= 4.5, '[' + theme + '] 趋势图提示行对比度 ≥ 4.5:1',
    hint ? hint.ratio + ':1（字色 ' + hint.color + ' / 底 ' + hint.bg + '）' : '取不到');
  if (hint) ratios[theme].hint = hint.ratio;
  const cut = await measureContrast('#chartHint .cutnote');
  chk(!!cut && cut.ratio >= 4.5, '[' + theme + '] 提示行里的「05:00 分界」补充说明对比度 ≥ 4.5:1',
    cut ? cut.ratio + ':1' : '取不到');
  if (cut) ratios[theme].cut = cut.ratio;

  const rangeTxt = await page.locator('#statRange').innerText();
  chk(/05:00 分界/.test(rangeTxt), '[' + theme + '] 统计面板标题标注 05:00 分界', rangeTxt.slice(0, 60));
  await page.locator('#statClose').click();
  await page.waitForTimeout(300);

  // 截图 ①：那条凌晨消息 + 它头顶的分隔条（旧口径会写错日期）
  if (under.hit && T.ai >= 0) {
    await page.locator('#chat .msg[data-ai="' + T.ai + '"]').evaluate(el => {
      /* 对准「那条分隔条」而不是气泡本身，否则日期栏会被滚出画面 */
      const days = [...document.querySelectorAll('#chat .day')];
      const d = days.filter(x => x.compareDocumentPosition(el) & 4).pop();
      (d || el).scrollIntoView({ block: 'start' });
    });
    await page.evaluate(() => window.scrollBy(0, -70));   // 避开顶部吸顶条
    await page.waitForTimeout(250);
    const file0 = path.join(OUT, 'daycut-0-pre5-' + theme + '.png');
    await page.screenshot({ path: file0, clip: { x: 276, y: 0, width: 1000, height: 620 } });
    chk(fs.existsSync(file0) && fs.statSync(file0).size > 3000,
      '[' + theme + '] 凌晨消息截图已留存 ' + path.basename(file0),
      fs.existsSync(file0) ? Math.round(fs.statSync(file0).size / 1024) + ' KB' : '未生成');
  }

  // 截图 ②：首屏那段分隔条
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  const file = path.join(OUT, 'daycut-1-head-' + theme + '.png');
  await page.screenshot({ path: file, clip: { x: 276, y: 0, width: 1000, height: 520 } });
  chk(fs.existsSync(file) && fs.statSync(file).size > 3000, '[' + theme + '] 截图已留存 ' + path.basename(file),
    fs.existsSync(file) ? Math.round(fs.statSync(file).size / 1024) + ' KB' : '未生成');

  // 统计面板整体截图（含 heatmap / 提示行）
  await page.locator('#statBtn').click();
  await page.waitForTimeout(600);
  const file2 = path.join(OUT, 'daycut-2-stat-' + theme + '.png');
  await page.screenshot({ path: file2 });
  chk(fs.existsSync(file2), '[' + theme + '] 统计面板截图已留存 ' + path.basename(file2));
  await page.locator('#statClose').click();
  await page.waitForTimeout(200);
}

console.log('\n=== 3. B站同样口径 ===');
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#srcSw button[data-src]')].find(x => x.dataset.src === 'bili');
  if (b) b.click();
});
await page.waitForTimeout(900);
const bhead = await page.evaluate(() => {
  const day = document.querySelector('#chat .day');
  const msg = document.querySelector('#chat .msg[data-ai]');
  const M = ((window.DM_DATA_B || {}).messages) || [];
  const m = msg ? M[Number(msg.getAttribute('data-ai'))] : null;
  return { label: day ? day.textContent.replace(/\s+/g, ' ').trim() : null,
           iso: m && m.ts ? new Date(m.ts).toLocaleString('sv-SE') : null,
           ts: m ? m.ts : null };
});
const bLog = bhead.ts != null ? (() => { const d = new Date(bhead.ts - 5 * 3600 * 1000);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; })() : '';
chk(!!bhead.label && bhead.label.indexOf(bLog) === 0,
  '★ B站首条分隔条同样按逻辑日归属', `${bhead.label} ｜ ${bhead.iso} ｜ 期望以 ${bLog} 开头`);

chk(pageErrors.length === 0, '页面无 JS 报错', pageErrors.slice(0, 3).join(' ; ') || '干净');

info('对比度汇总：' + JSON.stringify(ratios));
await browser.close();

console.log('\n' + '='.repeat(60));
console.log(`换日口径（真实浏览器）：通过 ${pass.length} · 失败 ${fail.length} · 合计 ${pass.length + fail.length}`);
if (fail.length) console.log('失败项：\n  · ' + fail.join('\n  · '));
console.log('='.repeat(60));
process.exit(fail.length ? 1 : 0);
