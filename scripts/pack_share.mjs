#!/usr/bin/env node
/**
 * 打出「可以直接发给别人」的分享包
 * ===============================================================
 * 产出两样东西（同一个目录下）：
 *   · <out>/dm-archive/       ← 文件夹，内容就是可分享的 Skill
 *   · <out>/dm-archive.zip    ← 压缩包，直接发人即可
 *
 * 流程：
 *   1) 先按 build_skill 的规则刷新 Skill 快照（保证包里永远是最新代码）
 *   2) 原地同步成 <out>/dm-archive/
 *   3) 补一份「先读我.md」（收件人第一眼看的，简短上手说明）
 *   4) 隐私扫描 —— 直接复用 build_skill.mjs --check（同一份黑名单，避免两套规则漂移）
 *   5) 打包成 zip
 *
 * ⚠ 为什么全程「原地同步」而不是「删掉再复制」：
 *   分享目录经常正被别的程序打开（预览、杀软、资源管理器、宿主的产物索引都会持有句柄），
 *   Windows 上 `rm -rf` 这种整目录删除会被卡住；一旦进程在中途被杀，
 *   就会留下一个「只剩一半文件」的残包 —— 而且看不出坏了（踩过）。
 *   改成逐文件覆写 + 只清理多余文件后，既幂等，也不会被占用卡死。
 *
 * ⚠ zip 由本脚本**自己写**（zlib.deflateRawSync + 手写中央目录），
 *   不依赖 PowerShell Compress-Archive / 7z / tar —— 那些在受限环境里
 *   可能调不动，而且失败时往往拿不到有用的报错。
 *   写出来的 zip 是标准格式（UTF-8 文件名标志位 0x0800），Windows 资源管理器
 *   和 macOS 归档工具都能正常解开中文文件名。
 *
 * 用法：
 *   node scripts/pack_share.mjs                       # 输出到 <workspace>/dist/
 *   node scripts/pack_share.mjs --out D:\分享          # 自定义输出目录
 *   node scripts/pack_share.mjs --no-zip              # 只出文件夹，不压缩
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, d = '') => {
  const i = ARGS.indexOf(f);
  return (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) ? ARGS[i + 1] : d;
};

const ROOT = path.resolve(import.meta.dirname, '..');          // 项目根
const SKILL_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'skills', 'dm-archive');
const DEFAULT_OUT = path.resolve(ROOT, '..', 'dist');          // <workspace>/dist/
const OUT = path.resolve(val('--out', DEFAULT_OUT));
const PKG_NAME = 'dm-archive';
const PKG_DIR = path.join(OUT, PKG_NAME);
const ZIP_PATH = path.join(OUT, PKG_NAME + '.zip');

/** 不值得进包的东西 */
const EXCLUDE = /(^|[\\/])(\.DS_Store|Thumbs\.db|__pycache__)([\\/]|$)/;

/** 收件人第一眼看到的那份说明（每次打包都是最新生成，不手改） */
const README = `# 私信备份工具（dm-archive）

把**你自己的**微博 / B站私信备份到本机，做成能离线浏览的网页。
数据只存在你电脑上，不上传任何服务器；这个包里也没有任何人的账号信息。

---

## 如果你在用 AI 助手（Codex / WorkBuddy / Claude 等）

**第一次用、或者不确定怎么把包交给 AI → 先看 \`新手使用提示词.md\`。**
那份文档是给完全没接触过命令行的人写的：怎么上传、对话框里到底打什么字、
哪些说法会造成歧义、卡住了怎么办，全部照抄即可。

已经知道怎么用的话，把**整个 \`${PKG_NAME}\` 文件夹**（或这个压缩包）交给 AI，然后说：

> 我给你一个私信备份工具（dm-archive）。请先读里面的「先读我.md」和「SKILL.md」，
> 弄清楚怎么用，再一步步带我完成备份。
> 要备份的平台是 [微博 / B站 / 两个都要]，对方是 [主页链接或 ID]。
> 每一步做完先告诉我结果，等我确认再继续；需要我动手的地方请说清点哪个文件。

具体可复用的说法见 \`开场白.md\`（里面有几套不同场景的开场白）。

---

## 如果你想自己动手（不需要 AI）

### 0. 先确认电脑上有 Node.js 22 或更新版本
在命令行里跑 \`node -v\` 看一眼，没有就去 <https://nodejs.org> 装一个（选 LTS）。

### 1. 铺开工作区
在命令行里进到本文件夹，然后：

\`\`\`bash
node scripts/init.mjs D:\\我的私信备份
\`\`\`

### 2. 填「备份谁的私信」
用记事本打开刚生成的 \`sessions.json\`，给每个会话填上对方：

\`\`\`json
"peer": { "uid": "1234567890", "name": "对方昵称" }
\`\`\`

- **微博**：打开对方主页，地址栏 \`weibo.com/u/1234567890\` → 填 \`1234567890\`
- **B站** ：打开对方空间，地址栏 \`space.bilibili.com/1234567\` → 填 \`1234567\`

保存后双击 **\`生成会话清单.cmd\`**。

### 3. 双击更新
- 微博：双击 **\`更新备份.cmd\`**
- B站 ：双击 **\`更新B站备份.cmd\`**（首次要在弹出的浏览器窗口里扫码登录一次）

跑完双击 **\`查看备份.html\`** 就能看了。

---

## 文件夹里都有什么

| 路径 | 作用 |
|---|---|
| \`SKILL.md\` | 技能定义（给 AI 看的） |
| \`新手使用提示词.md\` | **纯新手看这个**：怎么把包交给 AI、对话框里打什么字 |
| \`开场白.md\` | 可直接复制的开场白提示词 |
| \`先读我.md\` | 就是本文件 |
| \`references/使用说明.md\` | 完整使用手册（功能、口径、常见问题） |
| \`references/隐私与数据.md\` | 数据都存在哪、什么会联网、分享红线 |
| \`scripts/init.mjs\` | 一键铺工作区（装好之后跑这一个） |
| \`assets/\` \`cmd/\` \`scripts/\` | 查看页、双击启动器、全部逻辑 |

---

## 放心用

- 包里**没有任何人的 uid / 昵称 / 本机路径** —— 每次打包都会自动做一次隐私扫描，
  扫到任何一条就打包失败。
- 抓取时只读取**你自己账号有权查看**的会话，不碰别人的数据。
- 唯一的联网例外是**可选**的「图片内容描述」功能：会把「没有文字的照片」
  发给免费模型。不配 Key 就永远不会触发。
`;

// ------------------------------------------------------------------ 工具
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (EXCLUDE.test(full)) continue;
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * 原地同步目录：逐文件覆写，再删掉目标里多出来的文件。
 * 不做整目录删除 —— 见文件头的说明。
 */
function syncTree(srcDir, dstDir) {
  const want = new Set();
  let copied = 0;
  for (const f of walk(srcDir)) {
    const rel = path.relative(srcDir, f);
    want.add(rel);
    const dst = path.join(dstDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f, dst);
    copied++;
  }
  let removed = 0;
  if (fs.existsSync(dstDir)) {
    for (const f of walk(dstDir)) {
      if (want.has(path.relative(dstDir, f))) continue;
      try { fs.rmSync(f, { force: true }); removed++; } catch { /* 占用就留着 */ }
    }
  }
  return { copied, removed };
}

// ------------------------------------------------------------------ zip
let CRC_TABLE = null;
function crc32(buf) {
  // Node 22+ 自带 zlib.crc32；没有就自己算（两边结果一致）
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

function dosDateTime(mtime) {
  const d = new Date(mtime);
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** 把一个目录打成标准 zip（deflate + UTF-8 文件名） */
function zipDir(srcDir, zipPath, rootName) {
  const files = walk(srcDir).sort();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const rel = path.relative(srcDir, f).replace(/\\/g, '/');
    const entry = rootName + '/' + rel;
    const nameBuf = Buffer.from(entry, 'utf8');
    const raw = fs.readFileSync(f);
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const { time, date } = dosDateTime(fs.statSync(f).mtime);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0x0800, 6);      // flag: UTF-8 文件名
    lh.writeUInt16LE(8, 8);           // deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // disk
    ch.writeUInt16LE(0, 36);          // internal attrs
    ch.writeUInt32LE(0, 38);          // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([...locals, cd, eocd]));
  return files.length;
}

/**
 * 先写到 .tmp 再换名 —— 避免「写到一半被杀留下一半大的 zip」。
 * 目标文件常被别的程序打开（预览 / 杀软），换名失败就退到一个带时间戳的名字，
 * 绝不硬碰。
 */
function writeZipSafely(build, zipPath) {
  const tmp = zipPath + '.tmp';
  const n = build(tmp);
  try {
    try { fs.rmSync(zipPath, { force: true }); } catch { /* 占用就交给下面换名 */ }
    fs.renameSync(tmp, zipPath);
    return { path: zipPath, n, tmp: false };
  } catch {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const alt = zipPath.replace(/\.zip$/i, '') + '-' + stamp + '.zip';
    fs.renameSync(tmp, alt);
    return { path: alt, n, tmp: true };
  }
}

// ------------------------------------------------------------------ main
function main() {
  console.log('私信备份 · 打分享包');
  console.log('  Skill 源  ' + SKILL_DIR);
  console.log('  输出目录  ' + OUT);
  console.log('');

  // 1) 刷新 Skill 快照（顺带跑一次隐私断言）
  console.log('[1/5] 刷新 Skill 快照…');
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build_skill.mjs')],
      { encoding: 'utf8' });
    for (const line of out.trim().split('\n')) if (line.trim()) console.log('      ' + line);
  } catch (e) {
    console.error('[×] 刷新 Skill 失败，已中止（不会打包可能有问题的内容）：');
    console.error((e.stdout || '') + (e.stderr || e.message));
    return 1;
  }

  // 2) 原地同步成分享文件夹
  console.log('[2/5] 同步分享文件夹…');
  fs.mkdirSync(PKG_DIR, { recursive: true });
  const { copied, removed } = syncTree(SKILL_DIR, PKG_DIR);
  console.log('      ' + PKG_DIR);
  console.log('      复制 ' + copied + ' 个文件' + (removed ? '，清理多余 ' + removed + ' 个' : ''));

  // 3) 补一份「先读我.md」
  console.log('[3/5] 写「先读我.md」…');
  fs.writeFileSync(path.join(PKG_DIR, '先读我.md'), README, 'utf8');
  console.log('      已写入（' + walk(PKG_DIR).length + ' 个文件）');

  // 4) 隐私扫描（复用 build_skill 的同一份黑名单）
  console.log('[4/5] 隐私扫描…');
  try {
    const out = execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'build_skill.mjs'), '--check', '--out', PKG_DIR],
      { encoding: 'utf8' });
    for (const line of out.trim().split('\n')) if (line.trim()) console.log('      ' + line);
  } catch (e) {
    console.error('[×] 隐私扫描不通过，已中止（分享文件夹留给你排查，未生成 zip）：');
    console.error((e.stdout || '') + (e.stderr || e.message));
    return 1;
  }

  // 5) 压缩
  let finalZip = null;
  if (has('--no-zip')) {
    console.log('[5/5] 按要求跳过压缩。');
  } else {
    console.log('[5/5] 压缩…');
    const { path: zipPath, n, tmp } = writeZipSafely((p) => zipDir(PKG_DIR, p, PKG_NAME), ZIP_PATH);
    const kb = (fs.statSync(zipPath).size / 1024).toFixed(0);
    console.log('      ' + zipPath + '（' + n + ' 个条目，' + kb + ' KB）');
    if (tmp) console.log('      ⚠ 原 zip 被占用，已另存为新名字（旧的那个可以删掉）');
    finalZip = zipPath;
  }

  console.log('');
  console.log('[完成] 可以直接把' + (has('--no-zip') ? '文件夹' : ' zip') + '发给别人了：');
  console.log('  文件夹  ' + PKG_DIR);
  if (finalZip) console.log('  压缩包  ' + finalZip);
  return 0;
}

process.exit(main());
