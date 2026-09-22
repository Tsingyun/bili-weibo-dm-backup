#!/usr/bin/env node
/**
 * 打出「下载一次、双击一个文件就能用」的便携一体包
 * ===============================================================
 * 产出（同一个输出目录下）：
 *   · <out>/dm-backup/              ← 文件夹（内容就是便携版）
 *   · <out>/dm-backup-portable.zip  ← 压缩包，直接发人
 *
 * 和「分享包（dm-archive）」的分工：
 *   · dm-archive  给会用 AI 助手的人：把文件夹交给 AI，由 AI 带着做。
 *   · 本包        给**完全不想碰命令行的人**：自带 Node 运行时，
 *                 解压 → 双击「启动.cmd」→ 浏览器自动打开界面。
 *
 * 为什么能这么小、这么简单：本项目**零第三方依赖**（仓库里没有 package.json），
 * 所以「包含运行环境」实际就是往包里放一个 node.exe。除它之外全是纯文本。
 *
 * 用法：
 *   node scripts/pack_portable.mjs                        # 输出到 <workspace>/dist/
 *   node scripts/pack_portable.mjs --no-runtime           # 不带 node.exe（包 <1MB，需用户自备 Node）
 *   node scripts/pack_portable.mjs --node D:\node.exe     # 指定要打进去的运行时
 *   node scripts/pack_portable.mjs --runtime-license <路径>  # 覆盖 Node 许可证（默认取 node.exe 同目录的 LICENSE）
 *   node scripts/pack_portable.mjs --out D:\分享 --no-zip
 *
 * ⚠ 打完 node.exe 就**等于在分发 Node.js**：必须把 Node 自己的 LICENSE 一起带上
 *   （MIT + 第三方许可聚合文本）。少了它，我们自己那行 MIT 写得再全也不合规 ——
 *   所以本脚本找不到运行时的 LICENSE 时**直接拒绝打包**，不靠人记得。
 *
 * ⚠ 容器名一律 ASCII（zip 名与包内根目录）：
 *   解压时 Windows 资源管理器默认按**压缩包名**建文件夹 —— 如果包名是中文，
 *   等于给每个收件人都发了一个中文路径，而这个项目一直在提醒「别放中文/空格」。
 *   所以宁可容器英文、说明中文。
 *
 * ⚠ 与 pack_share.mjs 同一套做法：原地逐文件覆写 + 只清多余文件，
 *   zip 先写 .tmp 再换名。整目录 rm -rf 会被句柄卡死并留下残包（踩过）。
 * ⚠ 隐私扫描**不另写一份黑名单**，直接复用 build_skill.mjs --check，
 *   否则两套规则迟早漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeZip } from './lib/zip.mjs';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, d = '') => {
  const i = ARGS.indexOf(f);
  return (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) ? ARGS[i + 1] : d;
};

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(val('--out', path.resolve(ROOT, '..', 'dist')));
const PKG_NAME = 'dm-backup';
const PKG_DIR = path.join(OUT, PKG_NAME);
const ZIP_PATH = path.join(OUT, PKG_NAME + '-portable.zip');
const WITH_RUNTIME = !has('--no-runtime');
const ZIP = !has('--no-zip');

/** 只管打包的维护脚本，不进成品包（与 build_skill 的 MAINTAINER_ONLY 同一口径） */
const MAINTAINER_ONLY = new Set(['build_skill.mjs', 'pack_share.mjs', 'pack_portable.mjs']);
/** 本机私有 / 编辑器垃圾 */
const isPrivate = (n) => /\.local(\.|$)/i.test(n) || n.startsWith('.');
const EXCLUDE = /(^|[\\/])(\.DS_Store|Thumbs\.db|__pycache__)([\\/]|$)/;

/* ------------------------------------------------------------------ 收文件 */

/**
 * 收进包里的东西。**白名单**，不是遍历整仓库 —— 仓库里的
 * data/ bili/ search/ exports/ snapshots/ sessions.js 全是真实私信，
 * 「顺手同步整个目录」迟早把它们带出去。
 */
function collect() {
  const out = [];
  const add = (from, to) => { if (fs.existsSync(from)) out.push({ from, to }); };
  const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

  // 1) 项目根：启动器 + 入口文档 + 查看页 + 许可证
  for (const n of ['启动.cmd', 'README.md', '使用说明.md', '使用限制.md', 'LICENSE', '查看备份.html']) {
    add(path.join(ROOT, n), n);
  }

  // 2) scripts/ 顶层脚本（与 build_skill 同口径：mjs/ps1/py/txt，去掉维护脚本）
  const S = path.join(ROOT, 'scripts');
  for (const name of fs.readdirSync(S)) {
    if (!fs.statSync(path.join(S, name)).isFile()) continue;
    if (/\.local(\.|$)/i.test(name) || name.startsWith('.')) continue;  // 私有文件绝不进包
    if (!/\.(mjs|ps1|py|txt)$/.test(name)) continue;
    if (MAINTAINER_ONLY.has(name)) continue;
    add(path.join(S, name), 'scripts/' + name);
  }
  // scripts/lib/ —— server / export / import 的共用模块。漏了它界面直接起不来。
  for (const name of fs.readdirSync(path.join(S, 'lib'))) {
    if (/\.(mjs|js)$/.test(name)) add(path.join(S, 'lib', name), 'scripts/lib/' + name);
  }
  // scripts/_skill/ —— 里面那份 sessions.template.json 是 README 明确要用户复制的；
  // 同一目录还住着 personal_tokens.local.txt（黑名单本体），必须逐名过滤。
  const TPL = path.join(S, '_skill');
  if (fs.existsSync(TPL)) {
    for (const name of fs.readdirSync(TPL)) {
      if (isPrivate(name)) continue;
      const full = path.join(TPL, name);
      if (fs.statSync(full).isFile()) add(full, 'scripts/_skill/' + name);
    }
  }
  // ⚠ scripts/_explore/ 是开发/测试脚本，不进成品包。

  // 3) WebUI 前端 —— 没有它就是一张空白页
  const W = path.join(ROOT, 'webui');
  for (const name of fs.readdirSync(W)) {
    if (/\.(html|css|js)$/.test(name)) add(path.join(W, name), 'webui/' + name);
  }

  // 4) 双击启动器：保持 命令/<分类>/ 结构，文档里的路径才成立
  const CMDROOT = path.join(ROOT, '命令');
  for (const cat of fs.readdirSync(CMDROOT)) {
    const catDir = path.join(CMDROOT, cat);
    if (!fs.statSync(catDir).isDirectory()) continue;
    for (const name of fs.readdirSync(catDir)) {
      if (name.toLowerCase().endsWith('.cmd')) add(path.join(catDir, name), `命令/${cat}/${name}`);
    }
  }

  // 5) 补充文档
  const D = path.join(ROOT, '文档');
  if (fs.existsSync(D)) {
    for (const name of fs.readdirSync(D)) {
      if (/\.(md|html)$/i.test(name)) add(path.join(D, name), '文档/' + name);
    }
  }

  return out.filter((it) => !EXCLUDE.test(it.from) && !EXCLUDE.test(rel(it.from)));
}

/* ------------------------------------------------------------------ 同步 */

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walk(full, out);
    else if (name.isFile()) out.push(full);
  }
  return out;
}

/** 自底向上删掉「空目录」（与 build_skill.mjs 同一实现，避免两套语义） */
function pruneEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return false;
  let empty = true;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { if (!pruneEmptyDirs(full)) empty = false; }
    else empty = false;
  }
  if (empty) { try { fs.rmdirSync(dir); return true; } catch { return false; } }
  return false;
}

function syncInto(items, outDir) {
  const desired = new Set(items.map((i) => i.to.replace(/\\/g, '/')));
  fs.mkdirSync(outDir, { recursive: true });
  let written = 0;
  for (const it of items) {
    const dst = path.join(outDir, it.to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(it.from, dst);
    written++;
  }
  // 只清「我们自己会生成」的多余文件；runtime/ 是本脚本的产物、不在 desired 里，
  // 所以必须显式放过（它不是陈旧文件）；sessions.json / 从这开始.txt 同理。
  const KEEP = /^runtime\//;
  const removed = [];
  for (const f of walk(outDir)) {
    const r = path.relative(outDir, f).replace(/\\/g, '/');
    if (desired.has(r) || KEEP.test(r)) continue;
    if (r === 'sessions.json' || r === '从这开始.txt') continue;
    try { fs.rmSync(f, { force: true }); removed.push(r); } catch { /* 占用就留着 */ }
  }
  pruneEmptyDirs(outDir);
  return { written, removed };
}

/* ------------------------------------------------------------------ 生成物 */

/** 空白会话清单：直接给用户建好，省掉「复制模板→改名」这一步 */
function writeBlankSessions(outDir) {
  const tpl = path.join(ROOT, 'scripts', '_skill', 'sessions.template.json');
  const m = JSON.parse(fs.readFileSync(tpl, 'utf8'));
  // 断言模板本身不含任何真实身份 —— 打包脚本不该把开发者自己的 uid 带出去
  for (const s of m.sessions || []) {
    for (const who of ['peer', 'self']) {
      const uid = String((s[who] || {}).uid || '').trim();
      if (uid) throw new Error(`模板里 ${s.key}.${who}.uid 非空，拒绝打包（先清干净）`);
    }
  }
  fs.writeFileSync(path.join(outDir, 'sessions.json'), JSON.stringify(m, null, 2) + '\n', 'utf8');
  return (m.sessions || []).length;
}

/** 收件人第一眼看的说明。UTF-8 带 BOM：任何版本的记事本都不会显示成乱码。 */
function writeStartHere(outDir) {
  const runtimePara = WITH_RUNTIME
    ? `不用装任何东西
------------------------------------------------
这个包里已经自带运行环境（runtime\\node\\node.exe），
不会往系统里装东西，也不需要 npm install、不需要管理员权限。

（这份运行时就是 Node.js 官方程序，它的许可证一并放在 runtime\\node\\LICENSE。）`
    : `这个包没有自带运行环境
------------------------------------------------
你需要先装 Node.js 22 或更高版本（https://nodejs.org/ 下 LTS 版），
装完重新打开一次再双击「启动.cmd」。`;

  const txt = `私信备份 · 便携版 —— 从这里开始
================================================

你只需要做三件事：

  1) 解压
     解压到一个「纯英文、没有空格」的文件夹，例如 D:\\dm-backup

  2) 双击
     双击文件夹里的「启动.cmd」
     （第一次可能弹「Windows 已保护你的电脑」→ 点「更多信息」→「仍要运行」）

  3) 照着界面点
     浏览器会自动打开一个本地地址（形如 http://127.0.0.1:8787/，
     真实端口看黑窗口里那行「地址」）。界面上有 7 步引导，一步一步来就行。

================================================
${runtimePara}

------------------------------------------------
那个黑色窗口别关
------------------------------------------------
双击之后会出现一个黑色窗口，那是程序本体。
用完想结束时，回到那个窗口按 Ctrl+C。
窗口一关，网页就连不上了。

------------------------------------------------
它到底做什么
------------------------------------------------
把你的「微博 / B站私信」备份到这台电脑上，做成能离线浏览的网页
（双击 查看备份.html 也能直接看）。
数据只存在本机：不连第三方服务器、不上传任何数据。

------------------------------------------------
注意
------------------------------------------------
· 只备份你自己有权查看的聊天记录。用之前请读一下「使用限制.md」。
· 会话配置 sessions.json 已经给你建好了，在界面第 3 步填对方的数字 ID 即可。
· 想了解每一项功能，看「README.md」和「使用说明.md」。

单独启动某个功能：进「命令」文件夹，按用途分了四个子文件夹，双击对应 .cmd。
`;
  fs.writeFileSync(path.join(outDir, '从这开始.txt'), '\ufeff' + txt, 'utf8');
}

/* ------------------------------------------------------------------ zip */

function writeZipSafely(build, zipPath) {
  const tmp = zipPath + '.tmp';
  const n = build(tmp);
  try {
    try { fs.rmSync(zipPath, { force: true }); } catch { /* 占用就交给下面换名 */ }
    fs.renameSync(tmp, zipPath);
    return { path: zipPath, n, fallback: false };
  } catch {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const alt = zipPath.replace(/\.zip$/i, '') + '-' + stamp + '.zip';
    fs.renameSync(tmp, alt);
    return { path: alt, n, fallback: true };
  }
}

/* ------------------------------------------------------------------ main */

function main() {
  console.log('私信备份 · 打便携一体包');
  console.log('  源项目    ' + ROOT);
  console.log('  输出目录  ' + OUT);
  console.log('  运行环境  ' + (WITH_RUNTIME ? '打包内置 node.exe' : '不含（--no-runtime）'));
  console.log('');

  // 0) 安全闸：目标目录看起来像「真的工作区」就停手，绝不误删用户的私信数据
  if (fs.existsSync(PKG_DIR) && (fs.existsSync(path.join(PKG_DIR, 'data')) || fs.existsSync(path.join(PKG_DIR, 'bili')))) {
    console.error('[×] 目标目录里已经有 data/ 或 bili/，看起来是真实工作区，拒绝覆盖：');
    console.error('    ' + PKG_DIR);
    console.error('    请换一个 --out 目录。');
    return 1;
  }

  // 1) 运行时
  //    ⚠ 分发 node.exe 就等于分发 Node.js 本身，**必须**把它的许可证一起带上：
  //      Node 是 MIT + 一批第三方许可的聚合文本（约 145 KB），
  //      MIT 要求「版权声明随副本分发」—— 不带上就是不合规，哪怕我们自己那行 MIT 写了也没用。
  let nodeExe = null;
  let nodeLicense = null;
  if (WITH_RUNTIME) {
    nodeExe = path.resolve(val('--node', process.execPath));
    if (!fs.existsSync(nodeExe)) {
      console.error('[×] 找不到要打进去的运行时：' + nodeExe);
      return 1;
    }
    // 默认取 node.exe 同目录的 LICENSE（官方发行包就是这个结构）
    nodeLicense = path.resolve(val('--runtime-license', path.join(path.dirname(nodeExe), 'LICENSE')));
    if (!fs.existsSync(nodeLicense)) {
      console.error('[×] 找不到运行时的许可证文件，拒绝打包（分发二进制不带许可证不合规）：');
      console.error('    期望位置：' + nodeLicense);
      console.error('    修法：node scripts/pack_portable.mjs --runtime-license <Node 官方包里的 LICENSE 路径>');
      console.error('    或把官方发行包里的 LICENSE 放回 node.exe 同目录再打包。');
      return 1;
    }
  }

  // 2) 原地同步
  const items = collect();
  const { written, removed } = syncInto(items, PKG_DIR);
  console.log('[1/5] 已同步代码 ' + written + ' 个文件' +
    (removed.length ? '，清理陈旧文件 ' + removed.length + ' 个' : ''));

  // 3) 生成物：空白会话清单 + 第一眼说明 + 内置运行时
  const nSess = writeBlankSessions(PKG_DIR);
  writeStartHere(PKG_DIR);
  console.log('[2/5] 已生成 sessions.json（' + nSess + ' 个空白会话）与 从这开始.txt');

  if (nodeExe) {
    const dst = path.join(PKG_DIR, 'runtime', 'node', 'node.exe');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(nodeExe, dst);
    // Node 自己的许可证必须紧挨着 node.exe 放，用户/法务一眼能找到
    fs.copyFileSync(nodeLicense, path.join(PKG_DIR, 'runtime', 'node', 'LICENSE'));
    const mb = (fs.statSync(dst).size / 1048576).toFixed(1);
    console.log('[3/5] 已内置运行时：' + dst + '（' + mb + ' MB）');
    console.log('      版本 ' + process.version + ' · 来自 ' + nodeExe);
    console.log('      已随包附上 Node 许可证 runtime/node/LICENSE（' +
      (fs.statSync(nodeLicense).size / 1024).toFixed(0) + ' KB）');
  } else {
    console.log('[3/5] 跳过运行时（--no-runtime）');
  }

  // 4) 隐私扫描：复用 build_skill 的 --check，不另写一份黑名单
  console.log('[4/5] 隐私扫描…');
  try {
    const out = execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'build_skill.mjs'), '--out', PKG_DIR, '--check'],
      { encoding: 'utf8' });
    for (const line of out.trim().split('\n')) if (line.trim()) console.log('      ' + line);
  } catch (e) {
    console.error('[×] 隐私扫描未通过，已中止（绝不打包可能含个人信息的产物）：');
    console.error((e.stdout || '') + (e.stderr || e.message));
    return 1;
  }

  // 5) 打包
  const nFiles = walk(PKG_DIR).length;
  if (!ZIP) {
    console.log('[5/5] 跳过压缩（--no-zip）');
    console.log('');
    console.log('[完成] 便携版已就绪：' + PKG_DIR + '（共 ' + nFiles + ' 个文件）');
    return 0;
  }
  console.log('[5/5] 压缩…');
  const r = writeZipSafely((tmp) => {
    const entries = walk(PKG_DIR).map((f) => ({
      name: PKG_NAME + '/' + path.relative(PKG_DIR, f).replace(/\\/g, '/'),
      data: fs.readFileSync(f),
      mtime: fs.statSync(f).mtimeMs,
    }));
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    return writeZip(entries, tmp).files;
  }, ZIP_PATH);

  const mb = (fs.statSync(r.path).size / 1048576).toFixed(1);
  console.log('');
  console.log('[完成] 便携一体包：' + r.path + '（' + mb + ' MB，' + nFiles + ' 个文件）');
  if (r.fallback) console.log('  ⚠ 目标 zip 被占用，已改用带时间戳的文件名。');
  console.log('  提示：解压后双击「启动.cmd」即可，不需要装 Node。');
  console.log('  许可：包里含 LICENSE 与 使用限制.md（MIT 要求版权声明随副本分发）。');
  return 0;
}

process.exit(main());
