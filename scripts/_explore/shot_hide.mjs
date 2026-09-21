/* 真实浏览器验证：隐藏消息 + 右键菜单（2026-09-16）
   ------------------------------------------------------------
   为什么要另开一份真浏览器测试：jsdom 没有布局引擎，`getBoundingClientRect()`
   全是 0，菜单的**定位 / 可见性 / 是否被视口裁掉**在 jsdom 里根本测不出来；
   Playwright 的右键才是真的右键。浅色 + 深色各跑一遍，截图留档。

   用法：node scripts/_explore/shot_hide.mjs
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

const AUTO_W = (() => { try { const s = JSON.parse(fs.readFileSync(import.meta.dirname + '/../../sessions.json', 'utf8')); return ((s.sessions || []).find(x => x.key === 'weibo') || {}).autoReply || ''; } catch { return ''; } })(); // 自动回复文案取自 sessions.json（属个人内容，不写进代码）
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto('file:///' + path.join(ROOT, '查看备份.html').replace(/\\/g, '/'));
await page.waitForTimeout(900);

/* 页面内工具：挑一个「关键词全库唯一、且前 3 条里有自动回复」的消息 */
const pickSample = (key, autoExpr) => page.evaluate(({ key, autoExpr, AUTO }) => {
  const A = (key === 'bili' ? window.DM_DATA_B : window.DM_DATA).messages;
  /* autoExpr 是个箭头函数**表达式**，要包一层 return 才能拿到函数本身 */
  const isAuto = new Function('return (' + autoExpr + ')')();
  const uniq = (m) => {
    const t = (m.text || '').replace(/\s+/g, '');
    for (let len = 6; len <= Math.min(14, t.length); len++)
      for (let s = 0; s + len <= t.length; s++) {
        const c = t.slice(s, s + len);
        if (/[\x00-\x7F]/.test(c)) continue;
        let n = 0;
        for (const x of A) { if ((x.text || '').indexOf(c) >= 0) { n++; if (n > 1) break; } }
        if (n === 1) return c;
      }
    return null;
  };
  const out = [];
  for (let i = A.length - 4; i > A.length - 220 && i > 8; i--) {
    const m = A[i];
    if (isAuto(m, AUTO) || !m.id || !m.text || m.text.trim().length < 10) continue;
    const needAuto = [1, 2, 3].some(k => A[i - k] && isAuto(A[i - k], AUTO));
    const w = uniq(m);
    if (w) out.push({ ai: i, word: w, hasAutoNear: needAuto, autoNear: [1, 2, 3].map(k => i - k).filter(k => A[k] && isAuto(A[k], AUTO)) });
    if (out.length >= 8) break;
  }
  return out.sort((a, b) => (b.hasAutoNear - a.hasAutoNear) || 0);
}, { key, autoExpr, AUTO: AUTO_W });

const setQ = async (w) => {
  await page.evaluate((word) => {
    const el = document.getElementById('q');
    el.value = word;
    el.dispatchEvent(new Event('input'));
  }, w);
  await page.waitForTimeout(500);
};
const foundText = () => page.locator('#found').textContent();
const clickSrc = k => page.evaluate((kk) => {
  const b = [...document.querySelectorAll('#srcSw button')].find(x => x.dataset.src === kk);
  if (b) b.click();
}, k);

/* 对比度：逐层合成「实际渲染背景」再算 WCAG —— 颜色值对 ≠ 背景对（老规矩） */
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
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const el = document.querySelector(s);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const fg = parse(cs.color);
  const layers = [];
  let n = el;
  while (n && n.nodeType === 1) {
    const c2 = getComputedStyle(n);
    const bg = parse(c2.backgroundColor);
    if (bg && bg.a > 0) layers.push(bg);
    n = n.parentElement;
  }
  let acc = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
  const l1 = lum(fg), l2 = lum(acc);
  return {
    color: cs.color, bg: `rgb(${Math.round(acc.r)},${Math.round(acc.g)},${Math.round(acc.b)})`,
    ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100,
    border: cs.borderTopStyle, deco: cs.textDecorationLine,
  };
}, sel);

for (const theme of ['light', 'dark']) {
  console.log('\n=== ' + theme + ' ===');
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(300);
  await clickSrc('weibo');
  await page.waitForTimeout(700);

  /* ---------- 1. 隐藏自动回复后，上下文里不该有 [文字] ---------- */
  const autoOn = await page.evaluate(() => document.getElementById('autoChip').getAttribute('aria-pressed'));
  if (autoOn !== 'true') { await page.click('#autoChip'); await page.waitForTimeout(400); }
  const cands = (await pickSample('weibo',
    "(m,AUTO)=>(m.text||'').trim()===AUTO || false")).filter(c => c.hasAutoNear && c.autoNear.length);
  chk(cands.length > 0, '找到「前 3 条内有自动回复」的样本', cands.length + ' 个');

  let used = null;
  for (const c of cands.slice(0, 6)) {
    await setQ(c.word);
    const f = await foundText();
    if (/命中 1 条/.test(f) && await page.locator(`#chat .msg[data-ai="${c.ai}"]`).count() === 1) { used = c; break; }
  }
  chk(!!used, '样本在搜索里唯一命中', used ? `ai=${used.ai}` : '没找到');
  if (used) {
    await page.click(`#chat .msg[data-ai="${used.ai}"] [data-ctx="open"]`);
    await page.waitForTimeout(400);
    const ph = await page.locator('#chat .msg .body > div').evaluateAll(
      els => els.filter(e => /^\[[^\]]+\]$/.test(e.textContent.trim())).map(e => e.textContent.trim()));
    chk(ph.length === 0, '★ 浅/深主题下都不再出现 [文字] 占位气泡', ph.join(' | ') || '无');
    const autoRows = await page.locator('#chat .msg[data-ai]').evaluateAll(
      (els, { auto }) => els.filter(e => auto.includes(+e.dataset.ai)).length, { auto: used.autoNear });
    chk(autoRows === 0, '★ 上下文里没有自动回复的行', '命中 ' + autoRows);
    await page.screenshot({ path: path.join(OUT, `hide-1-ctx-${theme}.png`) });
    /* 侧栏提示行里写着「怎么恢复被隐藏的消息」，也得读得清 */
    if (theme === 'light') {
      const ctHint = await measureContrast('#ctxhint');
      chk(!!ctHint && ctHint.ratio >= 4.5, '侧栏上下文提示行的对比度 ≥ 4.5:1',
        ctHint ? `${ctHint.ratio}:1  字色 ${ctHint.color}` : 'null');
    }

    /* ---------- 2. 真右键 → 菜单 ---------- */
    const rowSel = `#chat .msg[data-ai="${used.ai}"] .bubble`;
    const rowBox = await page.locator(rowSel).boundingBox();
    await page.click(rowSel, { button: 'right' });
    await page.waitForTimeout(250);
    const menuVisible = await page.locator('.cmenu').isVisible();
    chk(menuVisible, '★ 真实右键 → 菜单可见');
    const mbox = await page.locator('.cmenu').boundingBox();
    chk(!!mbox && mbox.width > 100 && mbox.height > 30, '菜单有实际尺寸（不是 0×0）',
      mbox ? `${Math.round(mbox.width)}×${Math.round(mbox.height)}` : 'null');
    chk(!!mbox && mbox.x >= 0 && mbox.y >= 0 && mbox.x + mbox.width <= 1600 && mbox.y + mbox.height <= 1000,
      '菜单完整落在视口内（没被裁掉）', mbox ? `x=${Math.round(mbox.x)} y=${Math.round(mbox.y)}` : '');
    chk(!!rowBox && !!mbox && Math.abs(mbox.x - (rowBox.x + rowBox.width / 2)) < 240,
      '菜单出现在鼠标附近（不是跑到了角落）',
      mbox && rowBox ? `menu.x=${Math.round(mbox.x)} 点击点=${Math.round(rowBox.x + rowBox.width / 2)}` : '');
    const items = await page.locator('.cmenu button').allTextContents();
    chk(items.some(t => /隐藏这条消息/.test(t)), '★ 菜单第一项是「隐藏这条消息」', items.join(' / '));
    await page.screenshot({ path: path.join(OUT, `hide-2-menu-${theme}.png`) });

    /* ---------- 3. 点隐藏 ---------- */
    await page.click('.cmenu button[data-act="hide"]');
    await page.waitForTimeout(400);
    chk(!(await page.locator('.cmenu').isVisible()), '菜单自动收起');
    chk((await page.locator(`#chat .msg[data-ai="${used.ai}"]`).count()) === 0, '★ 隐藏后：消息从列表消失');
    const chipTxt = await page.locator('#hidChip').textContent();
    chk(/已隐藏 1 条/.test(chipTxt), '★ 侧栏出现「已隐藏 1 条」', chipTxt);
    chk(await page.locator('#hidChip').isVisible(), '侧栏按钮真的可见（不是 hidden 挡住）');
    await page.screenshot({ path: path.join(OUT, `hide-3-hidden-${theme}.png`) });

    /* ---------- 4. 上下文里的占位条 + 对比度 ---------- */
    /* 往里找 1~3 条邻居当锚点：关键词必须在搜索里唯一命中，否则锚点渲染不出来 */
    let nbAi = null, nbWord = null;
    for (let k = 1; k <= 3 && nbAi == null; k++) {
      const cand = await page.evaluate(({ ai }) => {
        const A = window.DM_DATA.messages;
        const m = A[ai];
        if (!m || !m.text || m.text.trim().length < 8) return null;
        const t = m.text.replace(/\s+/g, '');
        for (let len = 6; len <= Math.min(14, t.length); len++)
          for (let s = 0; s + len <= t.length; s++) {
            const c = t.slice(s, s + len);
            if (/[\x00-\x7F]/.test(c)) continue;
            let n = 0;
            for (const x of A) { if ((x.text || '').indexOf(c) >= 0) { n++; if (n > 1) break; } }
            if (n === 1) return c;
          }
        return null;
      }, { ai: used.ai - k });
      if (!cand) continue;
      await setQ(cand);
      if (/命中 1 条/.test(await foundText()) &&
          (await page.locator(`#chat .msg[data-ai="${used.ai - k}"] [data-ctx="open"]`).count()) > 0) {
        nbAi = used.ai - k; nbWord = cand;
      }
    }
    chk(nbAi != null, '找到能当锚点的邻居（关键词唯一命中）', nbAi == null ? '没找到' : `ai=${nbAi}`);
    if (nbAi != null) await page.click(`#chat .msg[data-ai="${nbAi}"] [data-ctx="open"]`);
    await page.waitForTimeout(400);
    const hidb = page.locator(`#chat .msg[data-ai="${used.ai}"] .hidb`).first();
    chk(await hidb.count() > 0, '★ 隐藏项在上下文里以占位条出现');
    if (await hidb.count()) {
      chk(await hidb.isVisible(), '占位条可见');
      const txt = (await hidb.textContent()).trim();
      chk(/已隐藏/.test(txt) && !txt.includes(used.word), '占位条只说明「已隐藏」，不泄漏原文', txt);
      const ct = await measureContrast(`#chat .msg[data-ai="${used.ai}"] .hidb`);
      chk(!!ct && ct.ratio >= 4.5, '★ 占位条文字对比度 ≥ 4.5:1', ct ? `${ct.ratio}:1  字色 ${ct.color} / 底 ${ct.bg}` : 'null');
      const ctBtn = await measureContrast(`#chat .msg[data-ai="${used.ai}"] .hidb .hbtn`);
      chk(!!ctBtn && ctBtn.ratio >= 4.5, '★ 占位条上「恢复」按钮的对比度 ≥ 4.5:1',
        ctBtn ? `${ctBtn.ratio}:1  字色 ${ctBtn.color}` : 'null');
      chk(!!ctBtn && ctBtn.deco === 'underline', '「恢复」有下划线（看得出是可点的）', ctBtn ? ctBtn.deco : '');
      chk(!!ct && ct.border === 'dashed', '占位条是虚线（视觉上区别于真气泡）', ct ? ct.border : '');
      await hidb.screenshot({ path: path.join(OUT, `hide-4-placeholder-${theme}.png`) });
      /* ---------- 5. 点占位条恢复 ---------- */
      await page.waitForTimeout(500);
      await hidb.click();
      await page.waitForTimeout(400);
      chk(await page.locator('#hidChip').isHidden(), '★ 点占位条 → 恢复，侧栏按钮消失');
      await setQ(used.word);
      chk((await page.locator(`#chat .msg[data-ai="${used.ai}"]`).count()) === 1, '恢复后：重新能搜到');
    }
  }
}

/* ---------- B站：msg_source 口径下也不能漏正文 ---------- */
console.log('\n=== B站 ===');
await clickSrc('bili');
await page.waitForTimeout(900);
const autoBOn = await page.evaluate(() => document.getElementById('autoChip').getAttribute('aria-pressed'));
if (autoBOn !== 'true') { await page.click('#autoChip'); await page.waitForTimeout(400); }
const bAuto = "(m)=>(m.msg_source>=8&&m.msg_source<=11)||m.msg_source===17||m.media_type===16";
const candsB = await pickSample('bili', bAuto);
let usedB = null;
for (const c of candsB.slice(0, 6)) {
  await setQ(c.word);
  if (/命中 1 条/.test(await foundText())) { usedB = c; break; }
}
chk(!!usedB, 'B站找到样本', usedB ? `ai=${usedB.ai}` : '没找到');
if (usedB) {
  await page.click(`#chat .msg[data-ai="${usedB.ai}"] [data-ctx="open"]`);
  await page.waitForTimeout(400);
  const phB = await page.locator('#chat .msg .body > div').evaluateAll(
    els => els.filter(e => /^\[[^\]]+\]$/.test(e.textContent.trim())).map(e => e.textContent.trim()));
  chk(phB.length === 0, '★ B站：上下文里没有 [文字] 占位', phB.join(' | ') || '无');
  const leak = await page.locator('#chat .msg[data-ai]').evaluateAll((els) => {
    const A = window.DM_DATA_B.messages;
    const isAuto = m => (m.msg_source >= 8 && m.msg_source <= 11) || m.msg_source === 17 || m.media_type === 16;
    return els.filter(e => {
      const m = A[+e.dataset.ai];
      return m && isAuto(m) && (e.textContent || '').length > 0;
    }).length;
  });
  chk(leak === 0, '★ B站：一条自动回复都没渲染出来（正文 + [文字] 都没有）', '漏 ' + leak + ' 行');
  await page.screenshot({ path: path.join(OUT, 'hide-5-bili-ctx.png') });
}

chk(pageErrors.length === 0, '全程无 JS 报错', pageErrors.slice(0, 2).join(' | ') || '无');
await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
await browser.close();

console.log('\n' + '='.repeat(56));
console.log(`真实浏览器（右键菜单 / 隐藏）：通过 ${pass.length} · 失败 ${fail.length}`);
if (fail.length) console.log('失败项：\n  · ' + fail.join('\n  · '));
console.log('截图：' + OUT);
console.log('='.repeat(56));
process.exit(fail.length ? 1 : 0);
