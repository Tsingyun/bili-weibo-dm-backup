#!/usr/bin/env node
/* ============================================================
   P2-16 · 本地全文检索索引（SQLite FTS5）
   ============================================================
   查看页的搜索是「内存里全量扫」，数据量再大一个数量级就会卡。
   这里用 Node 自带的 node:sqlite（Node ≥ 22，零第三方依赖）建一份 FTS5 索引，
   命令行可以秒级查，也能给别的脚本当检索后端。

   ⚠ 纯本地：数据库文件就落在项目里的 search/dm_search.db，不联网、不上传。

   ⚠ 中文分词的取舍：FTS5 没有中文分词器，这里用内置的 **trigram** 分词器
     （按 3 个字滑窗建索引）。代价是**查询词短于 3 个字 MATCH 不到** ——
     search.mjs 遇到这种查询会自动退回 LIKE 全表扫，结果一样只是慢一点。
     语料只有万级，LIKE 兜底完全够用。

   表结构（两张表 + 一个 meta）：
     msg      rowid / session / i / ts / day / sender / side / kind / type / recalled / disp
              （side 就是 messages.json 里的 from：me / peer）
     msg_fts  fts5(body, tokenize='trigram')   ← 检索正文只存在这里，不重复存
   为什么另有 disp：body 为了让「按发送者名搜」也能命中，塞进了 sender / type / card，
   直接打出来会拖着「发送者名 text」这样的尾巴；disp 是干净的展示文本，只用来显示。
   为什么不用 content='msg' 的外部内容表：外部内容表**禁止直接 DELETE**，
   只能走 'delete' 特殊命令；而按会话重建时我得按会话删旧行，用普通 FTS5
   表让 DELETE 正常工作，代价是正文只存一份（本来也只有几 MB）。

   用法：
     node scripts/build_fts.mjs                # 重建（默认全部会话）
     node scripts/build_fts.mjs --session bili
     node scripts/build_fts.mjs --check        # 只核对行数，不重建
     node scripts/build_fts.mjs --info         # 看库信息
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, loadSessions, findSession } from './sessions.mjs';
import { msgKind, DAY_CUT_MS } from './msg_kind.mjs';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, d = null) => {
  const i = ARGS.indexOf(f);
  if (i < 0) return d;
  const v = ARGS[i + 1];
  if (v === undefined || v.startsWith('--')) return d;
  return v;
};

if (has('--help') || has('-h')) {
  console.log(`本地全文检索索引（SQLite FTS5 · 纯本地）

  --session <key|all>   只重建某个会话，默认 all
  --db <path>           数据库路径，默认 search/dm_search.db
  --check               不重建，只核对「索引行数 vs messages.json 条数」
  --info                打印库信息（会话、行数、体积、建立时间）
  --quiet

  建完用 scripts/search.mjs 查询，或双击「搜索备份.cmd」。`);
  process.exit(0);
}

const DB_PATH = path.resolve(ROOT, val('--db', 'search/dm_search.db'));
const QUIET = has('--quiet');
const say = (...a) => { if (!QUIET) console.log(...a); };

const sessionArg = val('--session', 'all');
const sessions = sessionArg === 'all' ? loadSessions() : [findSession(sessionArg)];

/* 正文分隔符用 \u0001（不可见控制字符）：搜索词里不可能出现，
   既能避免「正文和署名粘成一个词」造成的跨字段误命中，又不会被显示出来。 */
const SEP = '\u0001';

/** 一条消息的检索正文：与查看页 haystack() 口径一致，只是换成命令行拼装 */
function bodyOf(m) {
  const parts = [m.text || '', m.sender || '', m.type || ''];
  if (m.card) {
    parts.push(m.card.title || '', m.card.text || '', m.card.sub || '', m.card.author || '', m.card.url || '');
  }
  for (const l of (m.links || [])) parts.push(typeof l === 'string' ? l : (l.url || ''));
  if (m._ocr) parts.push(m._ocr);
  if (m._vlm) parts.push(m._vlm);
  return parts.filter(Boolean).join(SEP).replace(/\s+/g, ' ').trim();
}

/** 占位文案：这些 text 本身没有信息量，展示时跳过，改用卡片/图片描述 */
const PLACEHOLDER_TEXT = new Set(['分享图片', '分享视频', '分享语音', '自定义表情', '[动画表情]', '[图片]']);

/** 给人看的正文：与查看页渲染出来的「内容」一致（不含署名、不含类型） */
function dispOf(m) {
  const parts = [];
  const t = String(m.text || '').trim();
  if (t && !PLACEHOLDER_TEXT.has(t)) parts.push(t);
  if (m.card) {
    if (m.card.title) parts.push(m.card.title);
    if (m.card.text) parts.push(m.card.text);
  }
  for (const l of (m.links || [])) {
    const u = typeof l === 'string' ? l : (l.url || '');
    if (u) parts.push(u);
  }
  if (m._ocr) parts.push('图内文字：' + m._ocr);
  if (m._vlm) parts.push('图片描述：' + m._vlm);
  if (!parts.length) parts.push(t || m.type || '');
  return parts.join(' · ').replace(/\s+/g, ' ').trim();
}

function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

function ensureSchema(db) {
  /* 结构守卫：索引库是可再生的中间产物，表结构对不上就直接推倒重建，
     不做 ALTER 迁移 —— 免得留一个「一半新一半旧」的库在后面悄悄出错。
     触发场景：早期版本建的 msg 表没有 side 列（side 是后来为 --sender 加的）。 */
  const hasMsg = db.prepare(
    "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='msg'"
  ).get().c;
  if (hasMsg) {
    const cols = db.prepare('PRAGMA table_info(msg)').all().map((c) => c.name);
    const NEED = ['session', 'i', 'ts', 'day', 'sender', 'side', 'kind', 'type', 'recalled', 'disp'];
    const missing = NEED.filter((n) => !cols.includes(n));
    if (missing.length) {
      say(`[!] 索引库结构是旧版本的（msg 表缺 ${missing.join('、')}），推倒重建`);
      db.exec('DROP TABLE IF EXISTS msg_fts');
      db.exec('DROP TABLE IF EXISTS msg');
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS msg (
      rowid    INTEGER PRIMARY KEY,
      session  TEXT NOT NULL,
      i        INTEGER NOT NULL,
      ts       INTEGER,
      day      TEXT,
      sender   TEXT,
      side     TEXT,
      kind     TEXT,
      type     TEXT,
      recalled INTEGER DEFAULT 0,
      disp     TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_msg_session ON msg(session);
    CREATE INDEX IF NOT EXISTS ix_msg_ts ON msg(ts);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  const hasFts = db.prepare(
    "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='msg_fts'"
  ).get().c;
  if (!hasFts) {
    db.exec("CREATE VIRTUAL TABLE msg_fts USING fts5(body, tokenize='trigram')");
  }
}

/* 索引里的 day 列：一天 = 当天 05:00 → 次日 05:00（先减 5 小时再取日期）。
   与查看页的 DAY_CUT、msg_kind.mjs 的 localDay 必须一致，否则
   `search.mjs --since/--until` 会和页面分成两套日子。 */
const dayOf = (ts) => {
  if (ts == null) return null;
  const d = new Date(ts - DAY_CUT_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ---------------- --info ---------------- */
if (has('--info')) {
  if (!fs.existsSync(DB_PATH)) {
    console.error('[!] 还没有索引库：' + path.relative(ROOT, DB_PATH) + '（先跑一次不带参数的本脚本）');
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare('SELECT session, count(*) c, min(day) a, max(day) b FROM msg GROUP BY session').all();
  const size = fs.statSync(DB_PATH).size;
  console.log('索引库：' + path.relative(ROOT, DB_PATH) + `（${(size / 1024 / 1024).toFixed(1)} MB）`);
  for (const r of rows) {
    console.log(`  ${String(r.session).padEnd(12)} ${String(r.c).padStart(6)} 条   ${r.a} ~ ${r.b}`);
  }
  console.log(`  合计 ${db.prepare('SELECT count(*) c FROM msg').get().c.toLocaleString()} 条`);
  const mt = db.prepare("SELECT v FROM meta WHERE k='built_at'").get();
  if (mt) console.log('  建立时间：' + mt.v);
  console.log('  SQLite ' + db.prepare('SELECT sqlite_version() v').get().v + ' · FTS5 trigram');
  db.close();
  process.exit(0);
}

/* ---------------- --check ---------------- */
if (has('--check')) {
  if (!fs.existsSync(DB_PATH)) {
    console.error('[x] 索引库不存在：' + path.relative(ROOT, DB_PATH));
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let bad = 0;
  for (const S of sessions) {
    const p = path.join(ROOT, S.dir, 'messages.json');
    if (!fs.existsSync(p)) { console.log(`[!] ${S.key}：没有 messages.json，跳过`); continue; }
    const want = readJson(p, []).length;
    const got = db.prepare('SELECT count(*) c FROM msg WHERE session=?').get(S.key).c;
    const ok = want === got;
    if (!ok) bad++;
    console.log(`${ok ? '[ok]' : '[NG]'} ${S.key}：索引 ${got.toLocaleString()} / 数据 ${want.toLocaleString()} 条`);
  }
  db.close();
  console.log(bad ? `\n有 ${bad} 个会话对不上，跑一次不带参数的本脚本重建即可。` : '\n索引与数据一致。');
  process.exit(bad ? 1 : 0);
}

/* ---------------- 重建 ---------------- */
const db = openDb();
ensureSchema(db);

const maxRow = db.prepare('SELECT max(rowid) r FROM msg').get().r;
let nextRow = Number(maxRow || 0) + 1;

const delFts = db.prepare('DELETE FROM msg_fts WHERE rowid IN (SELECT rowid FROM msg WHERE session = ?)');
const delMsg = db.prepare('DELETE FROM msg WHERE session = ?');
const insMsg = db.prepare(`INSERT INTO msg (rowid,session,i,ts,day,sender,side,kind,type,recalled,disp)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const insFts = db.prepare('INSERT INTO msg_fts (rowid, body) VALUES (?,?)');

let total = 0;
db.exec('BEGIN');
try {
  for (const S of sessions) {
    const base = path.join(ROOT, S.dir);
    const msgPath = path.join(base, 'messages.json');
    if (!fs.existsSync(msgPath)) {
      console.error(`[!] ${S.key}：没有 ${S.dir}/messages.json，跳过`);
      continue;
    }
    const messages = readJson(msgPath, []);
    const ocr = readJson(path.join(base, 'ocr.json'), {});
    const vlm = readJson(path.join(base, 'vlm.json'), {});

    // 先把图内文字 / 描述挂到消息上（与查看页相同：索引键是图片文件名）
    for (const m of messages) {
      const os = [], vs = [];
      for (const im of (m.images || [])) {
        const b = im.local ? im.local.split('/').pop() : '';
        if (!b) continue;
        const o = ocr[b], v = vlm[b];
        if (o && o.t) { const s = String(o.t).replace(/\s+/g, ' ').trim(); if (s) os.push(s); }
        if (v && v.d) { const s = String(v.d).replace(/\s+/g, ' ').trim(); if (s) vs.push(s); }
      }
      if (os.length) m._ocr = os.join(' ');
      if (vs.length) m._vlm = vs.join(' ');
    }

    // 按会话清旧行：先删 FTS 再删正文（rowid 一一对应）
    delFts.run(S.key);
    delMsg.run(S.key);

    messages.forEach((m, i) => {
      const rid = nextRow++;
      const body = bodyOf(m);
      // ⚠ 参数顺序必须与上面 INSERT 的列严格一一对应：漏掉一个，后面所有列会整体
      //   错位一格（踩过：漏了 side，结果 kind 位存成 type、type 位存成 recalled，
      //   而且查询看起来「有结果」，非常难发现）。改动这里后务必跑
      //   verify_extras.mjs —— 它会逐列比对真实数据。
      insMsg.run(rid, S.key, i, m.ts ?? null, dayOf(m.ts), m.sender || null, m.from || null,
        msgKind(m, { platform: S.platform, autoReply: S.autoReply }),
        m.type || null, m.recalled ? 1 : 0, dispOf(m));
      insFts.run(rid, body);
    });

    say(`[ok] ${S.label}：${messages.length.toLocaleString()} 条已建索引`);
    total += messages.length;
  }
  const setMeta = db.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
  setMeta.run('built_at', new Date().toISOString());
  setMeta.run('sessions', sessions.map((s) => s.key).join(','));
  /* 换日时刻也写进 meta：search.mjs 读到旧值就知道这个索引是按老口径（自然日）
     切的 day 列，会提示重建 —— 否则 --since/--until 会悄悄按另一套日子过滤。 */
  setMeta.run('day_cut', String(DAY_CUT_MS));
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('[x] 建索引失败，已回滚：' + e.message);
  db.close();
  process.exit(1);
}

db.exec("INSERT INTO msg_fts(msg_fts) VALUES('optimize')");
// 把 WAL 并回主文件：不合并的话 --info 报的体积会比刚建完时大一截，看着像异常
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

const size = fs.statSync(DB_PATH).size;
say('');
say(`索引库：${path.relative(ROOT, DB_PATH)}（${(size / 1024 / 1024).toFixed(1)} MB，` +
    `${total.toLocaleString()} 条 / ${sessions.length} 个会话）`);
say('查询：node scripts/search.mjs 关键词   （或双击「搜索备份.cmd」）');
say('（纯本地 SQLite 文件，全程没有联网、没有上传）');
db.close();
