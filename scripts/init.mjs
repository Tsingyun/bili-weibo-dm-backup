#!/usr/bin/env node
/**
 * 一键初始化工作区 —— 把 Skill 里的模板铺成一个能直接跑的备份项目
 * ===============================================================
 * 这个脚本只在「装好 Skill、第一次用」时跑一次。
 * 它把 Skill 自带的查看页 / 脚本 / 启动器复制到目标目录，并生成一份
 * **待填的** sessions.json —— 里面不含任何人的账号信息，需要你自己填 uid。
 *
 * 用法：
 *   node scripts/init.mjs                  # 铺到 ./dm-backup
 *   node scripts/init.mjs D:\我的备份       # 铺到指定目录
 *   node scripts/init.mjs --here           # 直接铺在当前目录（必须是空目录才允许）
 *
 * 幂等：重复运行不会覆盖已存在的 sessions.json / .gitignore（要覆盖加 --force）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SKILL_ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS = path.join(SKILL_ROOT, 'assets');
const CMDDIR = path.join(SKILL_ROOT, '命令');   // 启动器按用途分在 命令/<分类>/
const SCRIPTS = path.join(SKILL_ROOT, 'scripts');

const ARGS = process.argv.slice(2);
const FORCE = ARGS.includes('--force');
const HERE = ARGS.includes('--here');
const positional = ARGS.filter(a => !a.startsWith('--'));
const TARGET = path.resolve(HERE ? process.cwd() : (positional[0] || path.join(process.cwd(), 'dm-backup')));

/** 一次性工具，不该铺进目标项目 */
const SKIP_SCRIPTS = new Set(['init.mjs']);

function say(m) { console.log(m); }
function ok(m) { console.log('  [✓] ' + m); }
function warn(m) { console.log('  [!] ' + m); }

function copyIfNew(from, to, { force = false } = {}) {
  if (fs.existsSync(to) && !force) { warn('已存在，保留不动：' + path.basename(to)); return false; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  ok('写入 ' + path.relative(TARGET, to));
  return true;
}

function main() {
  say('');
  say('==========================================');
  say('  私信备份 · 初始化工作区');
  say('==========================================');
  say('  来源  ' + SKILL_ROOT);
  say('  目标  ' + TARGET);
  say('');

  if (!fs.existsSync(ASSETS)) {
    say('[×] 找不到 Skill 的 assets/ 目录，无法初始化：' + ASSETS);
    return 1;
  }
  fs.mkdirSync(TARGET, { recursive: true });

  // 1) 查看页
  say('[1/6] 放置查看页…');
  copyIfNew(path.join(ASSETS, '查看备份.html'), path.join(TARGET, '查看备份.html'), { force: FORCE });

  // 2) 脚本
  say('[2/6] 放置脚本…');
  let nScript = 0;
  for (const name of fs.readdirSync(SCRIPTS)) {
    if (SKIP_SCRIPTS.has(name)) continue;
    if (!/\.(mjs|ps1|py)$/.test(name)) continue;
    if (fs.statSync(path.join(SCRIPTS, name)).isDirectory()) continue;
    copyIfNew(path.join(SCRIPTS, name), path.join(TARGET, 'scripts', name), { force: FORCE });
    nScript++;
  }
  // scripts/lib/ 是 WebUI 那一层（server / 导出引擎 / 导入）的共用模块。
  // ⚠ 上面那个循环只扫**顶层**文件 —— 漏了这里，server.mjs 会 import 不到 ./lib/*，
  //   界面起来就是空白页，而「少复制了几个文件」从外面根本看不出来。
  const LIB = path.join(SCRIPTS, 'lib');
  if (fs.existsSync(LIB)) {
    for (const name of fs.readdirSync(LIB)) {
      if (!/\.mjs$/.test(name)) continue;
      if (!fs.statSync(path.join(LIB, name)).isFile()) continue;
      copyIfNew(path.join(LIB, name), path.join(TARGET, 'scripts', 'lib', name), { force: FORCE });
      nScript++;
    }
  }
  say('      共 ' + nScript + ' 个脚本');

  // 3) 双击启动器（包内按用途分在 命令/<分类>/，原样铺过去 —— 目标项目里也是这个结构）
  say('[3/6] 放置双击启动器…');
  let nCmd = 0;
  function copyCmdTree(srcDir, relDir) {
    for (const name of fs.readdirSync(srcDir)) {
      const full = path.join(srcDir, name);
      if (fs.statSync(full).isDirectory()) { copyCmdTree(full, path.join(relDir, name)); continue; }
      if (!name.toLowerCase().endsWith('.cmd')) continue;
      copyIfNew(full, path.join(TARGET, relDir, name), { force: FORCE });
      nCmd++;
    }
  }
  if (fs.existsSync(CMDDIR)) copyCmdTree(CMDDIR, '命令');
  say('      共 ' + nCmd + ' 个启动器（命令/<分类>/）');

  // 4) WebUI 前端 + 它要用到的目录
  say('[4/6] 放置 WebUI…');
  let nWeb = 0;
  const WEBUI = path.join(SKILL_ROOT, 'webui');
  if (fs.existsSync(WEBUI)) {
    for (const name of fs.readdirSync(WEBUI)) {
      if (!/\.(html|css|js)$/.test(name)) continue;
      if (!fs.statSync(path.join(WEBUI, name)).isFile()) continue;
      copyIfNew(path.join(WEBUI, name), path.join(TARGET, 'webui', name), { force: FORCE });
      nWeb++;
    }
  } else {
    warn('Skill 里没有 webui/ 目录 —— 引导界面会跑不起来（命令行那套不受影响）');
  }
  // 这三个目录得先在：服务端起来后会往里写
  //（待导入的压缩包 / 已导入的他人备份 / 界面自己的运行状态）
  for (const d of ['imports', 'imported', '.webui']) {
    fs.mkdirSync(path.join(TARGET, d), { recursive: true });
  }
  say('      共 ' + nWeb + ' 个前端文件（imports / imported / .webui 目录已就绪）');

  // 5) 配置文件（保留既有，避免抹掉用户已填的 uid）
  say('[5/6] 生成配置文件…');
  copyIfNew(path.join(ASSETS, 'sessions.template.json'), path.join(TARGET, 'sessions.json'), { force: FORCE });
  copyIfNew(path.join(ASSETS, 'gitignore.template'), path.join(TARGET, '.gitignore'), { force: FORCE });

  // 6) 数据目录骨架 + sessions.js
  say('[6/6] 生成会话清单与数据目录…');
  try {
    const out = execFileSync(process.execPath, [path.join(TARGET, 'scripts', 'build_sessions.mjs'), '--mkdir'],
      { cwd: TARGET, encoding: 'utf8' });
    for (const line of out.trim().split('\n')) say('      ' + line);
  } catch (e) {
    warn('生成会话清单失败：' + (e.stdout || e.message));
  }

  say('');
  say('------------------------------------------');
  say('  下一步（4 步）：');
  say('   1. 用记事本打开  ' + path.join(TARGET, 'sessions.json'));
  say('      把每个会话的 peer.uid / peer.name 填成「你要备份的那个人的」；');
  say('      微博 uid 看主页地址 weibo.com/u/<这串数字>');
  say('      B站  uid 看空间地址 space.bilibili.com/<这串数字>');
  say('   2. 双击「命令/配置与定时/生成会话清单.cmd」');
  say('   3. 双击「命令/查看与导出/启动WebUI.cmd」—— 浏览器里会开一个引导界面，');
  say('      照着上面 1→7 步点就行（授权登录 → 选会话 → 选范围 → 备份 → 导出）。');
  say('      习惯命令行的也可以走老路：双击「命令/备份与更新/更新备份.cmd」');
  say('      （B站用「命令/备份与更新/更新B站备份.cmd」）。');
  say('   4. 备份完双击「查看备份.html」翻聊天记录。');
  say('------------------------------------------');
  say('');
  return 0;
}

process.exit(main());
