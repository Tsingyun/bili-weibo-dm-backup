// 移动端专项验证（P2-13）：真实浏览器 × 多视口
// ---------------------------------------------------------------
// 验的是「窄屏上还能不能用」，不是「CSS 里有没有写 media query」：
//   · 有没有横向溢出（手机最容易挂的地方）
//   · 状态栏是否变成顶部横条
//   · 新增的三块（日历热力图 / 聊天节律 / 高频词云）在手机上排得下吗
//   · 高级筛选 / 导出的表单在手机上会不会挤成一团、按钮够不够大
// 截图落到 scripts/_explore/shots/
import { loadDep } from './_deps.mjs';
import fs from 'fs';
import path from 'path';
import url from 'url';

const { chromium } = loadDep('playwright');

const ROOT = path.resolve(process.cwd());
const HTML = path.join(ROOT, '查看备份.html');
const OUT = path.join(ROOT, 'scripts', '_explore', 'shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const chk = (ok, name, detail = '') => {
  if (ok) { pass++; console.log('  [ok] ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  [NG] ' + name + (detail ? '  — ' + detail : '')); }
};

const browser = await chromium.launch({ headless: true });
const errs = [];

const VIEWPORTS = [
  { name: 'iphone-se', w: 375, h: 667 },     // 最窄的常见机型，最容易溢出
  { name: 'iphone-13', w: 390, h: 844 },
  { name: 'pixel7', w: 412, h: 915 },
  { name: 'ipad-mini', w: 768, h: 1024 },
  { name: 'laptop', w: 1280, h: 800 },
  { name: 'desktop', w: 1600, h: 1000 },
];

const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(url.pathToFileURL(HTML).href, { waitUntil: 'load' });
await page.waitForTimeout(1200);

// 有数据才谈得上验统计面板；没有就明确报出来，不要静默跳过
const hasData = await page.evaluate(() =>
  !!(window.SOURCES && window.SOURCES.weibo && window.SOURCES.weibo.data));
console.log('  微博数据：' + (hasData ? '已就绪' : '缺失'));
chk(hasData, '微博数据已就绪（后续统计断言才有意义）');

console.log('\n[1] 各视口：横向溢出 / 状态栏形态');
for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.w, height: vp.h });
  await page.waitForTimeout(320);

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const sb = document.querySelector('.sidebar');
    const rs = getComputedStyle(sb);
    const sw = document.getElementById('srcSw');
    const rail = document.querySelector('.rail');
    return {
      scrollW: de.scrollWidth,
      innerW: window.innerWidth,
      sbH: Math.round(sb.getBoundingClientRect().height),
      sbPos: rs.position,
      sbDir: rs.flexDirection,
      swVisible: !!(sw && sw.offsetParent !== null),
      railVisible: !!(rail && rail.offsetParent !== null),
      // 找出所有比视口还宽的元素，定位溢出元凶
      wide: Array.from(document.querySelectorAll('body *'))
        .filter(el => el.getBoundingClientRect().right > window.innerWidth + 2)
        .slice(0, 3)
        .map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
                   (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')),
    };
  });

  const overflow = m.scrollW - m.innerW;
  chk(overflow <= 2, `${vp.name}(${vp.w}) 无横向溢出`,
    overflow > 2 ? `溢出 ${overflow}px，越界元素 ${JSON.stringify(m.wide)}` : `scrollWidth ${m.scrollW}`);
  chk(m.swVisible, `${vp.name} 切换条可见`);

  if (vp.w <= 980) {
    chk(m.sbPos === 'sticky' && m.sbH < 200, `${vp.name} 状态栏变成顶部横条`,
      `position=${m.sbPos} height=${m.sbH}`);
    chk(!m.railVisible, `${vp.name} 右侧时间轴已隐藏`);
  } else if (vp.w >= 1340) {
    chk(m.railVisible, `${vp.name} 宽屏显示右侧时间轴`);
  }
}

console.log('\n[2] 手机端：统计面板里的三块新内容');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await page.locator('#statBtn').click();
await page.waitForTimeout(700);

const stats = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const panel = q('.statbox');
  return {
    open: q('#stat').classList.contains('on'),
    panelW: panel ? Math.round(panel.getBoundingClientRect().width) : -1,
    panelRight: panel ? Math.round(panel.getBoundingClientRect().right) : -1,
    heatRects: document.querySelectorAll('#heat rect').length,
    heatCells: document.querySelectorAll('#heat rect.c[data-day]').length,
    heatWrapOverflow: (() => {
      const w = q('.hmwrap');
      return w ? getComputedStyle(w).overflowX : '';
    })(),
    heatSvgW: (() => { const s = q('#heat'); return s ? Math.round(s.getBoundingClientRect().width) : -1; })(),
    rhythmBars: document.querySelectorAll('#rhythm .rhbars span').length,
    rhythmText: (q('#rhythm') ? q('#rhythm').innerText : '').replace(/\s+/g, ' ').slice(0, 90),
    // 词云每个词渲染成 <b>（内含 <small> 计数），不是 <span>；
    // 两种标签都数，以后换标签也不会把这条断言弄假。
    wcSpans: document.querySelectorAll('#wc b, #wc span').length,
    wcText: (q('#wc') ? q('#wc').innerText : '').replace(/\s+/g, ' ').slice(0, 70),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    panelOverflow: panel ? Math.round(panel.scrollWidth - panel.clientWidth) : 0,
  };
});
chk(stats.open, '统计面板已打开');
chk(stats.heatRects > 100, '日历热力图渲染出方格', `${stats.heatRects} 个 rect，其中带日期 ${stats.heatCells}`);
chk(stats.heatCells > 300, '热力图每格都带日期（可点击跳转）', `${stats.heatCells} 格`);
chk(/auto|scroll/.test(stats.heatWrapOverflow), '热力图容器可横向滚动（窄屏不挤压）',
  `overflow-x=${stats.heatWrapOverflow}`);
chk(stats.rhythmBars > 0 || stats.rhythmText.length > 10, '聊天节律有内容', stats.rhythmText);
chk(stats.wcSpans > 5, '高频词云渲染出词', `${stats.wcSpans} 个词：${stats.wcText}`);
chk(stats.panelW <= 390, '统计面板宽度不超出视口', `${stats.panelW}px`);
chk(stats.panelOverflow <= 2, '统计面板内部无横向溢出', `溢出 ${stats.panelOverflow}px`);
chk(stats.overflow <= 2, '打开统计面板后整页仍无横向溢出', `溢出 ${stats.overflow}px`);

await page.screenshot({ path: path.join(OUT, 'mobile_390_stats.png') });

// 单独给三块内容各截一张，方便人眼核对排版
for (const [sel, file] of [['#heat', 'mobile_390_heatmap.png'],
                           ['#rhythm', 'mobile_390_rhythm.png'],
                           ['#wc', 'mobile_390_wordcloud.png']]) {
  const el = page.locator(sel);
  if (await el.count()) {
    try { await el.screenshot({ path: path.join(OUT, file) }); } catch {}
  }
}

await page.keyboard.press('Escape');
await page.waitForTimeout(350);
chk(!(await page.evaluate(() => document.getElementById('stat').classList.contains('on'))),
  'Esc 能关掉统计面板');

console.log('\n[3] 手机端：高级筛选 / 导出表单');
const folds = await page.locator('.sidebar details.fold').count();
chk(folds >= 2, '侧栏里有折叠小节（高级筛选 / 导出）', `${folds} 个`);

const adv = page.locator('.sidebar details.fold').first();
await adv.evaluate(el => { el.open = true; });
await page.waitForTimeout(250);
const advInfo = await page.evaluate(() => {
  const d = document.querySelector('.sidebar details.fold');
  // 高级筛选里 date 是 input、类型是 select、几个开关是 button，
  // 所以按「可交互控件」一起数，再单独确认关键 id 都在。
  const ctrls = Array.from(d.querySelectorAll('input, select, button'));
  const ids = ['advType', 'advSince', 'advUntil', 'advRegex', 'advOcr', 'advVlm', 'advReset'];
  return {
    n: ctrls.length,
    missing: ids.filter(i => !document.getElementById(i)),
    tooWide: ctrls.filter(i => i.getBoundingClientRect().right > window.innerWidth + 2).length,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
});
// 高级筛选固定就是 7 个可交互控件：1 个类型下拉 + 2 个日期 + 4 个按钮
// （正则 / 图内有字 / 有图描述 / 清空）。下面那条断言已经逐个核对 id，这里只
// 防止「控件整片丢失」这种塌缩，所以按 7 卡下限而不是 8。
chk(advInfo.n >= 7, '高级筛选控件齐全', `${advInfo.n} 个可交互控件`);
chk(advInfo.missing.length === 0, '七个关键控件都在 DOM 里', advInfo.missing.join(',') || 'ok');
chk(advInfo.tooWide === 0, '高级筛选控件没有溢出屏幕');
chk(advInfo.overflow <= 2, '展开高级筛选后仍无横向溢出', `溢出 ${advInfo.overflow}px`);
await page.screenshot({ path: path.join(OUT, 'mobile_390_advfilter.png') });

const exp = page.locator('.sidebar details.fold').nth(1);
await exp.evaluate(el => { el.open = true; });
await page.waitForTimeout(250);
const expInfo = await page.evaluate(() => {
  const ds = document.querySelectorAll('.sidebar details.fold');
  const d = ds[ds.length - 1];
  const btns = Array.from(d.querySelectorAll('button'));
  return {
    n: btns.length,
    minH: Math.min(...btns.map(b => Math.round(b.getBoundingClientRect().height)).filter(h => h > 0), 999),
    tooWide: btns.filter(b => b.getBoundingClientRect().right > window.innerWidth + 2).length,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
});
chk(expInfo.n >= 6, '导出按钮齐全（6 种格式）', `${expInfo.n} 个按钮`);
chk(expInfo.minH >= 30, '导出按钮够大，手指点得到', `最矮 ${expInfo.minH}px`);
chk(expInfo.tooWide === 0 && expInfo.overflow <= 2, '导出面板没有溢出屏幕',
  `越界按钮 ${expInfo.tooWide} · 页面溢出 ${expInfo.overflow}px`);
await page.screenshot({ path: path.join(OUT, 'mobile_390_export.png') });

console.log('\n[4] 截图留档');
for (const vp of [{ name: 'mobile_390', w: 390, h: 844 }, { name: 'tablet_768', w: 768, h: 1024 }]) {
  await page.setViewportSize({ width: vp.w, height: vp.h });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  const f = path.join(OUT, vp.name + '_full.png');
  await page.screenshot({ path: f });
  chk(fs.existsSync(f) && fs.statSync(f).size > 5000, `截图 ${vp.name}_full.png 已生成`);
}

console.log('\n[5] 页面无 JS 报错');
chk(errs.length === 0, '无 JS 报错/控制台错误', errs.slice(0, 3).join(' | '));

await browser.close();
console.log('\n' + '='.repeat(56));
console.log(`移动端专项验证：通过 ${pass} · 失败 ${fail}`);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);
