#!/usr/bin/env node
/**
 * 索引快照与回滚（P0-2）
 * ===============================================================
 * 索引（messages / ocr / vlm / meta / faces）是这套备份里「最贵」的东西：
 * 消息可以重抓，但 OCR 是本地算出来的、图片描述是调免费模型攒出来的，
 * 一旦被误覆盖就只能重跑。这个脚本给它们做本地快照，出事了能一键回滚。
 *
 * **纯本地**：只往项目里的 snapshots/ 目录拷文件，不联网、不上传。
 *
 * 用法：
 *   node scripts/snapshot.mjs --make              # 给两套都打快照
 *   node scripts/snapshot.mjs --make --session bili --note "压缩图片前"
 *   node scripts/snapshot.mjs --list
 *   node scripts/snapshot.mjs --verify <id>
 *   node scripts/snapshot.mjs --restore <id>      # 回滚（会自动先存一份当前状态）
 *   node scripts/snapshot.mjs --prune --keep 20   # 每套只留最近 20 份
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, loadSessions } from './sessions.mjs';

const SNAP_ROOT = path.join(ROOT, 'snapshots');

// 每次快照都要带的索引文件（相对会话目录）
const INDEX_FILES = [
  'messages.json', 'messages.js',
  'ocr.json', 'ocr.js',
  'vlm.json', 'vlm.js',
  'meta.json', 'faces.js',
];
// 全局文件（不分会话），只在快照里顺带存一份，便于追溯当时的来源清单
const GLOBAL_FILES = ['sessions.json', 'sessions.js'];

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, d = '') => {
  const i = ARGS.indexOf(f);
  return (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) ? ARGS[i + 1] : d;
};

function log(...a) { console.log(...a); }

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function targets(sessionArg) {
  const list = loadSessions();
  if (sessionArg && sessionArg !== 'all') {
    const s = list.find(x => x.key === sessionArg);
    if (!s) {
      console.error(`[×] 不认识会话「${sessionArg}」。现有：${list.map(x => x.key).join(' / ')}`);
      process.exit(2);
    }
    return [s];
  }
  return list;
}

function snapDir(sessionKey, id) {
  return path.join(SNAP_ROOT, sessionKey, id);
}

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch { return null; }
}

function allSnapshots() {
  const out = [];
  if (!fs.existsSync(SNAP_ROOT)) return out;
  for (const sk of fs.readdirSync(SNAP_ROOT)) {
    const sd = path.join(SNAP_ROOT, sk);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const id of fs.readdirSync(sd)) {
      const m = readManifest(path.join(sd, id));
      if (m) out.push({ ...m, path: path.join(sd, id) });
    }
  }
  out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return out;
}

// ---------------------------------------------------------------- make
function make(sessionArg, note) {
  const id = stamp();
  let totalFiles = 0, totalBytes = 0;

  for (const s of targets(sessionArg)) {
    const dset = path.join(ROOT, s.dir);
    if (!fs.existsSync(dset)) {
      log(`  · ${s.key}：数据目录 ${s.dir}/ 不存在，跳过`);
      continue;
    }
    const dst = snapDir(s.key, id);
    fs.mkdirSync(dst, { recursive: true });

    const files = [];
    for (const rel of INDEX_FILES) {
      const src = path.join(dset, rel);
      if (!fs.existsSync(src)) continue;
      const to = path.join(dst, rel);
      fs.copyFileSync(src, to);
      const bytes = fs.statSync(src).size;
      files.push({ name: rel, bytes, sha256: sha256(src) });
      totalFiles++; totalBytes += bytes;
    }

    const gh = [];
    for (const rel of GLOBAL_FILES) {
      const src = path.join(ROOT, rel);
      if (!fs.existsSync(src)) continue;
      const to = path.join(dst, '__root__' + rel);
      fs.copyFileSync(src, to);
      gh.push({ name: rel, bytes: fs.statSync(src).size, sha256: sha256(src) });
    }

    // 顺手记一下条数，将来一眼能看出「这份快照里有多少东西」
    const stats = {};
    for (const [k, f] of [['messages', 'messages.json'], ['ocr', 'ocr.json'], ['vlm', 'vlm.json']]) {
      const p = path.join(dset, f);
      if (!fs.existsSync(p)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        stats[k] = Array.isArray(j) ? j.length
          : Object.keys(j).filter(x => !x.startsWith('_')).length;
      } catch { stats[k] = -1; }
    }

    const manifest = {
      id, session: s.key, dir: s.dir, created_at: new Date().toISOString(),
      note: note || '', files, globals: gh, stats,
      tool: 'snapshot.mjs v1',
    };
    fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    log(`  ✓ ${s.key} → snapshots/${s.key}/${id}　${files.length} 个索引文件 · ` +
        `messages ${stats.messages} · ocr ${stats.ocr} · vlm ${stats.vlm}`);
  }

  log(`\n快照完成：${totalFiles} 个文件，合计 ${(totalBytes / 1048576).toFixed(1)} MB`);
  log('（纯本地目录拷贝，snapshots/ 里可以直接删，不影响任何功能）');
  return 0;
}

// ---------------------------------------------------------------- list
function list() {
  const all = allSnapshots();
  if (!all.length) {
    log('还没有任何快照。运行「命令/查看与导出/索引快照.cmd」或 node scripts/snapshot.mjs --make 生成。');
    return 0;
  }
  log(`共 ${all.length} 份快照（新→旧）：`);
  for (const m of all) {
    const mb = (m.files.reduce((s, f) => s + f.bytes, 0) / 1048576).toFixed(1);
    log(`  ${m.id}  ${String(m.session).padEnd(8)} ${mb.padStart(7)} MB  ` +
        `msg ${m.stats.messages} / ocr ${m.stats.ocr} / vlm ${m.stats.vlm}` +
        (m.note ? `  「${m.note}」` : ''));
  }
  return 0;
}

// ---------------------------------------------------------------- verify
function verify(id) {
  const all = allSnapshots().filter(m => m.id === id);
  if (!all.length) { console.error(`[×] 找不到快照 ${id}`); return 2; }
  let bad = 0, n = 0;
  for (const m of all) {
    log(`快照 ${m.id}（${m.session}）：`);
    for (const f of m.files) {
      n++;
      const p = path.join(m.path, f.name);
      if (!fs.existsSync(p)) { log(`  [×] ${f.name} 丢了`); bad++; continue; }
      const h = sha256(p);
      if (h !== f.sha256) { log(`  [×] ${f.name} 内容变了（${f.sha256} → ${h}）`); bad++; }
    }
    const dset = path.join(ROOT, m.dir);
    let same = 0, diff = 0;
    for (const f of m.files) {
      const cur = path.join(dset, f.name);
      if (!fs.existsSync(cur)) { diff++; continue; }
      if (sha256(cur) === f.sha256) same++; else diff++;
    }
    log(`  快照自身完整性：${bad ? '有损坏' : '完好'}；与当前线上相比：${same} 个一致、${diff} 个不同`);
  }
  log(bad ? '\n[×] 快照文件有损坏' : `\n[✓] 校验了 ${n} 个文件，全部与记录一致`);
  return bad ? 1 : 0;
}

// ---------------------------------------------------------------- restore
function restore(id, sessionArg) {
  const all = allSnapshots().filter(m => m.id === id);
  if (!all.length) { console.error(`[×] 找不到快照 ${id}`); return 2; }

  // 先给「当前状态」也存一份，回滚错了还能再回来
  log('回滚前先把当前状态存一份（防止回滚本身是个错误决定）…');
  make(sessionArg === 'all' ? 'all' : all[0].session, `自动：回滚到 ${id} 之前`);

  for (const m of all) {
    const dst = path.join(ROOT, m.dir);
    fs.mkdirSync(dst, { recursive: true });
    let n = 0;
    for (const f of m.files) {
      const src = path.join(m.path, f.name);
      if (!fs.existsSync(src)) continue;
      const to = path.join(dst, f.name);
      // 先写临时文件再 replace，避免中途失败留下半个索引
      const tmp = to + '.tmp';
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, to);
      n++;
    }
    // sessions.json / sessions.js 属于项目根，也一并还原（保持当时的一致状态）
    for (const g of (m.globals || [])) {
      const src = path.join(m.path, '__root__' + g.name);
      if (!fs.existsSync(src)) continue;
      const to = path.join(ROOT, g.name);
      const tmp = to + '.tmp';
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, to);
    }
    log(`  ✓ ${m.session}：还原 ${n} 个文件到 ${m.dir}/`);
  }
  log('\n回滚完成。刷新「查看备份.html」即可看到恢复后的数据。');
  return 0;
}

// ---------------------------------------------------------------- prune
function prune(keep) {
  const all = allSnapshots();
  const byKey = {};
  for (const m of all) (byKey[m.session] = byKey[m.session] || []).push(m);
  let removed = 0;
  for (const k of Object.keys(byKey)) {
    byKey[k].sort((a, b) => String(b.id).localeCompare(String(a.id)));
    for (const m of byKey[k].slice(keep)) {
      fs.rmSync(m.path, { recursive: true, force: true });
      removed++;
    }
  }
  log(`已清理 ${removed} 份旧快照（每套保留最近 ${keep} 份）`);
  return 0;
}

// ---------------------------------------------------------------- main
function main() {
  log('私信备份 · 索引快照');
  log('  目录  snapshots/（纯本地，不联网）');

  const sessionArg = val('--session', 'all');

  if (has('--list')) return list();
  if (has('--verify')) return verify(ARGS[ARGS.indexOf('--verify') + 1] || '');
  if (has('--restore')) return restore(ARGS[ARGS.indexOf('--restore') + 1] || '', sessionArg);
  if (has('--prune')) return prune(Number(val('--keep', '20')) || 20);

  if (has('--make')) {
    const note = val('--note', '');
    log(`  会话  ${sessionArg}${note ? `　备注「${note}」` : ''}\n`);
    return make(sessionArg, note);
  }

  log('');
  log('用法：');
  log('  node scripts/snapshot.mjs --make [--session weibo|bili|all] [--note 备注]');
  log('  node scripts/snapshot.mjs --list');
  log('  node scripts/snapshot.mjs --verify <id>');
  log('  node scripts/snapshot.mjs --restore <id>');
  log('  node scripts/snapshot.mjs --prune [--keep 20]');
  return 1;
}

process.exit(main());
