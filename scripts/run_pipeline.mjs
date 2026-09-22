#!/usr/bin/env node
/**
 * 一条命令跑完整条链路（WebUI 的「开始备份」就是跑它）
 * ===============================================================
 * 为什么要有这一层：
 *   「增量抓取 → 表情图 → 图内文字 → 图片描述 → 快照 → 体检」这 6 步各自是独立脚本，
 *   WebUI 需要一个**能流式输出、能中途失败就报错退出**的统一入口。
 *   （定时任务那条路用的是 auto_update.ps1，两者各管一边、互不干扰：
 *    .ps1 是无人值守的 Windows 侧定时用，这个是交互式 WebUI 用。）
 *
 * 设计上有意做的三件事：
 *   1. 子进程用 `stdio:'inherit'`：输出直接接到我们的 stdout/stderr，
 *      WebUI 的任务管理器拿到的就是**原样**的行，不需要在这里再包一层解析；
 *   2. 缺环境不报错、只跳过（没装 OCR 环境 / 没配 Key），并在日志里说清楚跳了什么，
 *      否则用户会以为"跑完了但没有文字索引"是 bug；
 *   3. 退出码沿用既有约定：0 成功 / 1 有步骤失败 / 2 没登录凭据 / 3 登录失效 / 4 配置没填。
 *
 * 用法：
 *   node scripts/run_pipeline.mjs --session weibo
 *   node scripts/run_pipeline.mjs --session bili --mode rebuild
 *   node scripts/run_pipeline.mjs --session weibo --since 2026-01-01 --no-img
 *   node scripts/run_pipeline.mjs --session weibo --steps fetch,snapshot
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, findSession, requirePeerUid } from './sessions.mjs';
import { humanSize, dirStat } from './lib/paths.mjs';
import { statusFor } from './login.mjs';

const ARGS = process.argv.slice(2);
const val = (f, d = null) => {
  const i = ARGS.indexOf(f);
  const v = i >= 0 ? ARGS[i + 1] : null;
  return (v && !v.startsWith('--')) ? v : d;
};
const has = (f) => ARGS.includes(f);

const KEY = val('--session', 'weibo');
const MODE = (val('--mode', 'incr') || 'incr').toLowerCase();
const SINCE = val('--since');
const UNTIL = val('--until');
const NO_IMG = has('--no-img');
const WITH_COMPRESS = has('--compress');
const ONLY_STEPS = val('--steps');
const SELF = process.execPath;

const log = (m) => console.log(m);

let S;
try {
  S = findSession(KEY);
} catch (e) {
  // 这里还在**同步阶段**（没起任何子进程、没有待写的管道数据），
  // 直接 process.exit 不会截断输出 —— 是全局唯一允许直接 exit 的地方。
  console.error('[×] ' + e.message);
  process.exit(4);
}

// 导入的备份是**只读**的：抓取/OCR/压缩/快照都会往那个目录里写东西，一律拒绝。
// 但「体检」是纯读的，而且恰恰是用户拿到别人备份后最需要的一件事（看看包全不全），
// 所以只挡住会写的步骤 —— 否则 WebUI 上写着"导入的只读备份只能跑体检"，
// 点下去却永远拿到一个「不能抓取」的失败，属于 UI 和后端口径打架。
let stepList = ONLY_STEPS
  ? ONLY_STEPS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['fetch', 'faces', 'ocr', 'vlm', 'snapshot', 'doctor'];
if (NO_IMG) stepList = stepList.filter((s) => s !== 'faces' && s !== 'ocr' && s !== 'vlm');
if (WITH_COMPRESS && !stepList.includes('compress')) stepList.push('compress');

// 具体拦截放在 main() 里（那里用 return 4，不直接 process.exit ——
// 见文件末尾：管道里直接 exit 会把还没写出去的日志截掉）。
function rejectWritingOnImported() {
  if (!S.imported) return 0;
  const writing = stepList.filter((s) => s !== 'doctor');
  if (!writing.length) return 0;
  console.error('[×] 会话「' + KEY + '」是**导入的他人备份**（只读），不能执行：' + writing.join(', '));
  console.error('    只允许 --steps doctor（体检）—— 它不写任何文件。');
  return 4;
}

/* ---------------- 找 python（OCR / 图片描述要用） ---------------- */
function findPython() {
  const cands = [
    path.join(ROOT, '.ocr-env', 'Scripts', 'python.exe'),
    path.join(ROOT, '.ocr-env', 'bin', 'python3'),
    process.env.DM_PYTHON || '',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}
const PY = findPython();
/** 只有用项目自带的 .ocr-env 才算"装了 OCR 环境"（RapidOCR 装在里面） */
const hasOcrEnv = !!(PY && PY.startsWith(path.join(ROOT, '.ocr-env')));

function hasGlmKey() {
  if (process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY || process.env.BIGMODEL_API_KEY) return true;
  return fs.existsSync(path.join(ROOT, S.dir, 'glm_key.txt')) ||
         fs.existsSync(path.join(ROOT, 'data', 'glm_key.txt'));
}

function stepCmd(step) {
  const S_ = (name) => path.join(ROOT, 'scripts', name);
  switch (step) {
    case 'fetch': {
      const script = S.platform === 'bili' ? 'bili_update.mjs' : 'update.mjs';
      const a = [S_(script), '--session', KEY];
      if (MODE === 'full') a.push('--full');
      if (MODE === 'rebuild') a.push('--rebuild');
      if (NO_IMG) a.push('--no-img');
      if (SINCE) a.push('--since', SINCE);
      if (UNTIL) a.push('--until', UNTIL);
      return { exe: SELF, args: a, title: '抓取私信（' + (MODE === 'rebuild' ? '全量重建' : MODE === 'full' ? '全量' : '增量') + '）' };
    }
    case 'faces': {
      const script = S.platform === 'bili' ? 'bili_faces.mjs' : 'sync_faces.mjs';
      return { exe: SELF, args: [S_(script)], title: '同步表情图' };
    }
    case 'ocr':
      return { exe: PY, args: ['-u', S_('image_ocr.py'), '--set', KEY], title: '识别图内文字（本地）' };
    case 'vlm':
      return { exe: PY, args: ['-u', S_('image_vlm.py'), '--set', KEY], title: '生成图片描述（免费模型）' };
    case 'compress':
      return { exe: PY, args: ['-u', S_('compress_images.py'), '--set', KEY], title: '压缩图片并删除原图（不可逆）' };
    case 'snapshot':
      return { exe: SELF, args: [S_('snapshot.mjs'), '--make', '--session', KEY, '--note', 'webui'], title: '存一份索引快照' };
    case 'doctor':
      return { exe: SELF, args: [S_('doctor.mjs'), '--session', KEY], title: '一键体检' };
    default:
      return null;
  }
}

function runOne(cmd) {
  return new Promise((resolve) => {
    const p = spawn(cmd.exe, cmd.args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    });
    p.on('error', (e) => { console.error('[启动失败] ' + e.message); resolve(9009); });
    p.on('close', (code) => resolve(code == null ? 0 : code));
  });
}

async function main() {
  /* ---------------- 前置检查 ---------------- */
  const readonlyCode = rejectWritingOnImported();
  if (readonlyCode) return readonlyCode;

  log('==========================================');
  log('  私信备份 · ' + S.label);
  log('==========================================');
  log('  工作区    ' + ROOT);
  log('  数据目录  ' + S.dir);
  log('  模式      ' + (MODE === 'rebuild' ? '全量重建' : MODE === 'full' ? '全量' : '增量') +
      (SINCE ? '　起 ' + SINCE : '') + (UNTIL ? '　止 ' + UNTIL : ''));
  log('  步骤      ' + stepList.join(' → '));
  log('');

  let cfgCode = 0;
  // 导入的备份没有 uid（那是**别人**的账号，包里根本不该有）—— 对它要求「先填要备份谁」
  // 是没道理的：那时唯一允许跑的步骤是体检，而体检不需要 uid。
  if (!S.imported) {
    try { requirePeerUid(S); }
    catch (e) {
      console.error('==========================================================');
      console.error('  [请先配置] 还没有填「要备份谁的私信」');
      console.error('==========================================================');
      console.error('  会话        ' + S.key + '（' + S.label + '）');
      console.error('  要改的地方  WebUI 的「2 选择会话」里填 uid，或直接编辑 sessions.json：');
      console.error('');
      console.error('      "peer": { "uid": "<对方的数字 ID>", "name": "<对方昵称>" }');
      console.error('');
      console.error('  微博：主页地址 weibo.com/u/1234567890   →  1234567890');
      console.error('  B站 ：空间地址 space.bilibili.com/1234567  →  1234567');
      console.error('==========================================================');
      return 4;
    }
  }

  /* ---------------- 抓取前先确认登录态 ----------------
     为什么要在**这里**再查一次：更新脚本（update.mjs / bili_update.mjs）当然也会报
     「登录态已失效」，但那要等到跑起来、打过一次接口之后才知道；
     在这里先问一次，用户看到的是「你还没登录，去登录」，而不是跑半天再失败。
     ⚠ 判定必须用**真打接口**的 statusFor —— 只看本地有没有 Cookie 文件会把过期的
       Cookie 判成已登录（那正是「界面说已登录、抓取说未登录」的老问题）。 */
  const needsLogin = stepList.some((s) => s === 'fetch' || s === 'faces');
  if (needsLogin && !S.imported) {
    const st = await statusFor(S);
    if (!st.loggedIn && st.invalidReason !== 'network') {
      console.error('');
      console.error('[×] 「' + S.label + '」还没有有效的登录态 —— ' +
        (st.invalidReason === 'expired'
          ? '本地 Cookie 文件还在（' + st.cookieFile + '），但平台接口已经不认它了（多半是过期）。'
          : '还没有登录凭据（' + st.cookieFile + '）。'));
      console.error('    请先完成授权登录：WebUI 第 2 步点「授权登录」（已登录过就点「重新登录」），');
      console.error('    或命令行执行：node scripts/login.mjs --session ' + S.key + (st.invalidReason === 'expired' ? ' --force' : ''));
      return 2;
    }
    if (st.loggedIn) {
      log('  登录态已确认' + (st.account ? '（账号：' + st.account + '）' : '') +
          '：' + (st.source === 'browser' ? '来自浏览器' : '来自本地 Cookie 文件') + '，接口校验通过。');
    } else {
      log('  注意：连不上平台接口（' + st.invalidDetail + '），没法预先确认登录态，照常继续。');
    }
  }

  /* ---------------- 逐步执行 ---------------- */
  const t0 = Date.now();
  const failed = [];
  const skipped = [];
  let n = 0;

  for (const step of stepList) {
    const cmd = stepCmd(step);
    if (!cmd) { log('[!] 不认识的步骤：' + step + '（已跳过）'); continue; }

    // 环境不满足 → 跳过而不是失败
    if ((step === 'ocr') && (!PY || !hasOcrEnv)) {
      log('');
      log('── [' + (++n) + '/' + stepList.length + '] ' + cmd.title + ' —— 跳过');
      log('   原因：没装 OCR 环境（双击「命令/图片与OCR/安装OCR环境.cmd」可启用）。');
      skipped.push(step);
      continue;
    }
    if (step === 'vlm' && (!PY || !hasOcrEnv || !hasGlmKey())) {
      log('');
      log('── [' + (++n) + '/' + stepList.length + '] ' + cmd.title + ' —— 跳过');
      log('   原因：' + (!PY || !hasOcrEnv ? '没装 OCR 环境' : '没配 API Key（data/glm_key.txt）') + '。');
      skipped.push(step);
      continue;
    }

    log('');
    log('── [' + (++n) + '/' + stepList.length + '] ' + cmd.title);
    const code = await runOne(cmd);
    if (code !== 0) {
      log('   [NG] 退出码 ' + code);
      failed.push({ step, title: cmd.title, code });
      // 抓取本身没成功（比如没登录）就没必要继续后面的索引步骤了
      if (step === 'fetch') {
        log('');
        log('抓取没有成功，后面的索引步骤不再执行。');
        break;
      }
    } else {
      log('   [ok]');
    }
  }

  /* ---------------- 汇总 ---------------- */
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log('');
  log('==========================================');
  log('  ' + (failed.length ? '结束（有失败）' : '完成') + '　耗时 ' + secs + 's');
  log('==========================================');

  if (S.platform === 'bili') log('  说明：B站 的自动回复不计入分类统计（那边没有这个概念）。');
  const st = dirStat(path.join(ROOT, S.dir));
  log('  数据目录现在：' + st.files + ' 个文件 · ' + humanSize(st.bytes));
  if (skipped.length) log('  跳过：' + skipped.join('、'));
  if (failed.length) {
    for (const f of failed) log('  ✗ ' + f.title + '（退出码 ' + f.code + '）');
    const first = failed[0].code;
    // 把 2/3/4 这类"可照做"的退出码原样传出去，让 WebUI 能给出对应提示
    return [2, 3, 4].includes(first) ? first : 1;
  }
  log('  现在可以点「查看备份」了。');
  return 0;

}

// 说明：本文件的输出是被 WebUI 用管道接走的，管道写是**异步**的。
// 所以一律用 process.exitCode 让进程自然退出 —— 直接 process.exit() 会在
// 最后几行日志还没冲出去时就把进程掐掉，界面上就只剩半句日志。
process.exitCode = await main();
