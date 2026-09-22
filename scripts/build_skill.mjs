#!/usr/bin/env node
/**
 * 把本项目打包成「可分享的 Skill 快照」
 * ===============================================================
 * 设计原则：**项目 = 源，Skill = 快照**。
 *   · 代码只从项目单向同步过来，避免「项目改了、Skill 里的副本还是旧的」这种漂移。
 *   · 文档（SKILL.md / 开场白.md / references/*）由人手写，本脚本**不动它们**，
 *     这样反复构建不会把手写内容覆盖掉。
 *
 * ⚠ 为什么是「原地逐文件同步」而不是「建临时目录再整体改名」：
 *   技能目录会被宿主索引/占用，Windows 上整目录 rename / rmdir 会被卡住，
 *   一旦中途被杀就会留下一个「缺了几个子目录」的半成品 Skill（踩过）。
 *   逐文件覆写没有这个问题，而且天然幂等。
 *
 * 每次构建都会做一次**隐私断言**：扫描产物里是否残留任何涉及本人的标识
 * （昵称 / uid / mid / 本机绝对路径）。清单来源见 personalTokens()：
 *   · 主来源   = sessions.json —— 换了账号，清单自动跟着变；
 *   · 补充词表 = scripts/_skill/personal_tokens.local.txt（**不入库**，一行一个，
 *               用 # 注释）—— 昵称变体 / 历史昵称这类"只写在人脑里"的东西放这里；
 *   · 本机路径 = 由 os.homedir() 与项目父目录在运行时推导，**不把用户名写进代码**。
 * 命中任何一条 → 退出码 1。
 *
 * 用法：
 *   node scripts/build_skill.mjs                 # 输出到 ~/.workbuddy/skills/dm-archive
 *   node scripts/build_skill.mjs --out <dir>     # 自定义输出目录
 *   node scripts/build_skill.mjs --check         # 只做隐私扫描，不写盘
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT, loadSessions } from './sessions.mjs';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, d = '') => {
  const i = ARGS.indexOf(f);
  return (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) ? ARGS[i + 1] : d;
};

const DEFAULT_OUT = path.join(os.homedir(), '.workbuddy', 'skills', 'dm-archive');

/** 由本脚本托管（会被同步 / 清理陈旧文件）的子目录 */
/* ⚠ 'cmd' 是 2026-09-22 之前的历史目录名（启动器平铺在里面）。留在清单里是为了让
   已安装的旧快照能把陈旧文件清掉；新结构统一走 '命令/<分类>/'。 */
const MANAGED_DIRS = ['scripts', '命令', 'assets', 'webui', 'cmd'];

/**
 * 只在维护者这边跑的脚本，不进 Skill：
 *   build_skill.mjs —— 构建器自己（引用了项目根，进包没意义）
 *   pack_share.mjs  —— 打分享包用的（同上）
 */
const MAINTAINER_ONLY = new Set(['build_skill.mjs', 'pack_share.mjs', 'pack_portable.mjs']);

/**
 * 本机私有文件（一律不进 Skill / 分享包）：
 *   · `*.local.txt`      —— 补充词表、个人 token 清单
 *   · `*.local.*`        —— 同类私有配置
 *   · `.pw-home` 等点开头 —— 依赖解析用的本机运行时候选
 * 新增「只有本机才有」的文件时，沿用 `xxx.local.txt` 命名即可自动被排除。
 */
function isPrivateName(name) {
  return /\.local(\.|$)/i.test(name) || name.startsWith('.');
}

/** 要同步的代码文件（相对项目根）。_explore / 测试 / 个人配置一律不进 Skill。 */
function codeFiles() {
  const out = [];
  const S = path.join(ROOT, 'scripts');
  for (const name of fs.readdirSync(S)) {
    const full = path.join(S, name);
    if (fs.statSync(full).isDirectory()) continue;        // 跳过 _explore/ 与 _skill/（下面单独处理）
    if (isPrivateName(name)) continue;                    // 顶层也可能出现 xxx.local.txt，别带出去
    if (/\.(mjs|ps1|py|txt)$/.test(name)) {               // txt：requirements-ocr.txt 这类随脚本分发的清单
      if (MAINTAINER_ONLY.has(name)) continue;
      out.push({ from: full, to: 'scripts/' + name });
    }
  }
  // scripts/lib/ 是 server / export / import 这一层的共用模块。
  // ⚠ 上面的循环只扫**顶层**文件，很容易漏掉这个子目录 ——
  //   漏了的话分享包里 server.mjs 会 import 不到 ./lib/*，界面直接起不来，
  //   而「文件数少了几个」从外面根本看不出来。新增子目录记得同步这里。
  const LIB = path.join(S, 'lib');
  if (fs.existsSync(LIB)) {
    for (const name of fs.readdirSync(LIB)) {
      const full = path.join(LIB, name);
      if (!fs.statSync(full).isFile()) continue;
      if (/\.(mjs|js)$/.test(name)) out.push({ from: full, to: 'scripts/lib/' + name });
    }
  }
  // WebUI 前端（引导式操作界面）。没有它，server.mjs 起来也只有一张空白页。
  const WEBUI = path.join(ROOT, 'webui');
  if (fs.existsSync(WEBUI)) {
    for (const name of fs.readdirSync(WEBUI)) {
      const full = path.join(WEBUI, name);
      if (!fs.statSync(full).isFile()) continue;
      if (/\.(html|css|js)$/.test(name)) out.push({ from: full, to: 'webui/' + name });
    }
  }
  // 双击启动器：仓库里按用途分在 命令/<分类>/ 下，包内**保持同一结构** ——
  // init.mjs 会原样铺到目标项目，于是文档里的「命令/<分类>/xxx.cmd」在两边都成立。
  // ⚠ 别再改回平铺：仓库结构与安装结构一旦不一致，文档就只能写两套，迟早对不上。
  const CMDROOT = path.join(ROOT, '命令');
  if (fs.existsSync(CMDROOT)) {
    for (const cat of fs.readdirSync(CMDROOT)) {
      const catDir = path.join(CMDROOT, cat);
      if (!fs.statSync(catDir).isDirectory()) continue;
      for (const name of fs.readdirSync(catDir)) {
        if (!name.toLowerCase().endsWith('.cmd')) continue;
        out.push({ from: path.join(catDir, name), to: `命令/${cat}/${name}` });
      }
    }
  }
  // 脚手架用的模板：放 assets/，由 scripts/init.mjs 铺到目标工作区
  // ⚠ _skill/ 里同时住着 personal_tokens.local.txt（本人昵称/uid 词表，**绝不能进包**）——
  //   必须逐名过滤，否则「无脑同步整个目录」会把黑名单本体复制分享出去。
  const TPL = path.join(S, '_skill');
  if (fs.existsSync(TPL)) {
    for (const name of fs.readdirSync(TPL)) {
      if (isPrivateName(name)) continue;
      out.push({ from: path.join(TPL, name), to: 'assets/' + name });
    }
  }
  // 许可与使用限制：MIT 明确要求「版权声明必须随副本一起分发」，
  // 而这个 Skill / 分享包本身**就是一份副本** —— 只放在仓库根是不合规的，必须随包发出去。
  // （README 不进包：包里已经有 SKILL.md / 先读我.md / 新手使用提示词.md 三份入口文档了。）
  for (const name of ['LICENSE', '使用限制.md']) {
    const f = path.join(ROOT, name);
    if (fs.existsSync(f)) out.push({ from: f, to: name });
  }
  out.push({ from: path.join(ROOT, '查看备份.html'), to: 'assets/查看备份.html' });
  return out;
}

/**
 * 隐私黑名单：sessions.json 派生 + 本机私有补充清单 + 运行时推导的本机路径。
 * 派生部分保证换账号后依然有效；补充部分覆盖昵称变体与历史昵称。
 */
function personalTokens() {
  const toks = new Set();
  let sessions = [];
  try { sessions = loadSessions(); } catch { /* 清单坏了也不影响扫描 */ }
  for (const s of sessions) {
    for (const k of ['uid', 'name']) {
      if (s.peer && s.peer[k]) toks.add(String(s.peer[k]));
      if (s.self && s.self[k]) toks.add(String(s.self[k]));
    }
  }
  // 昵称变体 / 历史昵称（这些不会出现在 sessions.json 里，必须显式列出）。
  // 写在**不入库**的本地文件里：它既是黑名单，也是一份「本人标识」清单，
  // 放进仓库等于把要防的东西反过来公布了。
  const LOCAL = path.join(ROOT, 'scripts', '_skill', 'personal_tokens.local.txt');
  try {
    for (const line of fs.readFileSync(LOCAL, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) toks.add(t);
    }
  } catch { /* 没有这个文件也能工作，只是少一层兜底 */ }
  // 本机绝对路径特征：从用户目录与项目父目录推导，避免把用户名写进代码
  for (const p of [os.homedir(), path.dirname(ROOT)]) {
    if (!p) continue;
    toks.add(p);
    toks.add(p.replace(/\\/g, '/'));
    toks.add(p.replace(/\//g, '\\'));
  }
  toks.delete('');
  return [...toks].sort((a, b) => b.length - a.length);
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * 自底向上删掉「空目录」。只删真正空的，任何还有文件的目录原样保留。
 * 用途：旧结构 `cmd/` 的文件被清掉后只剩一个空壳，留着会让人以为还有东西。
 */
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

/** 扫描一个目录，返回命中清单 */
function scanDir(dir, tokens) {
  const hits = [];
  for (const f of walk(dir)) {
    if (!/\.(mjs|js|ps1|py|cmd|html|json|md|txt)$/i.test(f)) continue;
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const t of tokens) {
      if (txt.includes(t)) {
        // 只记录位置，不记录命中内容/上下文（上面 main 的注释说明了为什么）
        hits.push({ file: path.relative(dir, f).replace(/\\/g, '/'), token: t });
      }
    }
  }
  return hits;
}

/**
 * 原地同步：逐文件覆写；再清掉自管目录里「已不在清单中」的陈旧文件。
 * 手写文档（SKILL.md / 开场白.md / references/）一律不碰。
 */
function syncInto(items, outDir) {
  const desired = new Set(items.map(i => i.to.replace(/\\/g, '/')));
  fs.mkdirSync(outDir, { recursive: true });

  let written = 0;
  for (const it of items) {
    const dst = path.join(outDir, it.to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(it.from, dst);
    written++;
  }

  const removed = [];
  for (const d of MANAGED_DIRS) {
    const base = path.join(outDir, d);
    if (!fs.existsSync(base)) continue;
    for (const f of walk(base)) {
      const rel = path.relative(outDir, f).replace(/\\/g, '/');
      if (desired.has(rel)) continue;
      try { fs.rmSync(f, { force: true }); removed.push(rel); } catch { /* 占用就留着，下次再说 */ }
    }
  }
  // 清完文件后再收尾：旧结构留下的空壳目录（如 `cmd/`）一并删掉。
  for (const d of MANAGED_DIRS) pruneEmptyDirs(path.join(outDir, d));
  return { written, removed };
}

// ------------------------------------------------------------------ main
function main() {
  const tokens = personalTokens();
  const outDir = path.resolve(val('--out', DEFAULT_OUT));
  const CHECK_ONLY = has('--check');

  console.log('私信备份 · 生成可分享 Skill');
  console.log('  源项目  ' + ROOT);
  console.log('  输出    ' + outDir);
  // 只报条数，不打印内容：日志会被写进 logs/auto_*.log，打印出来等于二次泄露
  console.log('  隐私清单 ' + tokens.length + ' 条（sessions 派生 + 本机私有补充，内容不外显）');
  console.log('');

  if (CHECK_ONLY) {
    if (!fs.existsSync(outDir)) { console.error('[×] 输出目录不存在：' + outDir); return 1; }
    const hits = scanDir(outDir, tokens);
    if (hits.length) {
      // 只报「文件 + 命中第几条清单」，绝不打印命中内容或上下文：
      // 这里的输出会被 pack_portable 的日志收走（logs/auto_*.log），打印出来等于二次泄露。
      // 需要定位时，对照未入库的 scripts/_skill/personal_tokens.local.txt / sessions.json 派生顺序即可。
      console.log('[×] 发现 ' + hits.length + ' 处残留（不打印内容）：');
      for (const h of hits) {
        console.log(`    ${h.file}  命中隐私清单第 ${tokens.indexOf(h.token) + 1} 条`);
      }
      return 1;
    }
    console.log('[✓] 未发现任何个人信息残留（' + walk(outDir).length + ' 个文件）。');
    return 0;
  }

  const items = codeFiles();
  const { written, removed } = syncInto(items, outDir);
  console.log('[✓] 已同步代码快照 ' + written + ' 个文件' +
              (removed.length ? '，清理陈旧文件 ' + removed.length + ' 个' : ''));

  const hits = scanDir(outDir, tokens);
  if (hits.length) {
    console.error('[×] 产物里发现个人信息残留（请立刻处理）：');
    for (const h of hits) console.error(`    ${h.file}  含「${h.token}」  …${h.ctx}…`);
    return 1;
  }
  console.log('[✓] 隐私扫描通过（含手写文档）');

  const n = walk(outDir).length;
  console.log('');
  console.log(`[完成] Skill 已就绪：${outDir}（共 ${n} 个文件）`);
  console.log('  提示：SKILL.md / 开场白.md / references/ 是手写的，本脚本不会覆盖。');
  return 0;
}

process.exit(main());
