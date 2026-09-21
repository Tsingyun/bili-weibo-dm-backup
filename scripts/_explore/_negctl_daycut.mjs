/* 反向验证（negative control）：换日口径（2026-09-18）
   ------------------------------------------------------------
   这次改动同时动了 6 个地方，它们必须同源。光跑一遍 verify_daycut 全绿
   只能证明「现在的代码是对的」，证明不了「测试真的盯得住这 6 处」。
   本项目的老规矩（_negctl_linkcolor.mjs / _negctl_hide.mjs 都是这么干的）：
   **把旧写法注回去，确认对应的断言会报红。**

   而且是**一轮只注一处** —— 全部注回去只能说明「核心被改坏了」，
   说明不了「第 4 处单独坏掉时测试能不能发现」。

   六个轮次：
     core   时间戳不再减 5 小时（最根本的一处：dayKey / dayLabel / monthKey 全靠它）
     month  月份栏改回按自然月分组
     range  日期区间改回「当天 00:00 → 次日 00:00」
     jump   「跳到日期」改回当天 00:00
     axis   折线图的连续日轴改回按自然日逐日 +1
     dow    「一周里哪天最活跃」改回自然日星期

   用法：
     node scripts/_explore/_negctl_daycut.mjs              # 六轮全跑（约 3 分钟）
     node scripts/_explore/_negctl_daycut.mjs core         # 只跑某一轮
     node scripts/_explore/_negctl_daycut.mjs restore      # 万一中途挂了，手动还原
*/
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.cwd());
const FILE = path.join(ROOT, '查看备份.html');
const BAK = path.join(ROOT, 'scripts', '_explore', '.查看备份.html.daycut-negctl.bak');
const NODE = process.execPath;
const VERIFY = path.join(ROOT, 'scripts', '_explore', 'verify_daycut.mjs');

function restore() {
  if (fs.existsSync(BAK)) {
    fs.copyFileSync(BAK, FILE);
    fs.unlinkSync(BAK);
    console.log('[ok] 已还原 查看备份.html');
  } else {
    console.log('[--] 没有备份文件，无需还原');
  }
}
if ((process.argv[2] || '') === 'restore') { restore(); process.exit(0); }
if (fs.existsSync(BAK)) { console.error('[×] 上次的反向验证没还原干净，先跑一次 restore'); process.exit(2); }

/* 每处的 from 必须**确实存在且只存在一处**，否则说明页面结构变了、
   这套反向验证已经失效 —— 宁可炸掉也别静默通过。 */
const ROUNDS = {
  core: {
    why: '时间戳不再减 5 小时（dayKey / dayLabel / monthKey / 月份栏全部退回自然日）',
    patches: [[
      'function dayDate(t){ return new Date((t instanceof Date ? t.getTime() : t) - DAY_CUT); }',
      'function dayDate(t){ return new Date(t instanceof Date ? t.getTime() : t); }   /* NEGCTL */',
    ]],
    /* ⚠ 这一轮**不**改「日期区间筛选」和「跳到日期」—— 它们各自用 dayStartTs/dayEndTs
       定边界，与 dayDate 无关，所以在本轮里本来就该保持绿色（那两处由 range/jump 轮盯着）。
       第一版把它们的断言也列在这里，结果被自己的输出打脸：7/9。 */
    mustFail: [
      '每条消息都归到「独立重算的逻辑日」那一条分隔条下',
      '它挂在「逻辑日」那条分隔条下（= 自然日 − 1 天）',
      '它**没有**挂在自然日那条分隔条下（旧口径会挂错）',
      '它所在的月份也按逻辑日归属',
      '月份键集合完全一致（不多不少）',
      '它被归到**上一个月**（逻辑月）',
      '它**没有**被归到自然月（旧口径会归错月）',
      '「共 N 天」== 独立重算的连续逻辑日天数',
      '热力图方格数 == 连续逻辑日天数',
      '热力图日轴与独立重算逐格一致（顺序也对）',
      '峰值星期与「逻辑日口径」独立重算一致',
      '峰值条数与独立重算一致',
    ],
  },
  month: {
    why: '月份栏退回按自然月分组（分隔条说 1 月、月份栏说 2 月）',
    patches: [[
      '      var d = dayDate(m.ts);                 // 月份归属也用「减 5 小时」的逻辑日期',
      '      var d = new Date(m.ts);   /* NEGCTL */',
    ]],
    /* 月份栏是 #months 那一列，只有「键集合一致」盯得住它；
       「它被归到上一个月」读的是**分隔条**的 data-m，属于 core 轮的覆盖范围。 */
    mustFail: [
      '月份键集合完全一致（不多不少）',
    ],
  },
  range: {
    why: '日期区间退回「当天 00:00 → 次日 00:00」',
    patches: [[
      '    var sinceTs = st.since ? dayStartTs(st.since) : 0;\n    var untilTs = st.until ? dayEndTs(st.until) : 0;',
      '    var sinceTs = st.since ? new Date(st.since + \'T00:00:00\').getTime() : 0;   /* NEGCTL */\n'
      + '    var untilTs = st.until ? new Date(st.until + \'T00:00:00\').getTime() + 86400000 : 0;   /* NEGCTL */',
    ]],
    mustFail: [
      '筛它的逻辑日 → 这条凌晨消息**在**结果里（归属与筛选一致）',
      '筛它的自然日 → 这条凌晨消息**不在**结果里（这正是本次修掉的行为）',
      '该日区间筛出的消息集合 == 独立重算（ts 逐条相同）',
      '单天区间 == 独立重算（ts 逐条相同）',
      '两天区间 == 两个单天独立集合的并集（区间可加，两边边界都没漏错）',
    ],
  },
  jump: {
    why: '「跳到日期」退回当天 00:00',
    patches: [[
      '    var target = dayStartTs(v);',
      '    var target = new Date(v + \'T00:00:00\').getTime();   /* NEGCTL */',
    ]],
    mustFail: [
      '顶部第一条分隔条就是目标逻辑日',
      '第一条消息的 ts ≥ 当天 05:00（没有落到前一天凌晨）',
    ],
  },
  axis: {
    why: '折线图连续日轴退回按自然日逐日 +1',
    patches: [[
      '    var cur = dayNoon(dayKey(tmin)), lastD = dayNoon(dayKey(tmax));',
      '    var cur = new Date(tmin), lastD = new Date(tmax);   /* NEGCTL */\n'
      + '    cur.setHours(0,0,0,0); lastD.setHours(0,0,0,0);',
    ]],
    mustFail: [
      '「共 N 天」== 独立重算的连续逻辑日天数',
      '热力图方格数 == 连续逻辑日天数',
      '热力图日轴与独立重算逐格一致（顺序也对）',
    ],
  },
  dow: {
    why: '「一周里哪天最活跃」退回自然日星期',
    patches: [[
      '      var h = d.getHours(), w = (dayDate(m.ts).getDay() + 6) % 7;',
      '      var h = d.getHours(), w = (d.getDay() + 6) % 7;   /* NEGCTL */',
    ]],
    mustFail: [
      '峰值星期与「逻辑日口径」独立重算一致',
      '峰值条数与独立重算一致',
    ],
  },
};

const only = process.argv[2] || '';
const keys = only ? [only] : Object.keys(ROUNDS);
if (only && !ROUNDS[only]) {
  console.error('[×] 不认识这一轮：' + only + '，可选 ' + Object.keys(ROUNDS).join(' / '));
  process.exit(2);
}

fs.copyFileSync(FILE, BAK);
const original = fs.readFileSync(BAK, 'utf8');
const summary = [];

for (const key of keys) {
  const R = ROUNDS[key];
  console.log('\n' + '#'.repeat(64));
  console.log(`# 轮次 ${key}：${R.why}`);
  console.log('#'.repeat(64));

  let s = original;
  let bad = false;
  for (const [from, to] of R.patches) {
    const n = s.split(from).length - 1;
    if (n !== 1) {
      console.error(`  [×] 期望命中 1 处，实际 ${n} 处 —— 页面结构变了，这套反向验证得重写：`);
      console.error('      ' + from.replace(/\n/g, '\\n').slice(0, 110));
      bad = true;
      break;
    }
    s = s.replace(from, to);
  }
  if (bad) { fs.copyFileSync(BAK, FILE); process.exit(2); }
  fs.writeFileSync(FILE, s, 'utf8');

  const r = spawnSync(NODE, [VERIFY], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const failBlock = out.split('失败项：')[1] || '';
  const total = (/通过 (\d+) · 失败 (\d+)/.exec(out) || [])[0] || '(没解析到汇总行)';
  console.log('  跑 verify_daycut：' + total);
  const reds = failBlock.split('\n').map(l => l.replace(/^\s*·\s*/, '').trim()).filter(Boolean);

  const missed = R.mustFail.filter(m => !reds.some(x => x.includes(m)));
  const hit = R.mustFail.length - missed.length;
  console.log(`  核心断言被打红：${hit}/${R.mustFail.length}`);
  for (const m of R.mustFail) {
    const isRed = !missed.includes(m);
    console.log(`    ${isRed ? '🔴' : '⚪'} ${m}`);
  }
  if (reds.length) {
    console.log('  verify_daycut 报的全部失败项：');
    for (const x of reds.slice(0, 14)) console.log('    · ' + x);
    if (reds.length > 14) console.log(`    … 另有 ${reds.length - 14} 项`);
  }
  summary.push({ key, exit: r.status, reds: reds.length, hit, need: R.mustFail.length, missed });
  fs.copyFileSync(BAK, FILE);   // 每轮之间立即还原，避免互相污染
}

fs.unlinkSync(BAK);

console.log('\n' + '='.repeat(64));
let allGood = true;
for (const s of summary) {
  const ok = s.exit !== 0 && s.hit === s.need;
  if (!ok) allGood = false;
  console.log(`${ok ? '[ok]' : '[×] '} ${s.key.padEnd(6)} exit=${s.exit} 打红 ${s.hit}/${s.need}` +
    (s.missed.length ? '　漏掉：' + s.missed.join(' ; ') : ''));
}
console.log('='.repeat(64));
console.log(allGood
  ? `六处修改点都各有一条「专属断言」盯着：${summary.length} 轮全部按预期报红 ✅`
  : '有轮次没按预期报红 —— 说明对应那条断言抓不到这一类 bug，测试得补强 ❌');
process.exit(allGood ? 0 : 1);
