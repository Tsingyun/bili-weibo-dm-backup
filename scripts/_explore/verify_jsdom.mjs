/**
 * 离线渲染验证：用 jsdom 真实执行查看页脚本，检查 5 项改动
 */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom');

const DIR = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const FILE = DIR + '/查看备份.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass = [], fail = [];
const chk = (ok, label, extra) => { (ok ? pass : fail).push(label + (extra ? '  → ' + extra : '')); console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  → ' + extra : '')); };

/* ---------------------------------------------------------------------------
   本脚本专测「微博」这一套渲染，B站另有专项测试（verify_bili / shot_bili_real）。
   所以这里把 B站 的 4 个数据 <script> **剔掉**，让页面回到「B站无数据」状态 ——
   第 8 节里「无数据的来源按钮也必须有反应」那 3 条断言才会真的跑。

   踩过的坑：原来没有这一步，第 8 节写成
     `for (const k of [...]) { if (SOURCES_HAS(k)) continue; ... }`
   2026-09-15 B站首次备份落地后，`continue` 把这 3 条**静默跳过**了：
   总断言数从 51 掉到 48，但报告仍是「全部通过」—— 比失败更危险。
   现在剔掉真实数据 + 断言剔掉的数量，跳过就不再可能悄悄发生。
   --------------------------------------------------------------------------- */
const STUB_RE = /<script src="bili\/(?:messages|faces|ocr|vlm)\.js"[^>]*>\s*<\/script>/g;
const rawHtml = fs.readFileSync(FILE, 'utf8');
const html = rawHtml.replace(STUB_RE, '');
const stubbedN = (rawHtml.match(STUB_RE) || []).length;
const errors = [];
const vc = new VirtualConsole();
// 可选数据集（bili/、data/ocr.js 等）缺失时 jsdom 会报 “Could not load”，
// 这是设计内行为（页面要能在缺文件时照常用），不算 JS 报错。
vc.on('jsdomError', e => { const m = e.message || ''; if (!/Not implemented|Could not load/.test(m)) errors.push('jsdomError: ' + m); });
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 200)));

const dom = new JSDOM(html, {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  url: 'file:///' + FILE.replace(/\\/g, '/'),
  virtualConsole: vc,
});
const W = dom.window, doc = W.document;
await new Promise(res => { W.addEventListener('load', res); setTimeout(res, 10000); });
await sleep(800);

const q = s => doc.querySelectorAll(s).length;
const probe = () => ({
  msg: q('.msg'), wcard: q('.wcard'), btn: q('.wcard-btn'), link: q('.wcard-link'),
  collapsed: q('.bubble.has-card:not(.open)'), opened: q('.bubble.has-card.open'),
  face: q('img.face'), links: q('.links a'),
  found: doc.getElementById('found') ? doc.getElementById('found').textContent : '',
  autoChip: doc.getElementById('autoChip') ? doc.getElementById('autoChip').textContent : '',
  hitnav: doc.getElementById('hitnav') ? doc.getElementById('hitnav').className : '',
  hitpos: doc.getElementById('hitPos') ? doc.getElementById('hitPos').textContent : '',
});

console.log('=== 0. 基础 ===');
chk(errors.length === 0, '页面无 JS 报错', errors.slice(0, 3).join(' | ') || '无');
chk(!!W.DM_DATA && (W.DM_DATA.messages || []).length > 7000, '数据已载入', (W.DM_DATA ? W.DM_DATA.messages.length : 0) + ' 条');
chk(!!W.DM_FACES && Object.keys(W.DM_FACES.phrase || {}).length > 300, '表情表已载入',
  W.DM_FACES ? (Object.keys(W.DM_FACES.phrase).length + ' 中文 + ' + Object.keys(W.DM_FACES.ee).length + ' ee') : '无');
let p = probe();
console.log('  · 首屏渲染 ' + p.msg + ' 条消息，' + p.face + ' 个表情图，' + p.links + ' 个链接');

console.log('\n=== 5. 表情图渲染（数据全量统计）===');
{
  const M = W.DM_DATA.messages, F = W.DM_FACES;
  let tot = 0, ok = 0, miss = {};
  const reBr = /\[([^\[\]\s]{1,20})\]/g, reEe = /\/?(ee[0-9a-f]{4,6})\.(png|gif)/gi;
  for (const m of M) {
    const t = m.text; if (!t) continue;
    let r; reBr.lastIndex = 0;
    while ((r = reBr.exec(t))) {
      const n = r[1];
      if (n === '动画表情') { reEe.lastIndex = 0; continue; }   // [动画表情] 是占位符，图片另有，不计入
      tot++;
      if (/^\/?(ee[0-9a-f]{4,6})\.(png|gif)$/i.test(n)) {
        const e = /(ee[0-9a-f]{4,6})/i.exec(n)[1].toLowerCase();
        if (F.ee[e]) ok++; else miss['ee:' + e] = (miss['ee:' + e] || 0) + 1;
      } else if (F.phrase['[' + n + ']']) ok++;
      else miss['[' + n + ']'] = (miss['[' + n + ']'] || 0) + 1;
      reEe.lastIndex = 0;
    }
    reEe.lastIndex = 0;
    while ((r = reEe.exec(t))) { /* 方括号外裸 ee 形式 */ }
  }
  const rate = (ok / (tot || 1) * 100).toFixed(1);
  chk(ok / tot > 0.85, '表情标记还原率', ok + '/' + tot + ' = ' + rate + '%');
  const mkeys = Object.keys(miss);
  console.log('  · 未还原的（除[动画表情]占位）: ' + (mkeys.length ? mkeys.map(k => k + '×' + miss[k]).slice(0, 12).join(' ') : '无'));
  // 抽查渲染出的 img.face 是否指向真实文件
  const srcs = [...doc.querySelectorAll('img.face')].map(i => i.getAttribute('src'));
  const bad = srcs.filter(s => !fs.existsSync(DIR + '/' + s));
  chk(srcs.length > 0 && bad.length === 0, '表情图路径有效', srcs.length + ' 个，坏路径 ' + bad.length + ' 个');
}

console.log('\n=== 5b. 表情图的真实渲染（只看字典不看 DOM 会漏掉「查不到键」的 bug）===');
{
  // 取出现最多、且字典里有图的记号作搜索词，把样本放大
  const tally = {};
  for (const m of W.DM_DATA.messages) {
    for (const x of ((m.text || '').match(/\[[^\[\]\s]{1,20}\]/g) || [])) {
      if (W.DM_FACES.phrase[x]) tally[x] = (tally[x] || 0) + 1;
    }
  }
  const topTok = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  chk(!!topTok, '存在「字典里有图」的表情记号', topTok ? topTok[0] + ' × ' + topTok[1] : '无');
  const qEl2 = doc.getElementById('q');
  qEl2.value = topTok ? topTok[0] : '___nomatch___';
  qEl2.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(1600);
  const els2 = [...doc.querySelectorAll('.msg')];
  let expF = 0, gotF = 0; const missF = [];
  for (const el of els2) {
    const ai = Number(el.dataset.ai);
    const mm = W.DM_DATA.messages[ai];
    if (!mm) continue;
    const g = ((mm.text || '').match(/\[[^\[\]\s]{1,20}\]/g) || []).filter(x => W.DM_FACES.phrase[x]);
    if (!g.length) continue;
    expF += g.length;
    const got = el.querySelectorAll('img.face').length;
    gotF += got;
    if (got < g.length) missF.push(ai + ':' + g.join(''));
  }
  chk(expF > 0, '样本中含可渲染的表情', expF + ' 个记号 / ' + els2.length + ' 条消息');
  chk(gotF === expF, '表情记号真的渲染成了 <img>', '期望 ' + expF + ' → 实际 ' + gotF +
    (missF.length ? '，缺: ' + missF.slice(0, 3).join(' ') : ''));
  // 渲染出的图必须真能打开
  const srcs2 = [...doc.querySelectorAll('img.face')].map(i => i.getAttribute('src'));
  const bad2 = srcs2.filter(s => !fs.existsSync(DIR + '/' + s));
  chk(srcs2.length > 0 && bad2.length === 0, '渲染出的表情图文件都存在',
    srcs2.length + ' 个，缺文件 ' + bad2.length + ' 个' + (bad2.length ? ' → ' + bad2[0] : ''));
  doc.getElementById('qclr').click();
  await sleep(600);
}

console.log('\n=== 1+4. 分享微博卡片：默认折叠 + 链接精简 ===');
{
  const target = W.DM_DATA.messages.find(m => m.card && m.card.kind === 'weibo' && (m.text || '').includes('P0xSQEwjA'));
  chk(!!target, '找到截图里那条分享微博', target ? target.id : '未找到');
  const qEl = doc.getElementById('q');
  qEl.value = '丑猫';
  qEl.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(1400);
  p = probe();
  chk(p.wcard > 0, '卡片已渲染', p.wcard + ' 个');
  chk(p.collapsed === p.wcard, '卡片默认全部折叠', p.collapsed + '/' + p.wcard);
  chk(p.link === p.wcard, '每条卡片只有 1 个链接（原为 3 个）', p.link + ' 个链接 / ' + p.wcard + ' 张卡片');
  const inner = doc.querySelector('.wcard').parentNode.innerHTML;
  const uniqKeys = new Set((inner.match(/https?:\/\/[^\s"'<>]+/g) || []));
  chk(uniqKeys.size <= 1, '同一微博的 3 个 URL 已归并为 1 个', uniqKeys.size + ' 个唯一 URL');
  const btn = doc.querySelector('.wcard-btn');
  chk(!!btn, '有「展开详情」按钮', btn ? btn.textContent : '无');
  if (btn) {
    btn.click(); await sleep(300);
    const p2 = probe();
    chk(p2.opened > 0 && p2.collapsed < p.collapsed, '点击后卡片展开', '展开 ' + p2.opened + ' 个');
    const btn2 = doc.querySelector('.wcard-btn');
    chk(btn2 && btn2.textContent === '收起', '按钮切换为「收起」', btn2 ? btn2.textContent : '无');
    btn2.click(); await sleep(200);
    chk(probe().collapsed === p.wcard, '再点可收回折叠态');
  }
}

console.log('\n=== 3. 搜索功能 ===');
{
  const qEl = doc.getElementById('q');
  qEl.value = '小岁';
  qEl.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(1400);
  p = probe();
  chk(/命中/.test(p.found), '显示命中条数', p.found);
  chk(p.hitnav.includes('on') && /\d+\s*\/\s*\d+/.test(p.hitpos), '显示匹配定位 N/M', p.hitpos);
  const before = p.hitpos;
  doc.getElementById('hitPrev').click(); await sleep(600);
  const after = probe().hitpos;
  chk(before !== after, '↑ 可跳到上一个匹配', before + ' → ' + after);
  doc.getElementById('hitNext').click(); await sleep(600);
  chk(probe().hitpos === before, '↓ 可跳回下一个匹配', probe().hitpos);
  const marks = q('mark');
  chk(marks > 0, '命中关键词有高亮', marks + ' 处');
  doc.getElementById('qclr').click(); await sleep(600);
  chk(probe().found === '', '清空后恢复', '[' + probe().found + ']');
}

console.log('\n=== 2. 隐藏自动回复 ===');
{
  const AUTO = (W.SOURCES && W.SOURCES.weibo && W.SOURCES.weibo.autoReply) || ''; // 从页面配置取（sessions.js → autoReply），不写死
  const total = W.DM_DATA.messages.length;
  const autoCount = W.DM_DATA.messages.filter(m => (m.text || '').trim() === AUTO).length;
  const chip = doc.getElementById('autoChip');
  chk(!!chip, '存在「自动回复」按钮', chip ? chip.textContent : '无');
  const before = q('.msg');
  chip.click();
  await sleep(900);
  p = probe();
  chk(/已隐藏/.test(p.autoChip), '按钮状态已切换', p.autoChip);
  chk(p.found.includes('已隐藏自动回复'), '统计显示隐藏条数', p.found);
  chk(p.found.includes(autoCount.toLocaleString()), '隐藏数量与数据一致', '实际 ' + autoCount + ' 条');
  chip.click();
  await sleep(900);
  chk(!/已隐藏/.test(probe().autoChip), '可再次显示', probe().autoChip);
  console.log('  · 数据里自动回复共 ' + autoCount + ' 条 / 总 ' + total + ' 条');
}

console.log('\n=== 6. 左侧常驻状态栏 + 右侧月份时间轴 ===');
{
  chk(q('header') === 0, '原顶部 header 已移除', q('header') + ' 个');
  chk(!!doc.querySelector('.layout'), '三栏骨架存在');

  const side = doc.querySelector('.layout > .sidebar');
  chk(!!side, '状态栏是布局第一栏（左侧）');
  const ids = ['q', 'qclr', 'hitnav', 'chips', 'jump', 'themeBtn', 'toTop', 'toBot', 'stats', 'found'];
  const missing = ids.filter(id => !side.querySelector('#' + id));
  chk(missing.length === 0, '搜索/筛选/日期/主题/跳转控件全部搬进侧栏',
    missing.length ? '缺 ' + missing.join(',') : '共 ' + ids.length + ' 项齐全');
  chk(!side.contains(doc.querySelector('#chat')), '聊天区独立于侧栏（不在侧栏内）');

  const months = [...doc.querySelectorAll('#months .mo[data-m]')];
  /* ⚠ 换日口径（2026-09-18 起）：一天 = 当天 05:00 → 次日 05:00，
     月份归属也跟着走逻辑日 —— 先减 5 小时再取年月，否则会多/少一个月。 */
  const realMonths = new Set(W.DM_DATA.messages.filter(m => m.ts).map(m => {
    const d = new Date(m.ts - 5 * 3600 * 1000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }));
  chk(months.length === realMonths.size, '时间轴月份数与数据完全一致',
    months.length + ' 个月 vs 数据 ' + realMonths.size + ' 个');
  const ks = months.map(m => m.dataset.m);
  chk(ks.join() === ks.slice().sort().reverse().join(), '月份按倒序排列（最新在上）',
    ks[0] + ' → ' + ks[ks.length - 1]);

  // 点击中间某个月份，应跳到该月第一条
  const mid = months[Math.floor(months.length / 2)];
  mid.click();
  await sleep(700);
  const firstDay = doc.querySelector('#chat .day[data-m]');
  chk(!!firstDay && firstDay.dataset.m === mid.dataset.m, '点月份可跳到该月',
    (firstDay ? firstDay.dataset.m : '-') + ' vs ' + mid.dataset.m);
  chk(q('.msg') <= 150, '分块渲染仍生效', q('.msg') + ' 条');
  chk(!!doc.getElementById('moreTop') && !!doc.getElementById('moreBot'),
    '中间月份两侧都有「加载更多」', q('.more') + ' 个按钮组');
  chk(doc.querySelectorAll('#months .mo.on').length === 1, '当前月份已高亮',
    doc.querySelectorAll('#months .mo.on').length + ' 个高亮');
  chk(doc.querySelector('#months .mo.on').dataset.m === mid.dataset.m, '高亮的是跳转到的月份',
    doc.querySelector('#months .mo.on').dataset.m);

  // 回到最早月份
  const earliest = months[months.length - 1];
  earliest.click();
  await sleep(500);
  const fd2 = doc.querySelector('#chat .day[data-m]');
  chk(fd2 && fd2.dataset.m === earliest.dataset.m, '可跳到最早月份', fd2 ? fd2.dataset.m : '-');

  // 侧栏底部按钮
  chk(!doc.getElementById('toTop').closest('.fab'), '「回到最早」在侧栏而非悬浮按钮');
  doc.getElementById('toBot').click();
  await sleep(600);
  const lastMo = doc.querySelector('#months .mo.on');
  chk(lastMo && lastMo.dataset.m === ks[0], '「回到最新」跳到最新月份', lastMo ? lastMo.dataset.m : '-');
}

console.log('\n=== 8. 顶部数据源切换（微博 / B站）===');
{
  // 各来源在页面里是否真的拿到数据（对应 window.DM_DATA / window.DM_DATA_B）
  const RAW = { weibo: 'DM_DATA', bili: 'DM_DATA_B' };
  const SOURCES_HAS = k => !!W[RAW[k]];
  // 注意：每次 boot() 都会用 DOM 快照重建 .layout，旧的按钮节点会被替换成游离节点，
  // 所以每次都得重新查询，不能把 NodeList 缓存在外面。
  const getBtns = () => [...doc.querySelectorAll('#srcSw button[data-src]')];
  const clickSrc = k => { const b = getBtns().find(x => x.dataset.src === k); if (b) b.click(); };
  const btns = getBtns();
  const pressed = () => getBtns().filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.src);
  // 守卫：正则失效 = B站真实数据又加载进来了 = 下面 3 条引导断言会被 continue 静默跳过。
  chk(stubbedN === 4, '已剔掉 4 个 B站真实数据 script 标签', '实际 ' + stubbedN + ' 个');
  chk(btns.length === 2, '切换条有且仅有两个来源按钮', btns.map(b => b.dataset.src).join(' | '));
  chk(pressed().length === 1, '恰好一个来源处于选中态', pressed().join(','));

  const titleOf = () => doc.getElementById('title').textContent;
  const chatOf = () => doc.getElementById('chat').textContent || '';

  // 关键回归：数据缺失的来源也必须「点了有反应」。
  // 曾经写成 `if(!ok || key===CUR_SRC) return;`，ok 在绑定时算死 →
  // B站没数据时按钮形同虚设，点进去看不到任何引导。
  chk(!SOURCES_HAS('bili'), 'B站处于「无数据」状态，本节引导断言会真跑',
    'DM_DATA_B = ' + (SOURCES_HAS('bili') ? '有数据' : '未定义'));
  for (const k of ['weibo', 'bili']) {
    if (SOURCES_HAS(k)) continue;              // 微博有数据（本脚本主测对象），其行为由下文恢复断言覆盖
    const before = titleOf();
    clickSrc(k);
    await sleep(400);
    chk(pressed().includes(k), '无数据的「' + k + '」按钮可点进去', '选中=' + pressed().join(','));
    chk(titleOf() !== before && titleOf().includes(k === 'bili' ? 'B站' : '微博'),
      '切到「' + k + '」后标题随之更新', titleOf());
    chk(/messages\.js/.test(chatOf()) && /更新|登录/.test(chatOf()),
      '「' + k + '」显示「该跑哪个更新」的引导', chatOf().replace(/\s+/g, ' ').slice(0, 60));
    clickSrc('weibo');
    await sleep(400);
  }

  // 切走再切回，微博侧内容必须原样恢复（监听器/节点不叠加）
  const beforeN = q('.msg');
  clickSrc('bili'); await sleep(300);
  clickSrc('weibo'); await sleep(500);
  chk(q('.msg') === beforeN, '切换来源后微博气泡数不叠加', beforeN + ' → ' + q('.msg'));
  chk(pressed().includes('weibo'), '最终停在微博来源', pressed().join(','));
}

console.log('\n========================================');
console.log('通过 ' + pass.length + ' 项，失败 ' + fail.length + ' 项');
if (fail.length) { console.log('失败项:'); fail.forEach(f => console.log('  - ' + f)); }
process.exit(fail.length ? 1 : 0);
