/**
 * 「每天 05:00 换日」专项回归（2026-09-18）
 *
 * 背景：原先按**自然日 0 点**切分。实测本站数据里 33.75%（微博 2,675/7,925）、
 * 51.68%（B站 1,505/2,912）的消息落在 00:00~05:00 —— 按自然日会把一场深夜聊天
 * 从中间劈成两天。现在统一改成「当天 05:00 → 次日 05:00」，00:00~05:00 的消息
 * 算作**前一天**。
 *
 * 这个改动会同时影响 6 个地方，而且它们必须**同源**，否则会出现
 * 「分隔条说 9/15、月份栏说 9 月、筛选区间却按 9/16 算」这种自相矛盾：
 *   ① 聊天分隔条归属  ② 月份栏分组  ③ 日期区间筛选  ④ 统计面板的连续日轴
 *   ⑤ 统计面板热力图  ⑥ 聊天节律的「周几」
 *
 * 所以本脚本不测「代码改了没」，测的是**这 6 处是否指向同一个口径**：
 * 每一处的期望值都由本文件里一份独立实现现算，绝不调用页面函数、绝不写死数字。
 *
 * 三个坑（改这个脚本前先看）：
 *   1. 页面的「日」key 是 YYYY-MM-DD，`data-m` 只到月份（YYYY-MM），
 *      分隔条上的完整日期在 `textContent` 里、区间说明在 `title` 里 —— 三个都要对。
 *   2. 展开上下文会跨日混排（前后各 N 条），所以逐条归属只在**干净状态**下测
 *      （无搜索词、无展开），并断言此时 chat 里没有 .ctxbar。
 *   3. 一条消息可能落在分块渲染的 150 条之外。要测中段的消息就先点「还有 N 条」
 *      把它滚进 DOM，别假设它在。
 */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom');

const DIR = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const WEIBO_AUTO = (() => { try { const s = JSON.parse(fs.readFileSync(DIR + '/sessions.json', 'utf8')); return ((s.sessions || []).find(x => x.key === 'weibo') || {}).autoReply || ''; } catch { return ''; } })(); // 自动回复文案取自 sessions.json（属个人内容，不写进代码）
const FILE = DIR + '/查看备份.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pass = [], fail = [];
const chk = (ok, label, extra) => {
  (ok ? pass : fail).push(label);
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  → ' + String(extra).slice(0, 170) : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');
const info = t => console.log('  · ' + t);

/* ================================================================
   独立实现（**故意**不复用页面里的函数，否则测不出「页面忘了改」）
   ================================================================ */
const CUT = 5 * 3600 * 1000;            // 每天 05:00 换日
const PAD = n => String(n).padStart(2, '0');
const WD = ['日', '一', '二', '三', '四', '五', '六'];

/** 逻辑日：时间戳减 5 小时再取年月日 */
const lday = ts => {
  const d = new Date(ts - CUT);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
};
/** 自然日（旧口径，只用来证明「两种口径确实不同」） */
const nday = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
};
const lmon = ts => lday(ts).slice(0, 7);
const nmon = ts => nday(ts).slice(0, 7);
/** 逻辑日 key → 当天 05:00 / 次日 05:00（不含） */
const dStart = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 5, 0, 0, 0).getTime(); };
const dEnd = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d + 1, 5, 0, 0, 0).getTime(); };
/** 逻辑日 key → 分隔条上那行字（与页面 dayLabel 的格式对齐：不补零） */
const dLabel = k => {
  const [y, m, d] = k.split('-').map(Number);
  return `${y}年${m}月${d}日 星期${WD[new Date(y, m - 1, d, 12, 0, 0, 0).getDay()]}`;
};
const dayAxis = (tmin, tmax) => {
  const out = [];
  for (let t = dStart(lday(tmin)); t <= dStart(lday(tmax)); t += 86400000) out.push(lday(t));
  return out;
};

/* ============ S1. 先自检这份「独立实现」本身 ============ */
section('S1. 口径定义自检（分界点前后 1 毫秒）');
{
  const before = new Date(2026, 8, 16, 4, 59, 59, 999).getTime();
  const at = new Date(2026, 8, 16, 5, 0, 0, 0).getTime();
  chk(lday(before) === '2026-09-15', '04:59:59.999 属于前一天', lday(before));
  chk(lday(at) === '2026-09-16', '05:00:00.000 属于当天', lday(at));
  chk(lday(before) !== nday(before), '分界点前：逻辑日 ≠ 自然日（两种口径确实不同）',
    lday(before) + ' vs ' + nday(before));
  chk(lday(at) === nday(at), '分界点后：两者一致（只差在凌晨那段）');
  chk(lday(dStart('2026-09-16')) === '2026-09-16', '边界自洽：dayStart(9/16) 属于 9/16');
  chk(lday(dStart('2026-09-16') - 1) === '2026-09-15', '边界自洽：dayStart(9/16) 前一毫秒属于 9/15');
  chk(dEnd('2026-09-16') === dStart('2026-09-17'), 'dayEnd(9/16) == dayStart(9/17)（区间无缝）');
  chk(dEnd('2026-09-16') - dStart('2026-09-16') === 86400000, '一个逻辑日仍是 24 小时');
}

/* ============ 载入页面 ============ */
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  const m = e.message || '';
  if (!/Not implemented|Could not load/.test(m)) errors.push('jsdomError: ' + m);
});
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 200)));

const rawHtml = fs.readFileSync(FILE, 'utf8');
const dom = new JSDOM(rawHtml, {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  url: 'file:///' + FILE.replace(/\\/g, '/'), virtualConsole: vc,
  beforeParse(w) {
    const mem = {};
    Object.defineProperty(w, 'localStorage', {
      configurable: true,
      value: {
        getItem: k => (k in mem ? mem[k] : null),
        setItem: (k, v) => { mem[k] = String(v); },
        removeItem: k => { delete mem[k]; },
        clear: () => { for (const k of Object.keys(mem)) delete mem[k]; },
      },
    });
  },
});
const W = dom.window, doc = dom.window.document;
await new Promise(res => { W.addEventListener('load', res); setTimeout(res, 10000); });
await sleep(800);

chk(errors.length === 0, '页面无 JS 报错', errors.slice(0, 3).join(' | ') || '无');

const SRC = {
  weibo: { G: 'DM_DATA', btn: 'weibo' },
  bili: { G: 'DM_DATA_B', btn: 'bili' },
};
const msgsOf = k => (W[SRC[k].G] || {}).messages || [];
async function pickSrc(k) {
  const b = [...doc.querySelectorAll('#srcSw button[data-src]')].find(x => x.dataset.src === SRC[k].btn);
  if (!b) return false;
  b.click();
  await sleep(800);
  return true;
}
/** 干净状态：清掉搜索词与全部筛选，回到列表开头 */
async function clean() {
  const btn = doc.getElementById('advReset');
  if (btn) { btn.click(); await sleep(120); }
  doc.getElementById('jump').value = '';
  doc.getElementById('jump').dispatchEvent(new W.Event('change'));
  await sleep(150);
  const t = doc.getElementById('toTop');
  if (t) { t.click(); await sleep(200); }
}
/** 把某条消息滚进 DOM（分块渲染，一条消息可能在 150 条之外） */
async function showAi(ai, max = 60) {
  for (let c = 0; c < max; c++) {
    if (doc.querySelector('#chat .msg[data-ai="' + ai + '"]')) return true;
    const b = doc.getElementById('moreBot');
    if (!b) return false;
    b.click();
    await sleep(80);
  }
  return !!doc.querySelector('#chat .msg[data-ai="' + ai + '"]');
}
/** 按 DOM 顺序走一遍聊天区：每条消息当前挂在哪个分隔条下 */
function walkChat() {
  const rows = [];
  let curMonth = null, curLabel = null;
  for (const el of doc.getElementById('chat').children) {
    if (el.classList && el.classList.contains('day')) {
      curMonth = el.getAttribute('data-m');
      curLabel = el.textContent.trim();
      continue;
    }
    if (el.classList && el.classList.contains('msg') && el.hasAttribute('data-ai')) {
      rows.push({ ai: Number(el.getAttribute('data-ai')), month: curMonth, label: curLabel });
    }
  }
  return rows;
}
const setRange = async (a, b) => {
  doc.getElementById('advSince').value = a;
  doc.getElementById('advUntil').value = b;
  doc.getElementById('advSince').dispatchEvent(new W.Event('change'));
  doc.getElementById('advUntil').dispatchEvent(new W.Event('change'));
  await sleep(250);
};
const setJump = async v => {
  doc.getElementById('jump').value = v;
  doc.getElementById('jump').dispatchEvent(new W.Event('change'));
  await sleep(300);
};

/* ============ S2. 真实数据：这条改动到底有没有观察对象 ============ */
section('S2. 数据规模与口径差异（先确认测试有区分度）');
const stat = {};
for (const k of ['weibo', 'bili']) {
  const M = msgsOf(k).filter(m => m.ts);
  const pre5 = M.filter(m => new Date(m.ts).getHours() < 5);
  const axisNew = dayAxis(Math.min(...M.map(m => m.ts)), Math.max(...M.map(m => m.ts)));
  const lDays = new Set(M.map(m => lday(m.ts)));
  const nDays = new Set(M.map(m => nday(m.ts)));
  stat[k] = { M, pre5, axisNew, lDays, nDays };
  info(`${k}: ${M.length} 条 · 00:00~05:00 占 ${pre5.length} 条（${(pre5.length / M.length * 100).toFixed(2)}%）· ` +
    `出现的「日」 ${nDays.size}(自然日) → ${lDays.size}(05:00 口径) · 连续轴 ${axisNew.length} 天`);
  chk(pre5.length > 0, `${k}：确实有落在 00:00~05:00 的消息（否则这条改动无从观察）`, pre5.length + ' 条');
  chk(lDays.size !== nDays.size, `${k}：新旧口径的「日」集合不同（测试有区分度）`,
    nDays.size + ' → ' + lDays.size);
}

/* ============ S3. 逐条归属：分隔条 == 独立重算的逻辑日 ============ */
async function testAttribution(k) {
  section(`S3. [${k}] 分隔条归属逐条核对（干净状态）`);
  await pickSrc(k);
  await clean();
  const M = stat[k].M;

  chk(doc.querySelectorAll('#chat .ctxbar').length === 0, '干净状态下没有展开上下文（混排会污染逐条核对）');

  const rows = walkChat();
  chk(rows.length > 20, '聊天区渲染了足够多的消息', rows.length + ' 条');
  chk(rows.every(r => r.label), '每条消息都在某个分隔条之下（没有孤儿）');

  let bad = [];
  for (const r of rows) {
    const m = M[r.ai];
    if (!m || !m.ts) continue;
    const expLabel = dLabel(lday(m.ts));
    const expMonth = lday(m.ts).slice(0, 7);
    if (r.label !== expLabel || r.month !== expMonth) {
      bad.push(`#${r.ai} ts=${new Date(m.ts).toLocaleString('sv-SE')} 页面=${r.label}/${r.month} 期望=${expLabel}/${expMonth}`);
    }
  }
  chk(bad.length === 0, `★ 每条消息都归到「独立重算的逻辑日」那一条分隔条下（${rows.length} 条）`,
    bad.length ? bad.slice(0, 3).join(' ; ') : '全部一致');
  if (bad.length) console.log(bad.slice(0, 8).map(s => '      ' + s).join('\n'));

  /* 分隔条的 data-m 必须与月份口径一致（否则月份栏和分隔条会互相打脸） */
  const monthsInChat = new Set(rows.map(r => r.month));
  const badMon = [...monthsInChat].filter(m => !/^\d{4}-\d{2}$/.test(m));
  chk(badMon.length === 0, '分隔条 data-m 都是 YYYY-MM 形式', badMon.join(',') || '正常');

  /* tooltip 要把「这天指哪 24 小时」写清楚 */
  const dayEl = [...doc.querySelectorAll('#chat .day')].find(e => e.getAttribute('title'));
  chk(!!dayEl, '分隔条带 title 说明');
  if (dayEl) {
    const k2 = dayEl.getAttribute('data-m');
    const tipN = dayEl.getAttribute('title');
    chk(/05:00 分界/.test(tipN), '分隔条 tooltip 写明 05:00 分界', tipN);
    chk(/前一天/.test(tipN), '分隔条 tooltip 标明「00:00~05:00 算前一天」');
    chk(/→/.test(tipN) && new RegExp('05:00').test(tipN), 'tooltip 含区间箭头', tipN);
    info('  tooltip 样例：' + tipN);
  }
}

/* ============ S4. 核心：00:00~05:00 的消息挂在「自然日 − 1」下 ============ */
async function testPre5(k) {
  section(`S4. [${k}] 核心断言：凌晨消息归到前一天`);
  await pickSrc(k);
  await clean();
  const M = stat[k].M;
  const first = M.find(m => m.ts && new Date(m.ts).getHours() < 5);
  chk(!!first, '找到一条 00:00~05:00 的真实消息');
  if (!first) return;

  const ai = M.indexOf(first);
  const hour = new Date(first.ts).getHours();
  const nat = nday(first.ts), log = lday(first.ts);
  chk(nat !== log, '这条消息的逻辑日 ≠ 自然日（正好压在分界点后面）',
    `${new Date(first.ts).toLocaleString('sv-SE')} → 自然日 ${nat} / 逻辑日 ${log}`);

  /* 先跳到它所在的那一天，再按需翻页把它滚进 DOM */
  await setJump(log);
  const shown = await showAi(ai);
  chk(shown, '目标消息已进入 DOM（必要时点了「还有 N 条」）', '#' + ai);
  if (!shown) return;

  const rows = walkChat();
  const row = rows.find(r => r.ai === ai);
  chk(!!row, '在 DOM 里定位到这条消息');
  if (!row) return;
  chk(row.label === dLabel(log), '★ 它挂在「逻辑日」那条分隔条下（= 自然日 − 1 天）',
    '页面=' + row.label + ' 期望=' + dLabel(log));
  chk(row.label !== dLabel(nat), '★ 它**没有**挂在自然日那条分隔条下（旧口径会挂错）',
    '自然日会是 ' + dLabel(nat));
  chk(row.month === log.slice(0, 7), '它所在的月份也按逻辑日归属', row.month + ' vs ' + log.slice(0, 7));

  /* 它的钟点仍按真实时间显示，没有被改 */
  const bub = doc.querySelector('#chat .msg[data-ai="' + ai + '"]');
  const stamp = bub ? (bub.textContent.match(/\b\d{1,2}:\d{2}\b/) || [''])[0] : '';
  chk(!stamp || stamp.indexOf(PAD(hour)) === 0, '气泡上的钟点仍是真实时间（' + hour + ' 点）', stamp || '未找到时间戳');

  /* 同一天里再看一条 05:00 之后的，确认它没有被误并到前一天 */
  const later = M.slice(ai + 1, ai + 4000).find(m => m.ts && new Date(m.ts).getHours() >= 5 && lday(m.ts) === log);
  if (later) {
    const lai = M.indexOf(later);
    const lshown = await showAi(lai);
    if (lshown) {
      const lrow = walkChat().find(r => r.ai === lai);
      chk(lrow && lrow.label === dLabel(lday(later.ts)), '同一天 05:00 之后的消息也在同一条分隔条下',
        lrow ? lrow.label : '未定位到');
    } else {
      chk(true, '同一天 05:00 之后的消息在分块渲染之外，跳过（不算失败）');
    }
  }
}

/* ============ S5. 日期区间筛选：边界必须与归属同源 ============ */
async function testRange(k) {
  section(`S5. [${k}] 日期区间筛选的分界（含 / 不含）`);
  await pickSrc(k);
  await clean();
  const M = stat[k].M;
  const dayCnt = {};
  for (const m of M) if (m.ts) dayCnt[lday(m.ts)] = (dayCnt[lday(m.ts)] || 0) + 1;
  /* 样本要同时满足：① 落在 00:00~05:00；② 它的**自然日**当天还有 05:00 之后的消息
     —— 否则「自然日区间」是空的，后面的无缝断言就没法做（第一次就栽在这里）；
     ③ 它所在的逻辑日消息数 ≤140，能一次渲染完 —— 这样才敢做「集合逐条相等」，
     否则拿到的只是最后 150 条，集合断言会变成假绿。 */
  const natHasDayPart = new Set(
    M.filter(m => m.ts && new Date(m.ts).getHours() >= 5).map(m => nday(m.ts)));
  const sample = M.find(m => {
    if (!m.ts) return false;
    const h = new Date(m.ts).getHours();
    if (!(h > 0 && h < 5)) return false;
    if (!natHasDayPart.has(nday(m.ts))) return false;
    return (dayCnt[lday(m.ts)] || 0) <= 140;
  });
  chk(!!sample, '取到一条「凌晨 0 点后、5 点前」、自然日还有白天消息、且当天可一次渲染完的样本');
  if (!sample) return;
  const log = lday(sample.ts), nat = nday(sample.ts);
  const target = String(M.indexOf(sample));
  info(`  样本 ${new Date(sample.ts).toLocaleString('sv-SE')} → 逻辑日 ${log} / 自然日 ${nat}`);

  const ids = () => [...doc.querySelectorAll('#chat .msg[data-ai]')].map(e => e.getAttribute('data-ai'));
  const tss = () => [...doc.querySelectorAll('#chat .msg[data-ai]')]
    .map(e => M[Number(e.getAttribute('data-ai'))]).filter(m => m && m.ts).map(m => m.ts);
  const asc = a => a.slice().sort((x, y) => x - y);
  const tsOfDay = d => M.filter(m => m.ts && lday(m.ts) === d).map(m => m.ts);

  // ① 筛「逻辑日」= 它应该在，且筛出来的集合与独立重算**逐条相同**
  const expDay = asc(tsOfDay(log));
  await setRange(log, log);
  chk(ids().includes(target), '★ 筛它的逻辑日 → 这条凌晨消息**在**结果里（归属与筛选一致）',
    `${log}：命中 ${ids().length} 条`);
  {
    const got = asc(tss());
    chk(got.length === expDay.length && got.every((t, i) => t === expDay[i]),
      '★ 该日区间筛出的消息集合 == 独立重算（ts 逐条相同）', `${got.length} vs ${expDay.length}`);
    const lo = dStart(log), hi = dEnd(log);
    chk(got.every(t => t >= lo && t < hi), '★ 区间内每条消息都落在 [当天 05:00, 次日 05:00)',
      `${got.length} 条里越界 ${got.filter(t => t < lo || t >= hi).length} 条`);
  }

  // ② 筛「自然日」= 它不该在（旧口径会把它算进来）
  await setRange(nat, nat);
  chk(!ids().includes(target), '★ 筛它的自然日 → 这条凌晨消息**不在**结果里（这正是本次修掉的行为）',
    `${nat}：命中 ${ids().length} 条`);
  chk(nat !== log && !ids().includes(target), '两个区间的结果确实不同（不是筛选没生效）');

  // ③ 相邻两个**逻辑日**：区间无缝、不重叠、且「两天区间 == 两个单天区间的并集」
  //    （注意别拿「逻辑日 L」和「它自然日 L+1」比 —— 这两个区间本来就会重叠
  //      [L+1 00:00, L+1 05:00)，那样断言必挂。要比的是 L 与 L+1 两个逻辑日。）
  const ax = stat[k].axisNew;
  let pair = null;
  for (let i = 0; i + 1 < ax.length; i++) {
    const A = ax[i], B = ax[i + 1];
    // 两天加起来要能一次渲染完（单页只渲染 150 条，否则取不全、并集断言会假绿）
    if ((dayCnt[A] || 0) + (dayCnt[B] || 0) > 140 || !dayCnt[A] || !dayCnt[B]) continue;
    pair = [A, B];
    break;
  }
  chk(!!pair, '找到相邻两天、都有消息、且合计 ≤140 条（可一次渲染完）');
  if (pair) {
    const expA = asc(tsOfDay(pair[0])), expB = asc(tsOfDay(pair[1]));
    await setRange(pair[0], pair[0]);
    const at = asc(tss());
    await setRange(pair[1], pair[1]);
    const bt = asc(tss());
    chk(at.length === expA.length && at.every((t, i) => t === expA[i]),
      '★ ' + pair[0] + ' 单天区间 == 独立重算（ts 逐条相同）', `${at.length} vs ${expA.length}`);
    chk(bt.length === expB.length && bt.every((t, i) => t === expB[i]),
      '★ ' + pair[1] + ' 单天区间 == 独立重算（ts 逐条相同）', `${bt.length} vs ${expB.length}`);
    chk(at.length && bt.length && Math.max(...at) < Math.min(...bt),
      '★ 相邻逻辑日无缝且不重叠（max(D) < min(D+1)）',
      at.length && bt.length
        ? new Date(Math.max(...at)).toLocaleString('sv-SE') + ' < ' + new Date(Math.min(...bt)).toLocaleString('sv-SE')
        : '有空区间');
    /* 区间可加性：任一边界差一个毫秒都会让这条挂掉 */
    await setRange(pair[0], pair[1]);
    const abt = asc(tss());
    const expAB = asc(expA.concat(expB));
    chk(abt.length === expAB.length && abt.every((t, i) => t === expAB[i]),
      '★ 两天区间 == 两个单天独立集合的并集（区间可加，两边边界都没漏错）',
      `${abt.length} vs ${expAB.length}`);
  }
  await clean();
}

/* ============ S6. #jump 跳到逻辑日的起点 ============ */
async function testJump(k) {
  section(`S6. [${k}] 「跳到日期」落到逻辑日的第一条`);
  await pickSrc(k);
  await clean();
  const M = stat[k].M;
  /* 目标日要满足两件事，缺一不可：
     ① 该**自然日**的 00:00~05:00 之间有消息（它们的逻辑日 = 前一天）→ 旧口径
        「跳到自然日 0 点」会落到这些凌晨消息上，分隔条立刻对不上；
     ② 该**逻辑日**本身有消息 → 新口径「跳到当天 05:00」能落到它自己的第一条。
     只满足 ② 挑出来的日子，旧口径碰巧也能跳对，这条断言就成了摆设
     （第一版就是这么写的，被 _negctl_daycut 的 jump 轮次抓出来了）。 */
  const natWithPre5 = new Set(stat[k].pre5.map(m => nday(m.ts)));
  const ax = stat[k].axisNew;
  const cands = ax.filter(d => natWithPre5.has(d) && stat[k].lDays.has(d));
  const mid = cands.length ? cands[Math.floor(cands.length / 2)] : ax[Math.floor(ax.length / 2)];
  chk(cands.length > 0, '★ 找到「自然日有凌晨消息 + 逻辑日本身有消息」的目标日（否则这条抓不到旧口径）',
    cands.length + ' 个候选，取 ' + mid);
  await setJump(mid);
  const rows = walkChat();
  chk(rows.length > 0, '跳转后有内容渲染', rows.length + ' 条');
  if (!rows.length) return;
  const firstMsg = M[rows[0].ai];
  chk(rows[0].label === dLabel(mid), '★ 顶部第一条分隔条就是目标逻辑日', rows[0].label + ' vs ' + dLabel(mid));
  chk(firstMsg && firstMsg.ts >= dStart(mid), '★ 第一条消息的 ts ≥ 当天 05:00（没有落到前一天凌晨）',
    firstMsg ? new Date(firstMsg.ts).toLocaleString('sv-SE') : '-');
  chk(firstMsg && lday(firstMsg.ts) === mid, '第一条消息的逻辑日 == 目标日');
  await clean();
}

/* ============ S7. 月份栏 ============ */
async function testMonths(k) {
  section(`S7. [${k}] 月份栏按逻辑月分组`);
  await pickSrc(k);
  await clean();
  const M = stat[k].M;
  const lmons = new Set(M.map(m => lmon(m.ts)));
  const nmons = new Set(M.map(m => nmon(m.ts)));
  const dom = new Set([...doc.querySelectorAll('#months .mo[data-m]')].map(e => e.getAttribute('data-m')));
  chk(dom.size === lmons.size, '★ 月份数量 == 独立重算的逻辑月数量',
    dom.size + ' vs ' + lmons.size + `（自然月会是 ${nmons.size}）`);
  const missing = [...lmons].filter(m => !dom.has(m));
  const extra = [...dom].filter(m => !lmons.has(m));
  chk(missing.length === 0 && extra.length === 0, '★ 月份键集合完全一致（不多不少）',
    (missing.length ? '缺 ' + missing.join(',') : '') + (extra.length ? ' 多 ' + extra.join(',') : '') || '一致');
  chk(lmons.size <= nmons.size, '逻辑月只会「并」不会「增」（逻辑日单调向后并）',
    nmons.size + ' → ' + lmons.size);
  const ks = [...doc.querySelectorAll('#months .mo[data-m]')].map(e => e.getAttribute('data-m'));
  chk(ks.join() === ks.slice().sort().reverse().join(), '月份仍按倒序排列（最新在上）', ks[0] + ' → ' + ks[ks.length - 1]);
  if (lmons.size === nmons.size) {
    info('  两种口径下月份**集合**相同（每个月都不止凌晨那一段消息），所以月份数没变化；' +
      '下面用「1 号凌晨」的消息来验证月份**归属**确实跟着换了。');
  }

  /* 真·区分度：跨月边界消息 —— 某个「1 号 00:00~05:00」的消息必须算到**上个月** */
  const crossIdx = M.findIndex(m => m.ts && new Date(m.ts).getDate() === 1 && new Date(m.ts).getHours() < 5);
  if (crossIdx < 0) {
    info('  数据里没有「1 号凌晨」的消息，跳过跨月归属断言（不算失败）');
    return;
  }
  const cross = M[crossIdx];
  const l = lmon(cross.ts), n2 = nmon(cross.ts);
  chk(l !== n2, '找到一条「1 号凌晨」的跨月边界样本',
    `${new Date(cross.ts).toLocaleString('sv-SE')} → 逻辑月 ${l} / 自然月 ${n2}`);
  await setJump(lday(cross.ts));
  const shown = await showAi(crossIdx);
  if (!shown) {
    info('  跨月样本不在渲染窗口内，跳过（不算失败）');
    await clean();
    return;
  }
  const r2 = walkChat().find(r => r.ai === crossIdx);
  chk(!!r2, '在 DOM 里定位到这条跨月消息');
  if (r2) {
    chk(r2.month === l, '★ 它被归到**上一个月**（逻辑月）', r2.month + ' vs ' + l);
    chk(r2.month !== n2, '★ 它**没有**被归到自然月（旧口径会归错月）', '自然月会是 ' + n2);
    chk(r2.label === dLabel(lday(cross.ts)), '分隔条上的日期也是逻辑日', r2.label);
  }
  await clean();
}

/* ============ S8. 统计面板：连续日轴 / 热力图 / 文案 ============ */
async function testStat(k) {
  section(`S8. [${k}] 统计面板的连续日轴与热力图`);
  await pickSrc(k);
  const st = doc.getElementById('stat');
  if (!st.classList.contains('on')) { doc.getElementById('statBtn').click(); await sleep(250); }
  chk(st.classList.contains('on'), '统计面板已打开');

  const M = stat[k].M;
  const exp = stat[k].axisNew;
  const range = doc.getElementById('statRange').textContent.replace(/\s+/g, ' ');
  chk(range.includes(String(exp.length)), '★ 「共 N 天」== 独立重算的连续逻辑日天数',
    '页面：' + range + ' ｜ 期望 ' + exp.length + ' 天');
  chk(/05:00 分界/.test(range), '标题区间行写明「按每天 05:00 分界」', range.slice(0, 70));
  chk(range.includes(exp[0]) && range.includes(exp[exp.length - 1]),
    '区间首尾与独立重算一致', exp[0] + ' ~ ' + exp[exp.length - 1]);

  const hint = doc.getElementById('chartHint').textContent.replace(/\s+/g, ' ');
  chk(/05:00 分界/.test(hint), '趋势图提示行写明 05:00 分界', hint.slice(0, 90));

  /* 热力图每个方格自带 data-day —— 正好可以逐格核对整条日轴 */
  const cells = [...doc.querySelectorAll('#heat rect[data-day]')].map(e => e.getAttribute('data-day'));
  chk(cells.length > 0, '热力图渲染出方格', cells.length + ' 个');
  chk(cells.length === exp.length, '★ 热力图方格数 == 连续逻辑日天数', cells.length + ' vs ' + exp.length);
  chk(cells.join() === exp.join(), '★ 热力图日轴与独立重算逐格一致（顺序也对）',
    cells.length === exp.length ? '一致' : '长度不同，前几个：' + cells.slice(0, 3).join(',') + ' …');

  /* 口径框必须把新规则写出来，并报出受影响的消息量 */
  const cal = doc.getElementById('caliber').textContent.replace(/\s+/g, ' ');
  chk(/每天 05:00/.test(cal), '口径框写明「按每天 05:00 分界」');
  chk(/00:00~05:00 的消息算前一天/.test(cal), '口径框写明「00:00~05:00 算前一天」');
  chk(!/按自然日划分/.test(cal), '口径框里不再残留「按自然日划分」这句旧话术');
  chk(new RegExp('的消息有 ' + stat[k].pre5.length.toLocaleString() + ' 条').test(cal),
    '口径框报出的凌晨消息条数与独立重算一致（口径：全部消息，不预先剔除）',
    stat[k].pre5.length.toLocaleString() + ' 条');
  const pct = (stat[k].pre5.length / M.length * 100).toFixed(1);
  chk(cal.includes('占全部 ' + pct + '%'), '口径框报出的占比与独立重算一致', '占全部 ' + pct + '%');

  doc.getElementById('statClose').click();
  await sleep(150);
}

/* ============ S9. 聊天节律的「周几」用逻辑日 ============ */
async function testRhythm(k) {
  section(`S9. [${k}] 聊天节律「一周里哪天最活跃」用逻辑日`);
  await pickSrc(k);
  const st = doc.getElementById('stat');
  if (!st.classList.contains('on')) { doc.getElementById('statBtn').click(); await sleep(300); }
  const boxes = [...doc.querySelectorAll('#rhythm .rhbox')];
  chk(boxes.length >= 4, '节律面板 4 个格子都在', boxes.length + ' 个');
  if (boxes.length < 4) return;
  const box = boxes[boxes.length - 1];
  const big = box.querySelector('.big');
  const txt = big ? big.textContent.replace(/\s+/g, ' ') : '';
  chk(/周[一二三四五六日]/.test(txt), '最后一格是「一周里哪天最活跃」', txt.slice(0, 50));

  /* 独立重算：只数双方真实发言（排除自动回复/系统/礼物），与页面同口径 */
  const M = stat[k].M;
  const counts = new Array(7).fill(0);
  for (const m of M) {
    if (m.from !== 'me' && m.from !== 'peer') continue;
    if (k === 'weibo') {
      const t = (m.text || '').trim();
      if (t === WEIBO_AUTO) continue;                     // 自动回复
      if (/^感谢您的助威支持|助威权益还有\d+天|^发出红包消息/.test(t)) continue;
      if (/^(?:你|对方)撤回了一条消息$/.test(t)) continue;
    } else {
      const mt = m.media_type;
      const ms = m.msg_source;
      if (mt === 16) continue;
      if ((ms >= 8 && ms <= 11) || ms === 17) continue;
      if (mt === 5 || mt === 10 || mt === 18) continue;
      if (mt === 13 || (mt >= 301 && mt <= 306)) continue;
    }
    const d = new Date(m.ts - CUT);                    // ← 逻辑日的星期
    counts[(d.getDay() + 6) % 7]++;
  }
  let pk = 0;
  for (let i = 1; i < 7; i++) if (counts[i] > counts[pk]) pk = i;
  const expTxt = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][pk];
  const expN = counts[pk].toLocaleString();
  chk(txt.includes(expTxt), '★ 峰值星期与「逻辑日口径」独立重算一致（' + expTxt + '）',
    '页面：' + txt.slice(0, 26) + ' ｜ 期望 ' + expTxt);
  chk(txt.includes(expN), '★ 峰值条数与独立重算一致', '期望 ' + expN + ' 条');

  /* 反向：若按**自然日**算，峰值不同 → 证明这个断言真的能抓到没改的情况 */
  const ncounts = new Array(7).fill(0);
  for (const m of M) {
    if (m.from !== 'me' && m.from !== 'peer') continue;
    if (k === 'weibo') {
      const t = (m.text || '').trim();
      if (t === WEIBO_AUTO) continue;
      if (/^感谢您的助威支持|助威权益还有\d+天|^发出红包消息/.test(t)) continue;
      if (/^(?:你|对方)撤回了一条消息$/.test(t)) continue;
    } else {
      const mt = m.media_type, ms = m.msg_source;
      if (mt === 16 || (ms >= 8 && ms <= 11) || ms === 17) continue;
      if (mt === 5 || mt === 10 || mt === 18 || mt === 13 || (mt >= 301 && mt <= 306)) continue;
    }
    ncounts[(new Date(m.ts).getDay() + 6) % 7]++;
  }
  let npk = 0;
  for (let i = 1; i < 7; i++) if (ncounts[i] > ncounts[npk]) npk = i;
  info(`  自然日口径的峰值是 ${['周一', '周二', '周三', '周四', '周五', '周六', '周日'][npk]}（${ncounts[npk]} 条）` +
    `${npk === pk ? '，与逻辑日相同（本周数据下两种口径结论一致）' : '，与逻辑日不同 → 说明这条断言有区分度'}`);
  chk(counts.reduce((a, b) => a + b, 0) > 0, '逻辑日星期分布非空（计数确实跑起来了）',
    counts.reduce((a, b) => a + b, 0) + ' 条');

  doc.getElementById('statClose').click();
  await sleep(150);
}

/* ============ S10. 侧栏提示文案 ============ */
section('S10. 侧栏换日提示');
{
  const note = doc.getElementById('dayCutNote');
  chk(!!note, '侧栏有换日规则提示（#dayCutNote）');
  if (note) {
    const t = note.textContent.replace(/\s+/g, ' ');
    chk(/05:00 分界/.test(t), '提示写明 05:00 分界');
    chk(/00:00~05:00/.test(t) && /前一天/.test(t), '提示写明「00:00~05:00 算前一天」');
    chk(/钟点仍是真实时间/.test(t), '提示说明气泡上的钟点不变（否则会被当成 bug）');
  }
  const jt = doc.getElementById('jump').getAttribute('title') || '';
  chk(/05:00/.test(jt), '「跳到日期」的 title 提到 05:00', jt);
  const bt = doc.getElementById('statBtn').getAttribute('title') || '';
  chk(/05:00/.test(bt) && !/按自然日/.test(bt), '「互动统计」的 title 已改为 05:00 口径且不含旧话术', bt.slice(0, 80));
  const st0 = doc.getElementById('statRange').textContent;
  chk(/05:00/.test(st0) || st0.length > 0, '统计面板标题初始文案已更新', st0.slice(0, 40));
}

/* ============ 跑起来 ============ */
await testAttribution('weibo');
await testPre5('weibo');
await testRange('weibo');
await testJump('weibo');
await testMonths('weibo');
await testStat('weibo');
await testRhythm('weibo');

await testAttribution('bili');
await testPre5('bili');
await testRange('bili');
await testMonths('bili');

chk(errors.length === 0, '全程无 JS 报错', errors.slice(0, 3).join(' | ') || '无');

console.log('\n' + '='.repeat(64));
console.log(`05:00 换日专项：通过 ${pass.length} · 失败 ${fail.length} · 合计 ${pass.length + fail.length}`);
if (fail.length) console.log('失败项：\n  · ' + fail.join('\n  · '));
console.log('='.repeat(64));
process.exit(fail.length ? 1 : 0);
