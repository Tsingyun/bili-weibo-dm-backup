#!/usr/bin/env node
/**
 * 一键体检（P0-3）
 * ===============================================================
 * 把「看图看着不对劲」的排查变成一条命令：索引与磁盘对不对得上、
 * 消息 js 与 json 有没有跑偏、有没有指向空文件的键、图片有没有丢。
 *
 * 只读为主；加 --fix 才会动手，而且只做**确定性**的修复：
 *   1) 用 json 重新生成 js 包装；
 *   2) 清掉索引（ocr/vlm）里指向不存在图片的「孤儿键」——
 *      多是图片压缩 webp→jpg 转码后旧扩展名的键没迁走，留着只会让体检永远报错。
 * 图片文件本身一律不删 —— 那是 compress_images.py / --prune 的活。
 *
 * 用法：
 *   node scripts/doctor.mjs                    # 两套都体检
 *   node scripts/doctor.mjs --session bili
 *   node scripts/doctor.mjs --json             # 机器可读（给自动化用）
 *   node scripts/doctor.mjs --fix --dry-run    # 先看会改什么，不动手
 *   node scripts/doctor.mjs --fix              # 修：重生成 js 包装 + 清孤儿索引键
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, loadSessions } from './sessions.mjs';
import { jsAssign } from './lib/jsassign.mjs';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, d = '') => {
  const i = ARGS.indexOf(f);
  return (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) ? ARGS[i + 1] : d;
};

const AS_JSON = has('--json');
const FIX = has('--fix');
const DRY = has('--dry-run');
const sessionArg = val('--session', 'all');

const INDEX_JS = ['messages.js', 'ocr.js', 'vlm.js', 'faces.js'];

function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
/** 备份文件名里的时间戳（到分钟即可，同一分钟内连跑两次也不覆盖） */
function stamp() { return new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 15); }
/** 原子替换：先写同目录的 .tmp，再改名。中途被打断也不会留下半截 json */
function writeAtomic(p, text) {
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, p);
}

// 索引 .js 的包装格式（与 image_ocr.py / image_vlm.py / update.mjs 保持一致）
function writeOcrJs(p, globalName, obj) {
  fs.writeFileSync(p, jsAssign(globalName, JSON.stringify(obj)), 'utf8');
}
function writeDataJs(p, globalName, meta, messages) {
  fs.writeFileSync(p, jsAssign(globalName, JSON.stringify({ meta, messages })), 'utf8');
}

/** 试着把一个相对路径解析成磁盘上真实存在的文件（容错几种写法） */
function resolveAsset(sessionDir, value) {
  if (!value) return null;
  const cands = [
    path.join(ROOT, value),
    path.join(sessionDir, value),
    path.join(sessionDir, 'images', path.basename(value)),
    path.join(sessionDir, 'faces', path.basename(value)),
  ];
  for (const c of cands) if (exists(c)) return c;
  return null;
}

function checkSession(s) {
  const out = {
    key: s.key, label: s.label, dir: s.dir,
    errors: [], warns: [], fixes: [], stats: {},
  };
  const E = (m) => out.errors.push(m);
  const W = (m) => out.warns.push(m);
  const dset = path.join(ROOT, s.dir);

  if (!exists(dset)) {
    W(`${s.dir}/ 目录还不存在（这个会话还没备份过？）`);
    return out;
  }

  // ---------- 1) 索引文件存在性 ----------
  const missing = ['messages.json', 'ocr.json', 'vlm.json', 'meta.json']
    .filter(f => !exists(path.join(dset, f)));
  if (missing.length) W(`缺少索引文件：${missing.join(' / ')}`);
  for (const f of INDEX_JS) {
    if (!exists(path.join(dset, f))) W(`缺少 ${f}（查看页会读不到对应内容）`);
  }

  // ---------- 2) messages ----------
  let messages = null;
  const mj = path.join(dset, 'messages.json');
  if (exists(mj)) {
    try {
      messages = readJson(mj);
      if (!Array.isArray(messages)) {
        E('messages.json 不是数组'); messages = null;
      } else {
        out.stats.messages = messages.length;
      }
    } catch (e) { E('messages.json 解析失败：' + e.message); }
  }

  const imgDir = path.join(dset, 'images');
  const onDisk = exists(imgDir)
    ? new Set(fs.readdirSync(imgDir).filter(f => fs.statSync(path.join(imgDir, f)).isFile()))
    : new Set();

  if (messages) {
    // 重复 id
    const seen = new Set(), dup = [];
    for (const m of messages) {
      if (m.id == null) continue;
      if (seen.has(m.id)) dup.push(m.id); else seen.add(m.id);
    }
    if (dup.length) E(`有 ${dup.length} 个重复的消息 id，例如 ${dup.slice(0, 3).join(', ')}`);

    // 时间戳
    const noTs = messages.filter(m => !m.ts && !m.time).length;
    if (noTs) W(`${noTs} 条消息没有时间字段`);

    // 时间是否递增
    let back = 0;
    for (let i = 1; i < messages.length; i++) {
      const a = messages[i - 1].ts || 0, b = messages[i].ts || 0;
      if (b && a && b < a) back++;
    }
    if (back) W(`时间戳有 ${back} 处回退（排序可能不对）`);

    // 图片引用
    let nRef = 0; const miss = [];
    for (const m of messages) {
      for (const im of (m.images || [])) {
        if (!im.local) continue;
        nRef++;
        if (!onDisk.has(path.basename(im.local))) miss.push(im.local);
      }
    }
    out.stats.imageRefs = nRef;
    out.stats.imagesOnDisk = onDisk.size;
    if (miss.length) E(`${miss.length} 条图片引用在 images/ 里找不到，例如 ${miss.slice(0, 3).join(', ')}`);

    // 孤儿图片
    const ref = new Set();
    for (const m of messages) for (const im of (m.images || [])) {
      if (im.local) ref.add(path.basename(im.local));
    }
    const orphan = [...onDisk].filter(n =>
      !ref.has(n) && !/^(avatar_|pic_|face_|emoji_)/.test(n) &&
      /\.(jpe?g|png|webp|gif|bmp)$/i.test(n));
    if (orphan.length) W(`${orphan.length} 个图片文件没有被任何消息引用（孤儿），例如 ${orphan.slice(0, 3).join(', ')}`);
  }

  // ---------- 3) ocr / vlm ----------
  for (const [kind, fname, gkey] of [['ocr', 'ocr.json', 'ocr'], ['vlm', 'vlm.json', 'vlm']]) {
    const jp = path.join(dset, fname);
    if (!exists(jp)) continue;
    let obj = null;
    try { obj = readJson(jp); } catch (e) { E(`${fname} 解析失败：${e.message}`); continue; }
    const keys = Object.keys(obj).filter(k => !k.startsWith('_'));
    out.stats[kind] = keys.length;

    const meta = obj._meta || {};
    if (typeof meta.count === 'number' && meta.count !== keys.length) {
      W(`${fname} 的 _meta.count=${meta.count} 与实际键数 ${keys.length} 不一致`);
    }

    const jsPath = path.join(dset, fname.replace('.json', '.js'));

    /* 索引里指向不存在图片的键：最常见来源是**图片压缩时 webp→jpg 转码**，
     * 新扩展名的键写进去了、旧扩展名的那个没被迁走（同一张图留了两把键，一把是死键）。
     * 它没有任何用处（按这个键找不到图），却会让体检永远报「错误 1 项」，
     * 让人以为备份坏了。加 --fix 就清掉它 —— 先备份原件，再原子写回，最后同步重新生成 js 包装。 */
    const dead = keys.filter(k => !onDisk.has(k));
    if (dead.length) {
      const msg = `${fname} 有 ${dead.length} 个键指向不存在的图片，例如 ${dead.slice(0, 3).join(', ')}`;
      E(msg);
      if (FIX) out.fixes.push({
        kind: 'prune', jp, jsPath, gkey, dead, errorText: msg,
        what: `清掉 ${dead.length} 个孤儿键（${dead.slice(0, 3).join(', ')}${dead.length > 3 ? ' …' : ''}）`,
      });
    }

    // json ↔ js
    if (exists(jsPath)) {
      const t = fs.readFileSync(jsPath, 'utf8');
      const jsKeys = new Set(
        (t.match(/"([^"\\]+\.(?:jpg|jpeg|png|webp|gif|bmp))":/g) || [])
          .map(x => x.slice(1, -2)));
      const onlyJson = keys.filter(k => !jsKeys.has(k));
      const onlyJs = [...jsKeys].filter(k => !keys.includes(k));
      if (onlyJson.length) {
        // 记下 errorText：修好之后要按它把这条 error 从报告里划掉，
        // 否则 --fix 刚修完还显示「错误 1 项」，用户以为没修好。
        const msg = `${fname} 有 ${onlyJson.length} 个键在 ${path.basename(jsPath)} 里缺失（查看页读的是 js）`;
        E(msg);
        if (FIX) out.fixes.push({ kind, jp, jsPath, gkey, errorText: msg });
      }
      if (onlyJs.length) {
        W(`${path.basename(jsPath)} 比 ${fname} 多出 ${onlyJs.length} 个键（多为历史遗留）`);
        if (FIX) out.fixes.push({ kind, jp, jsPath, gkey });
      }
    } else {
      W(`${fname.replace('.json', '.js')} 不存在，查看页读不到这份索引`);
      if (FIX) out.fixes.push({ kind, jp, jsPath, gkey });
    }
  }

  // ---------- 4) messages.js ↔ messages.json ----------
  const mjs = path.join(dset, 'messages.js');
  if (exists(mjs) && messages) {
    const t = fs.readFileSync(mjs, 'utf8');
    const tCount = (t.match(/"local":"/g) || []).length;
    if (tCount !== (out.stats.imageRefs || 0)) {
      const msg = `messages.js 里的图片引用 ${tCount} 处，与 messages.json 的 ${out.stats.imageRefs} 处不一致`;
      E(msg);
      if (FIX) out.fixes.push({ kind: 'data', jsPath: mjs, gkey: s.globals.data, errorText: msg });
    }
    try {
      const head = t.slice(0, 200);
      if (!head.includes('window.' + s.globals.data)) {
        E(`messages.js 里没找到 window.${s.globals.data}（页面读不到数据）`);
      }
    } catch {}
  }

  // ---------- 5) meta 头像 ----------
  const mp = path.join(dset, 'meta.json');
  if (exists(mp)) {
    try {
      const meta = readJson(mp);
      out.stats.peer = meta.peer_name || meta.peer_uid || '';
      for (const k of ['peer_avatar_local', 'self_avatar_local']) {
        const v = meta[k];
        if (!v) continue;
        if (!resolveAsset(dset, v)) E(`meta.json 的 ${k}（${v}）在磁盘上找不到`);
      }
    } catch (e) { E('meta.json 解析失败：' + e.message); }
  }

  // ---------- 6) faces.js 引用的文件 ----------
  const fp = path.join(dset, 'faces.js');
  if (exists(fp)) {
    const t = fs.readFileSync(fp, 'utf8');
    const paths = (t.match(/"[^"]*faces\/[^"]+\.(?:png|jpg|jpeg|gif|webp)"/g) || [])
      .map(x => x.slice(1, -1));
    const bad = paths.filter(p => !resolveAsset(dset, p));
    out.stats.faces = paths.length;
    if (bad.length) E(`faces.js 引用了 ${bad.length} 个不存在的表情图，例如 ${bad.slice(0, 2).join(', ')}`);
  }

  // ---------- 7) sessions.js 是否最新 ----------
  if (s.key === (loadSessions()[0] || {}).key) {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build_sessions.mjs'), '--check'],
        { cwd: ROOT, stdio: 'pipe' });
    } catch {
      W('sessions.js 与 sessions.json 不一致（跑一次「命令/配置与定时/生成会话清单.cmd」）');
    }
  }

  return out;
}

// ---------------------------------------------------------------- 快照一览
function snapshotInfo() {
  const root = path.join(ROOT, 'snapshots');
  if (!exists(root)) return null;
  const items = [];
  for (const sk of fs.readdirSync(root)) {
    const sd = path.join(root, sk);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const id of fs.readdirSync(sd)) items.push({ session: sk, id });
  }
  if (!items.length) return null;
  items.sort((a, b) => b.id.localeCompare(a.id));
  return { count: items.length, latest: items[0] };
}

// ---------------------------------------------------------------- main
function main() {
  let sessions;
  try { sessions = loadSessions(); } catch (e) {
    console.error('[×] sessions.json 有问题：' + e.message);
    return 2;
  }
  if (sessionArg !== 'all') {
    sessions = sessions.filter(s => s.key === sessionArg);
    if (!sessions.length) { console.error(`[×] 不认识会话「${sessionArg}」`); return 2; }
  }

  const reports = sessions.map(checkSession);

  let nErr = 0, nWarn = 0, nFix = 0;
  for (const r of reports) { nErr += r.errors.length; nWarn += r.warns.length; nFix += r.fixes.length; }

  // 执行修复
  const applied = [];
  if (FIX && nFix) {
    for (const r of reports) {
      for (const fx of r.fixes) {
        const label = `${r.key}：${path.basename(fx.jsPath)}` + (fx.what ? '　' + fx.what : '');
        if (DRY) { applied.push(label + '（--dry-run，未实际写入）'); continue; }
        try {
          if (fx.kind === 'prune') {
            // 清孤儿键：先备份 → 删键 → 修 _meta.count → 原子写回 → 同步 js 包装
            const obj = readJson(fx.jp);
            const bak = fx.jp + '.bak-' + stamp();
            fs.copyFileSync(fx.jp, bak);
            for (const k of fx.dead) delete obj[k];
            if (obj._meta && typeof obj._meta.count === 'number') {
              obj._meta.count = Object.keys(obj).filter((k) => !k.startsWith('_')).length;
            }
            writeAtomic(fx.jp, JSON.stringify(obj));
            writeOcrJs(fx.jsPath, fx.gkey, obj);
            fx.ok = true;
            applied.push(label + '（原件备份为 ' + path.basename(bak) + '）');
            continue;
          }
          if (fx.kind === 'data') {
            const dset = path.join(ROOT, r.dir);
            writeDataJs(fx.jsPath, fx.gkey, readJson(path.join(dset, 'meta.json')),
                        readJson(path.join(dset, 'messages.json')));
          } else {
            writeOcrJs(fx.jsPath, fx.gkey, readJson(fx.jp));
          }
          fx.ok = true;
          applied.push(label + '　已重新生成');
        } catch (e) {
          applied.push(label + '　失败：' + e.message);
        }
      }
    }
    /* 修好的项就从报告里划掉 —— 否则体检刚修完还报「错误 1 项」，
     * 用户会以为根本没修好（自动更新脚本也会一直判成 NG）。 */
    for (const r of reports) {
      const fixed = new Set(r.fixes.filter((f) => f.ok && f.errorText).map((f) => f.errorText));
      if (fixed.size) r.errors = r.errors.filter((e) => !fixed.has(e));
    }
    nErr = reports.reduce((a, r) => a + r.errors.length, 0);
    nWarn = reports.reduce((a, r) => a + r.warns.length, 0);
  }

  const snap = snapshotInfo();

  if (AS_JSON) {
    console.log(JSON.stringify({
      generated_at: new Date().toISOString(),
      sessions: reports,
      summary: { errors: nErr, warns: nWarn, fixable: nFix },
      snapshot: snap, applied,
    }, null, 2));
    return nErr ? 1 : 0;
  }

  console.log('私信备份 · 一键体检');
  console.log('  项目  ' + ROOT);
  console.log('');

  for (const r of reports) {
    const s = r.stats;
    console.log('─'.repeat(62));
    console.log(`【${r.label}】${r.dir}/`);
    console.log(`  消息 ${s.messages ?? '-'} 条 · 图片引用 ${s.imageRefs ?? '-'} / 磁盘 ${s.imagesOnDisk ?? '-'} 个` +
                ` · OCR ${s.ocr ?? '-'} · 图片描述 ${s.vlm ?? '-'} · 表情 ${s.faces ?? '-'}`);
    if (r.errors.length) {
      console.log(`  ❌ 错误 ${r.errors.length} 项：`);
      for (const e of r.errors) console.log('      · ' + e);
    }
    if (r.warns.length) {
      console.log(`  ⚠ 提醒 ${r.warns.length} 项：`);
      for (const w of r.warns) console.log('      · ' + w);
    }
    if (!r.errors.length && !r.warns.length) console.log('  ✅ 没发现问题');
  }

  const nApplied = applied.filter((a) => !/dry-run|失败/.test(a)).length;
  console.log('─'.repeat(62));
  console.log(`合计：错误 ${nErr} · 提醒 ${nWarn} · 可自动修复 ${nFix}` +
    (nApplied ? `（本次已修 ${nApplied} 项）` : ''));
  if (applied.length) {
    console.log('');
    console.log(DRY ? '以下问题用 --fix 会被修复（本次是 --dry-run，未写入）：' : '已执行的修复：');
    for (const a of applied) console.log('  · ' + a);
  } else if (nFix) {
    console.log('加 --fix 可以自动修掉上面标了「可用 json 重新生成」的问题（建议先 --fix --dry-run 看一眼）。');
  }
  if (snap) {
    console.log(`索引快照：${snap.count} 份，最近一份 ${snap.latest.id}（${snap.latest.session}）`);
  } else {
    console.log('索引快照：还没有（建议先跑一次「命令/查看与导出/索引快照.cmd」再动索引）');
  }
  console.log('');
  console.log(nErr ? '❌ 有错误需要处理（详细见上）'
    : (nWarn ? '✅ 没有错误，提醒项可自行判断' : '✅ 全部正常'));
  return nErr ? 1 : 0;
}

process.exit(main());
