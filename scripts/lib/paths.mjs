/**
 * 工作区路径工具（WebUI 层共用）
 * ===============================================================
 * 为什么单独一个模块：
 *   WebUI 会接收**用户传来的路径字符串**（导入他人备份包时的文件路径、
 *   下载时的相对路径）。所有拼路径的地方都必须走这里的安全拼接，
 *   否则一个 `../../` 就能读到工作区之外的文件。
 *
 * ROOT 不是自己算的 —— 一律复用 scripts/sessions.mjs 的那一份，
 * 免得两处对「项目根在哪」各说各话（历史踩过：测试用 DM_SESSIONS_JSON 指到别处）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, MANIFEST_PATH } from '../sessions.mjs';

export { ROOT, MANIFEST_PATH };

/** WebUI 自己用到的目录（都在工作区内，可随时删） */
export const DIRS = {
  imports: 'imports',      // 拖进来 / 待导入的压缩包
  imported: 'imported',    // 已导入的他人备份（只读）
  exports: 'exports',      // 导出产物
  webui: 'webui',          // 前端静态文件
  state: '.webui',         // WebUI 自己的状态（上次操作时间等）
};

export function abs(...parts) {
  return path.join(ROOT, ...parts);
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/**
 * 把用户给的相对路径安全地拼到 ROOT 下。
 * 绝对路径与任何形式的 `..` 都直接拒绝 —— 不做"尽力而为"的规范化。
 */
export function safeJoin(rel) {
  const s = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s) throw new Error('空路径');
  if (/^[A-Za-z]:/.test(s) || path.isAbsolute(s)) throw new Error('不接受绝对路径：' + rel);
  const parts = s.split('/').filter(Boolean);
  if (parts.some((p) => p === '..')) throw new Error('路径里不允许出现 ..：' + rel);
  const full = path.resolve(ROOT, ...parts);
  const rootResolved = path.resolve(ROOT);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new Error('路径越界：' + rel);
  }
  return full;
}

/**
 * 把用户给的一个「名字」（导入批次名 / 导出文件名前缀）压成**单个安全路径段**。
 *
 * ⚠ 这个函数存在的理由很硬：这些名字会被拼成 `imported/<batch>` 或 `exports/<name>_…`，
 *   而 `deleteImported()` 会 `rmSync('imported/' + batch, {recursive:true})`。
 *   只要 batch 里能塞进 `..`，`imported/..` 就指向**整个工作区** —— 一次请求删光。
 *   所以：分隔符一律拍平、开头的点一律去掉、长度截断。宁可名字丑一点。
 */
export function safeSegment(name, fallback = 'x') {
  const s = String(name == null ? '' : name)
    .replace(/[\\/]+/g, '_')                  // 任何 / 或 \ 都拍平成 _
    .replace(/^\.+/, '')                        // 开头的点（含 ..）
    .replace(/[<>:"|?*\u0000-\u001f]+/g, '_') // Windows 文件名非法字符
    .trim()
    .slice(0, 60);
  return s || fallback;
}

export function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

export function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** 读 JSON，坏了就抛（带文件名，方便定位） */
export function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(rel(p) + ' 不是合法 JSON：' + e.message);
  }
}

/** 原子写：先写 .tmp 再 rename —— 中途出错不会留下半截文件 */
export function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

export function writeText(p, text) {
  ensureDir(path.dirname(p));
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, p);
}

/** 目录大小 / 文件数（统计用；不跟随符号链接）
 *  ⚠ 有深度上限：导入的压缩包可能带出很深的目录树，递归没有上限会爆栈。 */
export function dirStat(dir, maxDepth = 64) {
  let bytes = 0, files = 0;
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.isFile()) { files++; try { bytes += fs.statSync(f).size; } catch {} }
    }
  };
  walk(dir, 0);
  return { bytes, files };
}

export function humanSize(n) {
  if (!Number.isFinite(n)) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + u[i];
}
