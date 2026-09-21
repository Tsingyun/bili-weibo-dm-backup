/**
 * 加载他人分享的备份（WebUI 的「加载私信内容」）
 * ===============================================================
 * 输入可以是：
 *   · 一个 zip（本程序导出的 bundle，或别人自己压的、里面含 messages.json/js 的包）
 *   · 一个文件夹（比如别人把 data/ 整个发给你）
 *   · 一个单独的 messages.json / messages.js
 *
 * 处理完做三件事：
 *   1. 解到 `imported/<批次名>/…`，**只读**，永远不会被抓取流程碰到；
 *   2. 给每个数据目录补齐 messages.js / faces.js / ocr.js / vlm.js 四个包装文件
 *      （查看页是靠 `<script src>` 读数据的，只有 json 是打不开的）；
 *   3. 登记进 sessions.json 并重新生成 sessions.js —— 于是「查看备份」的
 *      顶部切换栏里就会多出这些导入的会话，和本机自己的备份一样能翻。
 *
 * ⚠ 导入的会话一律标 `imported: true` / `readonly: true`：
 *   WebUI 的「抓取」会对它们直接拒绝，避免拿本机登录态去抓别人分享的数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, MANIFEST_PATH, readManifest, defaultGlobals } from '../sessions.mjs';
import { ensureDir, rel, dirStat, humanSize, writeJson, safeSegment } from './paths.mjs';
import { readZipFile } from './zip.mjs';

const FOUR = ['messages', 'faces', 'ocr', 'vlm'];

function slugify(s, fallback = 'backup') {
  const t = String(s || '').replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return t || fallback;
}

function uniqueBatch(name) {
  const man = readManifest();
  const used = new Set((man.sessions || []).map((s) => s.importBatch).filter(Boolean));
  let n = name, i = 2;
  while (used.has(n) || fs.existsSync(path.join(ROOT, 'imported', n))) { n = `${name}-${i++}`; }
  return n;
}

function guessPlatform(messages, hint) {
  if (hint === 'weibo' || hint === 'bili') return hint;
  const first = messages.find((m) => m && typeof m === 'object') || {};
  // B站的消息一定有 seqno（微博没有）。旧的写法里 `||` 和 `&&` 混在一起，
  // 后半段 `'msg_source' in first && 'media_type' in first && first.seqno`
  // 因为运算优先级成了 `'seqno' in first || (… && first.seqno)`，纯属死代码。
  if ('seqno' in first) return 'bili';
  return 'weibo';
}

/** 从 entries（{name,data} 或 {name,srcPath}）里找出「数据目录」 */
function detectDirs(entries) {
  // 1) 本程序导出的 bundle：manifest.json 里写得清清楚楚
  const mani = entries.find((e) => e.name === 'manifest.json');
  if (mani) {
    try {
      const j = JSON.parse(mani.data ? mani.data.toString('utf8') : fs.readFileSync(mani.srcPath, 'utf8'));
      if (j && j.format === 'dm-archive-backup' && Array.isArray(j.sessions)) {
        return {
          kind: 'manifest',
          meta: j,
          dirs: j.sessions.map((s) => ({
            dir: String(s.dir || 'data').replace(/\\/g, '/').replace(/^\.\//, ''),
            key: s.key, label: s.label, platform: s.platform, records: s.records,
          })),
        };
      }
    } catch { /* 坏 manifest 就退回目录嗅探 */ }
  }
  // 2) 嗅探 `<某目录>/messages.json|js`
  const names = entries.map((e) => e.name);
  const dirs = new Map();
  for (const n of names) {
    const mm = n.match(/^(.*?)\/?messages\.(json|js)$/);
    if (!mm) continue;
    const d = mm[1] || '.';
    if (!dirs.has(d)) dirs.set(d, { dir: d === '.' ? '' : d });
  }
  if (dirs.size) {
    return {
      kind: 'sniff',
      dirs: [...dirs.values()].map((d) => ({
        dir: d.dir || '', key: (d.dir.split('/').pop() || 'backup'),
        label: d.dir ? d.dir.split('/').pop() : '备份', platform: null,
      })),
    };
  }
  // 3) 兜底：整包当一份数据（找第一个 messages.* 在哪儿）
  const any = names.find((n) => /(^|\/)messages\.(json|js)$/.test(n));
  if (any) {
    const d = any.replace(/\/?messages\.(json|js)$/, '');
    return { kind: 'sniff', dirs: [{ dir: d, key: 'backup', label: '备份', platform: null }] };
  }
  return { kind: 'none', dirs: [] };
}

/** 把 zip 里的条目收敛到「去掉公共顶层目录」后的相对路径 */
function stripCommonRoot(entries) {
  const files = entries.filter((e) => !e.name.endsWith('/'));
  if (!files.length) return entries;
  const firsts = new Set(files.map((e) => e.name.split('/')[0]));
  const noRootFile = files.some((e) => !e.name.includes('/'));
  if (firsts.size === 1 && !noRootFile) {
    const root = [...firsts][0];
    return files.map((e) => ({ ...e, name: e.name.slice(root.length + 1) }));
  }
  return files;
}

function writeEnsure(dirAbs, baseName, content) {
  const p = path.join(dirAbs, baseName + '.js');
  if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf8');
}

/** 补齐四个 .js 包装（查看页只认 <script src>） */
function ensureWrappers(dirAbs, key, entries) {
  const globals = defaultGlobals(key);
  const pairs = [['messages', globals.data], ['faces', globals.faces], ['ocr', globals.ocr], ['vlm', globals.vlm]];
  const made = [];
  // ⚠ 生成的文件是用 `<script src>` 加载的，所以正文里只要出现 `</script>`
  //   （别人发的消息里完全可能有），HTML 解析器就会当场把这个 script 块切断 ——
  //   轻则这份备份打不开，重则后面的内容被当成 HTML 执行。
  //   一律把 `<` 转成 \u003c：JS 字符串里等价，但不会再被当成标签边界。
  const guard = (s) => String(s).replace(/</g, '\\u003c');
  for (const [base, gname] of pairs) {
    const jsPath = path.join(dirAbs, base + '.js');
    if (fs.existsSync(jsPath)) continue;
    const jsonPath = path.join(dirAbs, base + '.json');
    let body;
    if (fs.existsSync(jsonPath)) {
      const raw = fs.readFileSync(jsonPath, 'utf8').trim() || (base === 'messages' ? '[]' : '{}');
      body = `window.${gname} = ${guard(raw)};\n`;
    } else {
      body = `window.${gname} = ${base === 'messages' ? '[]' : '{}'};\n`;
    }
    fs.writeFileSync(jsPath, body, 'utf8');
    made.push(base + '.js');
  }
  return { made, globals };
}

function readEntries(srcPath) {
  const st = fs.statSync(srcPath);
  if (st.isFile()) {
    if (!/\.zip$/i.test(srcPath)) {
      // 单个 messages.json / js
      const base = path.basename(srcPath);
      return { kind: 'single', entries: [{ name: base, data: fs.readFileSync(srcPath) }] };
    }
    return { kind: 'zip', entries: readZipFile(srcPath) };
  }
  const entries = [];
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const nm = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full, nm);
      else if (e.isFile()) entries.push({ name: nm, srcPath: full });
    }
  };
  walk(srcPath, '');
  return { kind: 'dir', entries };
}

/**
 * 主入口。
 * @param {{srcPath:string, name?:string, label?:string}} opts
 */
export function importBackup(opts = {}) {
  const srcPath = path.resolve(String(opts.srcPath || ''));
  if (!srcPath || !fs.existsSync(srcPath)) throw new Error('找不到这个路径：' + opts.srcPath);

  const { kind, entries: raw } = readEntries(srcPath);
  let entries = raw.map((e) => ({ ...e }));

  // 单文件：包成 <name>/messages.json
  if (kind === 'single') {
    entries = [{ name: 'messages/' + entries[0].name, ...entries[0] }];
  }
  entries = kind === 'zip' ? stripCommonRoot(entries) : entries;
  if (!entries.length) throw new Error('这个压缩包/文件夹里没有任何文件');

  const detected = detectDirs(entries);
  if (!detected.dirs.length) {
    throw new Error('没找到 messages.json / messages.js —— 这可能不是一份私信备份包');
  }

  const batch = uniqueBatch(safeSegment(slugify(opts.name || path.basename(srcPath)), 'backup'));
  const batchDir = ensureDir(path.join(ROOT, 'imported', batch));

  // 解包（保留目录结构）
  let wrote = 0;
  for (const e of entries) {
    const dest = path.join(batchDir, e.name.replace(/\\/g, '/'));
    const destResolved = path.resolve(dest);
    if (!destResolved.startsWith(path.resolve(batchDir) + path.sep)) continue;  // 防 zip 里的 ../
    ensureDir(path.dirname(destResolved));
    if (e.data != null) fs.writeFileSync(destResolved, e.data);
    else fs.copyFileSync(e.srcPath, destResolved);
    wrote++;
  }

  // 登记会话
  const man = readManifest();
  man.sessions = Array.isArray(man.sessions) ? man.sessions : [];
  const added = [];

  for (const d of detected.dirs) {
    const sub = d.dir;                                  // '' 或 'data' 之类
    const dirAbs = sub ? path.join(batchDir, sub) : batchDir;
    if (!fs.existsSync(dirAbs)) continue;

    // 该目录下到底有没有消息数据
    const hasMsg = FOUR.some((k) => fs.existsSync(path.join(dirAbs, k + '.json')) ||
                                    fs.existsSync(path.join(dirAbs, k + '.js')));
    if (!hasMsg) continue;

    let key = String(d.key || 'backup').toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!/^[a-z]/.test(key)) key = 'imp_' + key;
    key = (batch.toLowerCase().replace(/[^a-z0-9_]/g, '_') + '_' + key).slice(0, 40);
    // 保证 key 唯一
    let k2 = key, i = 2;
    while (man.sessions.some((s) => s.key === k2)) k2 = key + '_' + (i++);
    key = k2;

    const { made, globals: _g } = ensureWrappers(dirAbs, key, entries);

    // 取条数 / 平台（优先读 messages.json，其次 messages.js 里的全局变量）
    let messages = [];
    const mj = path.join(dirAbs, 'messages.json');
    if (fs.existsSync(mj)) {
      try { messages = JSON.parse(fs.readFileSync(mj, 'utf8')); } catch { messages = []; }
    } else {
      const mjs = path.join(dirAbs, 'messages.js');
      if (fs.existsSync(mjs)) {
        const t = fs.readFileSync(mjs, 'utf8');
        const s = t.indexOf('[');
        const e2 = t.lastIndexOf(']');
        if (s >= 0 && e2 > s) { try { messages = JSON.parse(t.slice(s, e2 + 1)); } catch { messages = []; } }
      }
    }
    if (!Array.isArray(messages)) messages = [];

    const platform = guessPlatform(messages, d.platform);
    const metaPath = path.join(dirAbs, 'meta.json');
    let peerName = '', selfName = '';
    if (fs.existsSync(metaPath)) {
      try {
        const mm = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        peerName = mm.peer_name || ''; selfName = mm.self_name || '';
      } catch {}
    }

    // 时间范围
    let first = null, last = null;
    for (const m of messages) {
      if (!m || m.ts == null) continue;
      if (first == null || m.ts < first) first = m.ts;
      if (last == null || m.ts > last) last = m.ts;
    }
    const fmt = (ts) => (ts == null ? '-' : new Date(ts).toLocaleDateString('zh-CN'));

    const entry = {
      key,
      label: opts.label || d.label || batch,
      dir: rel(dirAbs),
      platform,
      peer: { uid: '', name: peerName },
      self: { uid: '', name: selfName },
      imported: true,
      readonly: true,
      importBatch: batch,
      importedFrom: path.basename(srcPath),
      importedAt: new Date().toISOString(),
    };
    // 替换或追加
    const at = man.sessions.findIndex((s) => s.key === key);
    if (at >= 0) man.sessions[at] = entry; else man.sessions.push(entry);

    added.push({
      key, label: entry.label, dir: entry.dir, platform, records: messages.length,
      range: [fmt(first), fmt(last)], peerName: peerName || '对方', selfName: selfName || '我',
      generated: made, imagesDir: fs.existsSync(path.join(dirAbs, 'images')),
    });
  }

  if (!added.length) throw new Error('解开了，但里面没有可用的私信数据（缺 messages.json / messages.js）');

  writeJson(MANIFEST_PATH, man);

  // 重新生成 sessions.js，让查看页认得出这些会话
  let sessionsJs = 'ok';
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build_sessions.mjs')],
      { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    sessionsJs = '失败：' + (e.stdout || e.message);
  }

  const st = dirStat(batchDir);
  return {
    batch, dir: rel(batchDir), files: wrote, bytes: st.bytes, human: humanSize(st.bytes),
    sessions: added, sessionsJs,
  };
}

/** 已导入的批次（读原始 sessions.json，因为归一化后的对象会丢掉这些字段） */
export function listImported() {
  const man = readManifest();
  const batches = new Map();
  for (const s of man.sessions || []) {
    if (!s || !s.imported) continue;
    const b = s.importBatch || '(未分组)';
    if (!batches.has(b)) {
      batches.set(b, {
        batch: b, importedAt: s.importedAt || '', from: s.importedFrom || '',
        dir: 'imported/' + b, sessions: [], bytes: 0, files: 0,
      });
    }
    const g = batches.get(b);
    g.sessions.push({ key: s.key, label: s.label, dir: s.dir, platform: s.platform });
  }
  for (const g of batches.values()) {
    const st = dirStat(path.join(ROOT, g.dir));
    g.bytes = st.bytes; g.files = st.files; g.human = humanSize(st.bytes);
  }
  return [...batches.values()].sort((a, b) => (a.batch < b.batch ? 1 : -1));
}

/**
 * 删除一个导入批次：清 sessions.json 条目 + 删目录 + 重新生成 sessions.js
 *
 * ⚠⚠ `batch` 会被拼成 `imported/<batch>` 然后 **rmSync(recursive)**。
 *    不校验的话，一个 `..` 就让 `imported/..` 指向工作区根 ——
 *    一次请求删掉整个项目（代码 + 全部备份数据）。调用方传来的任何批次名
 *    都必须先过 safeSegment。
 */
export function deleteImported(batchRaw) {
  const batch = safeSegment(String(batchRaw || ''), '');
  if (!batch || batch === 'x') throw new Error('批次名不合法：' + String(batchRaw || '').slice(0, 40));
  const man = readManifest();
  const before = (man.sessions || []).length;
  man.sessions = (man.sessions || []).filter((s) => !(s.imported && s.importBatch === batch));
  const removed = before - man.sessions.length;
  if (!removed) throw new Error('没有这个导入批次：' + batch);
  writeJson(MANIFEST_PATH, man);

  const dir = path.join(ROOT, 'imported', batch);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build_sessions.mjs')],
      { cwd: ROOT, encoding: 'utf8' });
  } catch {}
  return { removed, batch };
}
