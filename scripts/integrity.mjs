#!/usr/bin/env node
/**
 * 数据完整性清单（P0-1）
 * ===============================================================
 * 备份工具最怕的不是「抓不到」，而是**静默坏掉**：
 * 文件还在、名字也对，但内容已经变了（磁盘位翻转、网盘同步半截、
 * 误操作覆盖、图片压缩转码残留）。体检原本只查「文件在不在 / 索引对不对」，
 * 这类损坏一条都发现不了。
 *
 * 于是给每份数据留一张「指纹清单」：
 *   <dir>/integrity.json = { _meta, files: { "images/xxx.jpg": {sha256, size} … } }
 * 之后 doctor --verify 拿它跟磁盘比对，能明确说出
 *   · 少了哪个文件（missing）
 *   · 哪个文件内容变了（changed）
 *   · 哪些是清单之后新增的（extra，抓取后属正常，提示重跑 --build）
 *
 * 用法：
 *   node scripts/integrity.mjs --build                 # 生成 / 覆盖清单
 *   node scripts/integrity.mjs --build --session bili
 *   node scripts/integrity.mjs --verify                # 校验（默认抽样 200 个文件）
 *   node scripts/integrity.mjs --verify --full         # 全量校验（慢，但一个不漏）
 *   node scripts/integrity.mjs --verify --json         # 机器可读
 *
 * 设计取舍：
 *   · **默认抽样**：图片动辄几万张，每次体检全量哈希会慢到没人愿意跑。
 *     默认抽「最近改过的 100 个 + 等距抽 100 个」，几分钟的活变几秒；
 *     真要较真（比如刚从网盘拷回来）用 --full。
 *   · **只算不动**：本脚本从不删改任何数据文件，写清单也是原子替换。
 *   · json 索引文件（messages.json 等）**永远全量校验** —— 它们最要命，也最小。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, loadSessions } from './sessions.mjs';

export const INTEGRITY_FILE = 'integrity.json';

/** 顶层必须全量校验的索引文件（小，但坏了整份备份就废了） */
const INDEX_FILES = ['messages.json', 'meta.json', 'ocr.json', 'vlm.json', 'faces.json'];
/** 需要进清单的媒体目录 */
const MEDIA_DIRS = ['images', 'faces'];
const DEFAULT_SAMPLE = 200;

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

/** 目录 → 相对路径列表（posix 分隔符；只收文件，目录安全上限防环） */
function walk(dir, base, out = [], depth = 0) {
  if (depth > 8 || !exists(dir)) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.isDirectory()) {
      walk(path.join(dir, e.name), base, out, depth + 1);
    } else if (e.isFile()) {
      out.push(path.relative(base, path.join(dir, e.name)).replace(/\\/g, '/'));
    }
  }
  return out;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 要进清单的全部文件：顶层索引 + 两个媒体目录 */
export function collectFiles(dirAbs) {
  const list = [];
  for (const f of INDEX_FILES) if (exists(path.join(dirAbs, f))) list.push(f);
  for (const d of MEDIA_DIRS) {
    for (const rel of walk(path.join(dirAbs, d), dirAbs)) list.push(rel);
  }
  return list.sort();
}

/**
 * 抽样：最近改过的 100 个 + 等距抽 100 个。
 * 为什么要带「最近改过」：真出问题时（同步半截 / 刚压缩完）坏的往往是新文件。
 * 为什么要等距：不然老数据十年也轮不到校验一次。
 */
function pickSample(all, dirAbs, size) {
  const withMtime = [];
  for (const rel of all) {
    let m = 0;
    try { m = fs.statSync(path.join(dirAbs, rel)).mtimeMs || 0; } catch {}
    withMtime.push([rel, m]);
  }
  const picked = new Set();
  const recent = withMtime.slice().sort((a, b) => b[1] - a[1]).slice(0, Math.floor(size / 2));
  for (const [rel] of recent) picked.add(rel);
  const rest = withMtime.filter(([rel]) => !picked.has(rel));
  const step = rest.length ? Math.max(1, Math.floor(rest.length / (size - picked.size))) : 1;
  for (let i = 0; picked.size < size && i < rest.length; i += step) picked.add(rest[i][0]);
  return [...picked];
}

/** 原子替换：中途被打断也不会留下半截清单 */
function writeAtomic(p, text) {
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, p);
}

/**
 * 生成（或重建）一份清单。
 * @returns {{file:string, files:number, bytes:number, messages:number, imageRefs:number}}
 */
export function buildSession(s, opts = {}) {
  const dirAbs = path.join(ROOT, s.dir);
  if (!exists(dirAbs)) return { skipped: true, reason: `${s.dir}/ 还不存在` };
  const all = collectFiles(dirAbs);
  const files = {};
  let bytes = 0;
  for (const rel of all) {
    let st;
    try { st = fs.statSync(path.join(dirAbs, rel)); } catch { continue; }
    let hash = '';
    try { hash = sha256File(path.join(dirAbs, rel)); } catch (e) {
      // 读不动的文件（被占用 / 权限）也记下来，size 先填，hash 留空 → 校验时按"跳过"处理
      hash = '';
    }
    files[rel] = { sha256: hash, size: st.size };
    bytes += st.size;
  }

  let messages = 0, imageRefs = 0;
  try {
    const msgs = JSON.parse(fs.readFileSync(path.join(dirAbs, 'messages.json'), 'utf8'));
    if (Array.isArray(msgs)) {
      messages = msgs.length;
      for (const m of msgs) imageRefs += (m.images || []).filter((i) => i.local).length;
    }
  } catch { /* messages.json 不存在或坏了 —— 那是体检的活，这里不重复报错 */ }

  const payload = {
    _meta: {
      schema: 1,
      generated_at: new Date().toISOString(),
      session: s.key,
      dir: s.dir,
      files: all.length,
      bytes,
      messages,
      imageRefs,
      note: '本清单只用于校验数据有没有被改动；hash 算的是文件内容，与隐私无关。',
    },
    files,
  };
  const out = path.join(dirAbs, INTEGRITY_FILE);
  writeAtomic(out, JSON.stringify(payload, null, 2) + '\n');
  return { file: s.dir + '/' + INTEGRITY_FILE, files: all.length, bytes, messages, imageRefs };
}

/**
 * 校验一份清单与当前磁盘是否一致。
 * @returns {{key,label,dir,mode,checked,missing:string[],changed:string[],extra:string[],stale:boolean,msg?:string}}
 */
export function verifySession(s, opts = {}) {
  const dirAbs = path.join(ROOT, s.dir);
  const res = {
    key: s.key, label: s.label, dir: s.dir, mode: opts.full ? 'full' : 'sample',
    checked: 0, missing: [], changed: [], extra: [], stale: false,
  };
  if (!exists(dirAbs)) { res.stale = true; res.msg = `${s.dir}/ 还不存在`; return res; }
  const manPath = path.join(dirAbs, INTEGRITY_FILE);
  if (!exists(manPath)) {
    res.stale = true;
    res.msg = `还没有完整性清单（跑一次 node scripts/integrity.mjs --build）`;
    return res;
  }
  let man;
  try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); }
  catch { res.stale = true; res.msg = `${INTEGRITY_FILE} 解析失败`; return res; }
  const known = man.files || {};

  // 1) 索引文件永远全量
  const mustCheck = new Set(INDEX_FILES.filter((f) => known[f]));
  // 2) 其余按抽样（或全量）
  const media = Object.keys(known).filter((f) => !mustCheck.has(f));
  const chosen = opts.full ? media : pickSample(media, dirAbs, DEFAULT_SAMPLE);
  for (const f of mustCheck) chosen.push(f);

  for (const rel of chosen) {
    const want = known[rel];
    const abs = path.join(dirAbs, rel);
    if (!exists(abs)) { res.missing.push(rel); continue; }
    let st;
    try { st = fs.statSync(abs); } catch { res.missing.push(rel); continue; }
    if (want.size && st.size !== want.size) { res.changed.push(rel); continue; }
    if (want.sha256) {
      let got = '';
      try { got = sha256File(abs); } catch { got = ''; }
      if (!got) continue;               // 读不动 → 跳过，不误报
      if (got !== want.sha256) res.changed.push(rel);
    }
    res.checked++;
  }

  // 3) 清单之后新增的文件（抓取 / 压缩都会带来）—— 只提醒，不算坏
  const now = new Set(collectFiles(dirAbs));
  for (const rel of now) if (!known[rel]) res.extra.push(rel);
  if (res.extra.length > 20) res.extra = res.extra.slice(0, 20).concat(['…']);

  return res;
}

// ---------------------------------------------------------------- CLI
function main() {
  const ARGS = process.argv.slice(2);
  const has = (f) => ARGS.includes(f);
  const val = (f, d = '') => {
    const i = ARGS.indexOf(f);
    return (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) ? ARGS[i + 1] : d;
  };
  const DO_BUILD = has('--build');
  const FULL = has('--full');
  const AS_JSON = has('--json');
  const sessionArg = val('--session', 'all');

  let sessions;
  try { sessions = loadSessions(); } catch (e) {
    console.error('[×] sessions.json 有问题：' + e.message);
    return 2;
  }
  if (sessionArg !== 'all') {
    sessions = sessions.filter((s) => s.key === sessionArg);
    if (!sessions.length) { console.error(`[×] 不认识会话「${sessionArg}」`); return 2; }
  }

  if (DO_BUILD) {
    const out = [];
    for (const s of sessions) {
      const r = buildSession(s, { full: FULL });
      out.push({ key: s.key, ...r });
      if (!AS_JSON) {
        if (r.skipped) console.log(`【${s.label}】跳过：${r.reason}`);
        else console.log(`【${s.label}】清单已生成 ${r.file} · ${r.files} 个文件 · ${mb(r.bytes)}` +
                         ` · 消息 ${r.messages} 条 · 图片引用 ${r.imageRefs}`);
      }
    }
    if (AS_JSON) console.log(JSON.stringify({ built: out }, null, 2));
    return 0;
  }

  const reports = sessions.map((s) => verifySession(s, { full: FULL }));
  let bad = 0;
  for (const r of reports) bad += r.missing.length + r.changed.length;

  if (AS_JSON) {
    console.log(JSON.stringify({ verified: reports, summary: { problems: bad } }, null, 2));
    return bad ? 1 : 0;
  }

  console.log('私信备份 · 数据完整性校验（' + (FULL ? '全量' : '抽样 ' + DEFAULT_SAMPLE) + '）');
  console.log('  项目  ' + ROOT);
  console.log('');
  for (const r of reports) {
    console.log('─'.repeat(62));
    console.log(`【${r.label}】${r.dir}/`);
    if (r.stale) { console.log('  ⚠ ' + r.msg); continue; }
    console.log(`  校验了 ${r.checked} 个文件`);
    if (r.missing.length) {
      console.log(`  ❌ 少了 ${r.missing.length} 个文件（清单里有、磁盘上没了）：`);
      for (const f of r.missing.slice(0, 5)) console.log('      · ' + f);
    }
    if (r.changed.length) {
      console.log(`  ❌ ${r.changed.length} 个文件内容与清单不一致（可能被改坏）：`);
      for (const f of r.changed.slice(0, 5)) console.log('      · ' + f);
    }
    if (r.extra.length) {
      console.log(`  ⚠ ${r.extra.length} 个文件不在清单里（抓取 / 压缩后新增属正常，建议重跑 --build）`);
    }
    if (!r.missing.length && !r.changed.length && !r.extra.length) console.log('  ✅ 与清单一致');
  }
  console.log('─'.repeat(62));
  console.log(bad ? '❌ 发现不一致：先别动数据，确认是备份坏了还是清单旧了（旧就重跑 --build）'
                  : '✅ 没发现损坏');
  return bad ? 1 : 0;
}

/* ⚠ Windows 上不能写 `file://${process.argv[1]}`：
 *   process.argv[1] 是 `C:\...\integrity.mjs`，拼出来是 `file://C:\...`，
 *   而 import.meta.url 是 `file:///C:/...` —— 永远不等，脚本被 import 时不会跑、
 *   直接执行时反而静默什么都不做。统一用 pathToFileURL 比。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
