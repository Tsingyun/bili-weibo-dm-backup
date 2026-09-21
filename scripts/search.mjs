#!/usr/bin/env node
/* ============================================================
   P2-16 · 本地全文检索（查询端）
   ============================================================
   读 scripts/build_fts.mjs 建好的 search/dm_search.db，秒级返回命中。
   索引不存在时不会自己去建（建库要几秒），会明确告诉你先跑哪条命令。

   ⚠ 纯本地：只读本地 SQLite 文件，不联网、不上传。

   两条查询路径（自动选，输出里会写清楚走的哪条）：
     · 全部关键词都 ≥3 个字 → FTS5 trigram 的 MATCH（快）
     · 有词短于 3 个字 / 用了 --regex → LIKE 全表扫（慢一点，结果一致）
   原因是 FTS5 的 trigram 分词器建的是 3 字滑窗倒排，2 字及以下的词 MATCH 不到。

   交互模式（--interactive）：一行一个查询，边看边换词。
   为什么把它放在 Node 里而不是 .cmd 的 set /p：cmd 控制台的中文输入会按代码页
   转字节，中文关键词经常变成乱码；Node 直接读 stdin 的 UTF-8 就没事。
   双击「搜索备份.cmd」走的就是这条路。

   用法：
     node scripts/search.mjs 直播
     node scripts/search.mjs 小岁 直播 --session bili
     node scripts/search.mjs 演唱会 --kind count --limit 50
     node scripts/search.mjs "^生日快乐" --regex --context 2
     node scripts/search.mjs --interactive
     node scripts/search.mjs 新年 --json > hits.json
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, loadSessions } from './sessions.mjs';
import { DAY_CUT_MS } from './msg_kind.mjs';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, d = null) => {
  const i = ARGS.indexOf(f);
  if (i < 0) return d;
  const v = ARGS[i + 1];
  if (v === undefined || v.startsWith('--')) return d;
  return v;
};

const OPT_WITH_VALUE = new Set([
  '--session', '--kind', '--sender', '--since', '--until', '--limit', '--context', '--db',
]);
const FLAGS = new Set(['--json', '--regex', '--interactive', '-i', '--help', '-h']);

const USAGE = `本地全文检索（纯本地，不联网）

  node scripts/search.mjs <关键词...> [选项]

  关键词可以给多个（全部都要命中）。含空格的长句子请用引号包起来，例如：
    node scripts/search.mjs "第一次直播"

  --session <key|all>      默认 all
  --kind <count|auto|sys|gift|all>   按消息分类筛，默认 all
  --sender <me|peer|all>   只看我发的 / TA 发的，默认 all
  --since YYYY-MM-DD       只搜这个「日」（当天 05:00 起）之后 —— 换日按凌晨 5 点算
  --until YYYY-MM-DD       只搜这个「日」（到次日 05:00 止）之前
  --limit N                最多显示 N 条，默认 30（--limit 0 = 全部）
  --context N              每条命中再显示前后各 N 条上下文
  --regex                  关键词当正则用（交给 JS，走全表扫）
  --interactive, -i        交互模式：一行一个查询，回车空行退出
  --json                   输出 JSON（便于喂给别的脚本）
  --db <path>              指定索引库，默认 search/dm_search.db

  索引不存在或过期时，先跑：
    node scripts/build_fts.mjs`;

if (has('--help') || has('-h')) { console.log(USAGE); process.exit(0); }

const INTERACTIVE = has('--interactive') || has('-i');

const DB_PATH = path.resolve(ROOT, val('--db', 'search/dm_search.db'));
const JSON_OUT = has('--json');
const USE_REGEX = has('--regex');
const sessionFilter = val('--session', 'all');
const kindFilter = val('--kind', 'all');
const senderFilter = val('--sender', 'all');
const sinceStr = val('--since');
const untilStr = val('--until');
const limitRaw = val('--limit');
const limit = limitRaw == null ? 30 : Math.max(0, parseInt(limitRaw, 10) || 0);
const ctxN = Math.max(0, parseInt(val('--context', '0'), 10) || 0);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
for (const [k, v] of [['--since', sinceStr], ['--until', untilStr]]) {
  if (v && !DATE_RE.test(v)) {
    console.error(`[x] ${k} 要写成 YYYY-MM-DD，收到的是「${v}」`);
    process.exit(2);
  }
}
if (!['all', 'count', 'auto', 'sys', 'gift'].includes(kindFilter)) {
  console.error('[x] --kind 只能是 count / auto / sys / gift / all');
  process.exit(2);
}
if (!['all', 'me', 'peer'].includes(senderFilter)) {
  console.error('[x] --sender 只能是 me / peer / all');
  process.exit(2);
}

/* ---------- 位置参数 = 关键词 ---------- */
const cliTokens = [];
for (let i = 0; i < ARGS.length; i++) {
  const a = ARGS[i];
  if (OPT_WITH_VALUE.has(a)) { i++; continue; }
  if (FLAGS.has(a)) continue;
  if (a.startsWith('--')) continue;
  cliTokens.push(a);
}

if (!cliTokens.length && !INTERACTIVE) {
  console.error('[x] 没给关键词。用法：node scripts/search.mjs 关键词');
  console.error('    或走交互模式：node scripts/search.mjs --interactive');
  process.exit(2);
}

if (!fs.existsSync(DB_PATH)) {
  console.error('[x] 索引库不存在：' + path.relative(ROOT, DB_PATH));
  console.error('    先建一次索引：node scripts/build_fts.mjs');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

/* ---------- 结构守卫：老版本建的库缺列，直接说清楚怎么办 ---------- */
const cols = db.prepare('PRAGMA table_info(msg)').all().map((c) => c.name);
const NEED_COLS = ['side', 'disp'];
const missingCols = NEED_COLS.filter((c) => !cols.includes(c));
if (missingCols.length) {
  console.error(`[x] 索引库是旧版本建的（msg 表缺 ${missingCols.join('、')}）。`);
  console.error('    重建一次即可：node scripts/build_fts.mjs');
  process.exit(1);
}

/* ---------- 换日口径守卫：day 列是按哪套日子切的 ----------
   一天 = 当天 05:00 → 次日 05:00（见 build_fts.mjs 的 dayOf）。
   老索引里没有 day_cut、或值与当前口径不同 → --since/--until 会按另一套日子过滤，
   结果是「筛 9/15 却混进 9/16 凌晨的消息」。这种错很隐蔽，所以要显式拦一下。 */
const dayCutRow = db.prepare("SELECT v FROM meta WHERE k='day_cut'").get();
const dayCutDb = dayCutRow ? Number(dayCutRow.v) : null;
const dayCutStale = dayCutDb !== DAY_CUT_MS;
if (dayCutStale && (sinceStr || untilStr) && !JSON_OUT) {
  console.error('[!] 索引库的「换日口径」与当前脚本不一致' +
    (dayCutDb == null ? '（旧索引没有这个标记，按自然日 0 点切的）' : `（索引 ${dayCutDb / 3600000}h / 脚本 ${DAY_CUT_MS / 3600000}h）`) +
    '，--since/--until 的结果会与查看页对不上。');
  console.error('    重建一次即可：node scripts/build_fts.mjs');
}

/* ---------- 过期提醒：索引行数 vs 数据条数 ---------- */
function staleSessions() {
  const out = [];
  for (const S of loadSessions()) {
    if (sessionFilter !== 'all' && S.key !== sessionFilter) continue;
    const p = path.join(ROOT, S.dir, 'messages.json');
    if (!fs.existsSync(p)) continue;
    let want = 0;
    try { want = JSON.parse(fs.readFileSync(p, 'utf8')).length; } catch { continue; }
    const got = db.prepare('SELECT count(*) c FROM msg WHERE session=?').get(S.key).c;
    if (want !== got) out.push(`${S.key}（索引 ${got} / 数据 ${want}）`);
  }
  return out;
}
const stale = staleSessions();
if (stale.length && !JSON_OUT) {
  console.error('[!] 索引可能过期：' + stale.join('，') + '　→ 跑一次 node scripts/build_fts.mjs');
}

/* ---------- SQL 骨架（过滤器在启动时定死，交互模式沿用它） ---------- */
// m.disp 是给人看的正文；f.body 是含署名/类型的匹配正文，只在 --regex 二次过滤时取回来。
const SEL = 'm.session, m.i, m.ts, m.day, m.sender, m.side, m.kind, m.type, m.recalled, m.disp' +
  (USE_REGEX ? ', f.body' : '');
const FROM = 'FROM msg m JOIN msg_fts f ON f.rowid = m.rowid';

const baseWhere = [];
const baseParams = [];
if (sessionFilter !== 'all') { baseWhere.push('m.session = ?'); baseParams.push(sessionFilter); }
if (kindFilter !== 'all') { baseWhere.push('m.kind = ?'); baseParams.push(kindFilter); }
if (senderFilter !== 'all') { baseWhere.push('m.side = ?'); baseParams.push(senderFilter); }
if (sinceStr) { baseWhere.push('m.day >= ?'); baseParams.push(sinceStr); }
if (untilStr) { baseWhere.push('m.day <= ?'); baseParams.push(untilStr); }

const ctxStmt = ctxN > 0
  ? db.prepare(`SELECT m.i, m.side, m.kind, m.ts, m.day, m.disp
                FROM msg m WHERE m.session = ? AND m.i BETWEEN ? AND ? ORDER BY m.i`)
  : null;

const LBL = { count: '', auto: '自动回复', sys: '系统', gift: '礼物/提示' };
const oneLine = (s) => String(s || '').replace(/[\u0001\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
const trim = (s, n = 110) => (s.length > n ? s.slice(0, n) + '…' : s);
const sideTag = (s) => (s === 'me' ? '我  ' : (s === 'peer' ? 'TA  ' : '    '));
const fmtTime = (row) => {
  if (row.ts == null) return row.day || '?';
  const d = new Date(row.ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 跑一次查询，返回 { rows, pathUsed, ms }；正则写错时抛错由调用方处理 */
function query(tokens) {
  const where = [...baseWhere];
  const params = [...baseParams];
  const t0 = Date.now();
  let rows, pathUsed;

  const allLong = tokens.every((t) => [...t].length >= 3);
  if (allLong && !USE_REGEX) {
    pathUsed = 'FTS5 MATCH（trigram）';
    // 每个关键词当短语查（引号内是字面量），多个词之间是 AND
    const match = tokens.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' AND ');
    const sql = `SELECT ${SEL} ${FROM}
                 WHERE msg_fts MATCH ?${where.length ? ' AND ' + where.join(' AND ') : ''}
                 ORDER BY m.ts`;
    rows = db.prepare(sql).all(match, ...params);
  } else {
    pathUsed = USE_REGEX ? '全表扫 + JS 正则' : 'LIKE 全表扫（有关键词短于 3 个字）';
    for (const t of tokens) { where.push('f.body LIKE ?'); params.push('%' + t + '%'); }
    const sql = `SELECT ${SEL} ${FROM}
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY m.ts`;
    rows = db.prepare(sql).all(...params);
  }

  if (USE_REGEX) {
    const res = tokens.map((t) => new RegExp(t, 'i')); // 语法错误往上抛
    rows = rows.filter((r) => res.every((re) => re.test(r.body)));
  }
  return { rows, pathUsed, ms: Date.now() - t0 };
}

function printResult(tokens, res) {
  const { rows, pathUsed, ms } = res;
  const shown = limit > 0 ? rows.slice(0, limit) : rows;

  if (JSON_OUT) {
    console.log(JSON.stringify({
      query: tokens, path: pathUsed, ms, total: rows.length, shown: shown.length, stale,
      hits: shown.map((r) => ({
        session: r.session, i: r.i, ts: r.ts, day: r.day, sender: r.sender,
        from: r.side, kind: r.kind, type: r.type, recalled: !!r.recalled, text: r.disp,
      })),
    }, null, 2));
    return;
  }

  console.log(`查询：${tokens.join(' + ')}　·　${pathUsed}　·　${ms} ms`);
  console.log(`命中 ${rows.length.toLocaleString()} 条` +
    (limit > 0 && rows.length > limit ? `（显示前 ${shown.length} 条）` : '') + '\n');
  for (const r of shown) {
    const kindTag = LBL[r.kind] ? `[${LBL[r.kind]}] ` : '';
    // 显示用 m.disp（干净正文）；匹配用的 f.body 含署名/类型，是另一列，别混用
    console.log(`${fmtTime(r)}  ${String(r.session).padEnd(6)} ${sideTag(r.side)}${kindTag}${trim(oneLine(r.disp))}`);
    if (ctxStmt) {
      for (const c of ctxStmt.all(r.session, r.i - ctxN, r.i + ctxN)) {
        if (c.i === r.i) continue;
        console.log(`        ↑↓ ${sideTag(c.side)}${trim(oneLine(c.disp), 90)}`);
      }
    }
  }
  if (!rows.length) {
    console.log('（没有命中。可以换个词，或加 --regex / --since 放宽范围）');
  }
  console.log('');
}

function runOne(tokens) {
  if (!tokens.length) return;
  let res;
  try {
    res = query(tokens);
  } catch (e) {
    console.error(`[x] 查询出错：${e.message}` + (USE_REGEX ? '（--regex 的正则写错了？）' : ''));
    return;
  }
  printResult(tokens, res);
}

/* ---------- 交互模式 ---------- */
if (INTERACTIVE) {
  const scope = [];
  if (sessionFilter !== 'all') scope.push('会话=' + sessionFilter);
  if (kindFilter !== 'all') scope.push('分类=' + kindFilter);
  if (senderFilter !== 'all') scope.push('只看' + (senderFilter === 'me' ? '我发的' : 'TA 发的'));
  if (sinceStr) scope.push('从 ' + sinceStr);
  if (untilStr) scope.push('到 ' + untilStr);
  console.log('本地全文检索 · 交互模式（纯本地，不联网）');
  console.log('筛选：' + (scope.length ? scope.join(' · ') : '全部消息') +
    '　·　每条显示上限 ' + (limit > 0 ? limit : '不限') +
    (USE_REGEX ? '　·　正则模式' : ''));
  console.log('输入关键词后回车搜索；多个词用空格隔开（全部命中）；直接回车退出。\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('line', (line) => {
    const tokens = String(line).trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) { rl.close(); return; }
    runOne(tokens);
    process.stdout.write('> ');
  });
  rl.on('close', () => {
    db.close();
    console.log('已退出。');
    process.exit(0);
  });
  process.stdout.write('> ');
} else {
  runOne(cliTokens);
  db.close();
}
