#!/usr/bin/env node
/**
 * 由 sessions.json 生成 sessions.js（查看备份.html 读的会话清单）
 * ===============================================================
 * 页面读不到 sessions.js 时会退到内置的「微博 / B站」兜底，不会打不开；
 * 但新增会话必须靠这个脚本生成，否则页面看不到它。
 *
 * 用法：
 *   node scripts/build_sessions.mjs            # 生成 sessions.js
 *   node scripts/build_sessions.mjs --check    # 只检查是否最新（体检脚本用；过期 exit 1）
 *   node scripts/build_sessions.mjs --mkdir    # 生成的同时补齐每个会话的数据目录骨架
 *   node scripts/build_sessions.mjs --list     # 只打印清单
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, MANIFEST_PATH, loadSessions, sessionDirs } from './sessions.mjs';
import { jsAssign } from './lib/jsassign.mjs';

const ARGS = process.argv.slice(2);
const CHECK = ARGS.includes('--check');
const MKDIR = ARGS.includes('--mkdir');
const LIST = ARGS.includes('--list');

const OUT = path.join(ROOT, 'sessions.js');

function render(list) {
  // 只保留页面需要的字段（assets / skip 这类给脚本用的不进页面）
  const slim = list.map(s => ({
    key: s.key, label: s.label, title: s.title, dir: s.dir,
    builtin: s.builtin, globals: s.globals, files: s.files,
    autoReply: s.autoReply, empty: s.empty,
  }));
  const head = [
    '/* 本文件由 scripts/build_sessions.mjs 从项目根的 sessions.json 自动生成。',
    '   不要手改 —— 改 sessions.json 后重新运行「命令/配置与定时/生成会话清单.cmd」。',
    '   页面读不到本文件时会用内置的「微博 / B站」兜底，不会打不开。 */',
    '',
  ].join('\n');
  return head + jsAssign('DM_SESSIONS', JSON.stringify(slim, null, 2));
}

function main() {
  let list;
  try {
    list = loadSessions();
  } catch (e) {
    console.error('[×] sessions.json 有问题：' + e.message);
    return 2;
  }

  if (LIST) {
    console.log('sessions.json：' + MANIFEST_PATH);
    for (const s of list) {
      console.log('  ' + s.key.padEnd(12) + s.label.padEnd(8) + s.dir.padEnd(10) +
                  s.platform.padEnd(8) + (s.builtin ? '内置标签' : '动态注入') +
                  '  全局名 ' + s.globals.data);
    }
    return 0;
  }

  const text = render(list);
  let old = null;
  try { old = fs.readFileSync(OUT, 'utf8'); } catch {}

  if (CHECK) {
    if (old === text) {
      console.log('[✓] sessions.js 与 sessions.json 一致（' + list.length + ' 个会话）');
      return 0;
    }
    console.log('[×] sessions.js 已过期：请运行「命令/配置与定时/生成会话清单.cmd」重新生成');
    return 1;
  }

  const same = old === text;
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, OUT);

  console.log('[✓] 已生成 sessions.js（' + list.length + ' 个会话）' +
              (same ? ' · 内容本来就和上次一致' : ''));
  for (const s of list) {
    console.log('      ' + s.key.padEnd(12) + s.label.padEnd(8) + s.dir.padEnd(10) +
                (s.builtin ? '内置 <script> 标签' : '页面动态注入'));
  }

  if (MKDIR) {
    let made = 0;
    for (const s of list) {
      for (const d of sessionDirs(s)) {
        const p = path.join(ROOT, d);
        if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); made++; }
      }
    }
    console.log('[✓] 数据目录骨架已就位（新建 ' + made + ' 个目录）');
  }
  return 0;
}

process.exit(main());
