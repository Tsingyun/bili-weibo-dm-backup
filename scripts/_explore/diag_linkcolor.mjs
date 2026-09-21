/* 诊断：B站视图里「我」发的分享卡片，下方链接文字的实际颜色与对比度。
   只读，不改动页面。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// jsdom / playwright 装在托管 node 工作区，靠 NODE_PATH 解析，不写死路径
const require2 = createRequire(import.meta.url);
const { chromium } = require2('playwright');

const ROOT = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const OUT = path.join(ROOT, 'scripts', '_explore', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.log('  [页面报错]', e.message));

await page.goto('file:///' + path.join(ROOT, '查看备份.html').replace(/\\/g, '/'));
await page.waitForTimeout(600);

for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('dm-theme', t); } catch (e) {}
  }, theme);
  // 切到 B站
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#srcSw button')].find(x => x.dataset.src === 'bili');
    if (b) b.click();
  });
  await page.waitForTimeout(900);

  const info = await page.evaluate(() => {
    const parse = (c) => {
      const m = String(c).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map(s => parseFloat(s.trim()));
      return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
    };
    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
    });
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

    // 逐层向上合成「实际渲染背景」
    const effectiveBg = (el) => {
      const layers = [];
      let n = el;
      while (n && n.nodeType === 1) {
        const cs = getComputedStyle(n);
        const bg = parse(cs.backgroundColor);
        if (bg && bg.a > 0) layers.push(bg);
        if (cs.backgroundImage && cs.backgroundImage !== 'none' && /gradient/.test(cs.backgroundImage)) {
          // 渐变：取第一个色标
          const cols = cs.backgroundImage.match(/rgba?\([^)]+\)/g) || [];
          if (cols.length) layers.push(parse(cols[0]));
        }
        n = n.parentElement;
      }
      let acc = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
      return { layers, result: acc };
    };

    const rows = [];
    const links = [...document.querySelectorAll('.wcard-link')];
    for (const el of links.slice(0, 6)) {
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      const own = parse(cs.backgroundColor);
      const bgInfo = effectiveBg(el.parentElement || el);
      const eff = own && own.a > 0 ? over(own, bgInfo.result) : bgInfo.result;
      rows.push({
        text: (el.textContent || '').trim(),
        inMe: !!el.closest('.msg.me'),
        color: cs.color,
        ownBg: cs.backgroundColor,
        bgChain: bgInfo.layers.map(l => `rgba(${l.r},${l.g},${l.b},${l.a})`),
        effectiveBg: `rgb(${Math.round(eff.r)},${Math.round(eff.g)},${Math.round(eff.b)})`,
        contrast: +ratio(fg, eff).toFixed(2),
      });
    }
    // 顺便看 .links a（正文里的链接胶囊）
    const links2 = [...document.querySelectorAll('.bubble .links a')].slice(0, 3).map(el => {
      const cs = getComputedStyle(el);
      return { cls: 'links a', inMe: !!el.closest('.msg.me'), color: cs.color, bg: cs.backgroundColor };
    });

    // 我方各种 class 组合的气泡，各自的底色/字色（定位「白字落在浅底」的根因）
    const bubs = [];
    const seen = new Set();
    for (const bub of document.querySelectorAll('.msg.me .bubble')) {
      if (seen.has(bub.className)) continue;
      seen.add(bub.className);
      const cs = getComputedStyle(bub);
      const title = bub.querySelector('.wcard-t');
      const link = bub.querySelector('.wcard-link');
      bubs.push({
        cls: bub.className,
        bg: cs.backgroundColor,
        color: cs.color,
        titleColor: title ? getComputedStyle(title).color : '-',
        linkColor: link ? getComputedStyle(link).color : '-',
        txt: (bub.textContent || '').trim().slice(0, 34),
      });
    }
    return { src: (window.CUR_SRC || '-'), total: links.length, rows, links2, bubs };
  });

  console.log('\n================ 主题：' + theme + ' （当前数据源 ' + info.src + '，页面共 ' + info.total + ' 个 .wcard-link）================');
  for (const r of info.rows) {
    console.log('  「' + r.text + '」' + (r.inMe ? ' [我方气泡]' : ' [对方气泡]'));
    console.log('     color        = ' + r.color);
    console.log('     ownBg        = ' + r.ownBg);
    console.log('     背景链(外→内) = ' + r.bgChain.join('  →  '));
    console.log('     合成后背景    = ' + r.effectiveBg);
    console.log('     对比度        = ' + r.contrast + ':1   ' + (r.contrast >= 4.5 ? '✅ 达标(AA 正文)' : r.contrast >= 3 ? '⚠️ 仅够大字号' : '❌ 不可读'));
  }
  console.log('  -- .bubble .links a --');
  info.links2.forEach(x => console.log('     ' + x.cls + (x.inMe ? ' [我方]' : ' [对方]') + ' color=' + x.color + ' bg=' + x.bg));
  console.log('  -- 我方气泡的 class × 字色（根因定位）--');
  info.bubs.forEach(x => console.log('     class="' + x.cls + '"  bg=' + x.bg + '  bubbleColor=' + x.color +
    '  .wcard-t=' + x.titleColor + '  .wcard-link=' + x.linkColor + '\n        「' + x.txt + '」'));

  // 截一张：滚动到我方第一条分享卡片
  const y = await page.evaluate(() => {
    const el = document.querySelector('.msg.me .wcard-link');
    if (!el) return -1;
    el.scrollIntoView({ block: 'center' });
    return el.getBoundingClientRect().top + window.scrollY;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `diag-link-${theme}.png`) });
  console.log('  截图: diag-link-' + theme + '.png  (卡片位置 y=' + Math.round(y) + ')');
}

await browser.close();
