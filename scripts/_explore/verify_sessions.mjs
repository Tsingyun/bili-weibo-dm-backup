#!/usr/bin/env node
/**
 * 多会话清单验证（P1-9）
 * ===============================================================
 * 覆盖：
 *   1) 真实 sessions.json 的归一化结果（内置两个不能被改坏）
 *   2) 新增会话的自动推导（全局名 / builtin / files / title / skip）
 *   3) 非法配置必须报错，不许静默降级
 *   4) --session 参数解析
 *   5) build_sessions.mjs --check 的过期检测
 *   6) python 侧 SETS 合并与 --set 校验
 *
 * 做法：用 DM_SESSIONS_JSON 指向临时清单，绝不碰真实 sessions.json。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, loadSessions, defaultGlobals } from '../sessions.mjs';

let pass = 0, fail = 0;
function chk(name, cond, extra) {
  if (cond) { pass++; console.log('  [ok] ' + name); }
  else { fail++; console.log('  [NG] ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
function throws(fn) {
  try { fn(); return null; } catch (e) { return e.message || String(e); }
}

const NODE = process.execPath;
/* 测试用 Python：优先环境变量；否则用项目自带的 OCR 环境（「安装OCR环境.cmd」生成）；
   再退回 PATH 上的 python。 */
const PY = process.env.DM_TEST_PYTHON ||
  [path.join(ROOT, '.ocr-env', 'Scripts', 'python.exe'),
   path.join(ROOT, '.ocr-env', 'bin', 'python')].find((p) => fs.existsSync(p)) ||
  (process.platform === 'win32' ? 'python' : 'python3');

// ============ 1. 真实清单 ============
console.log('\n[1] 真实 sessions.json');
const real = loadSessions();
chk('共 2 个会话', real.length === 2, real.map(s => s.key).join(','));
const W = real.find(s => s.key === 'weibo');
const B = real.find(s => s.key === 'bili');
chk('weibo / bili 都在', !!W && !!B);
chk('weibo 目录是 data', W && W.dir === 'data', W && W.dir);
chk('bili 目录是 bili', B && B.dir === 'bili', B && B.dir);
chk('weibo 用历史全局名 DM_DATA', W && W.globals.data === 'DM_DATA', W && W.globals.data);
chk('bili 用历史全局名 DM_DATA_B', B && B.globals.data === 'DM_DATA_B', B && B.globals.data);
chk('weibo ocr/vlm 全局名没被改',
  W && W.globals.ocr === 'DM_OCR' && W.globals.vlm === 'DM_VLM');
chk('bili ocr/vlm 全局名没被改',
  B && B.globals.ocr === 'DM_OCR_B' && B.globals.vlm === 'DM_VLM_B');
chk('两个都是 builtin（页里有静态 script 标签）', W.builtin === true && B.builtin === true);
chk('builtin 会话不带 files（页面不用动态注入）', W.files === null && B.files === null);
chk('weibo skip 含 avatar_', W.skip.includes('avatar_'));
chk('bili skip 用 face_ 前缀', B.skip.includes('face_'));
chk('weibo empty 文案仍指向「更新备份.cmd」', /更新备份\.cmd/.test(W.empty), W.empty);
chk('bili empty 文案仍指向「更新B站备份.cmd」', /更新B站备份\.cmd/.test(B.empty));
chk('platform 与 key 对应', W.platform === 'weibo' && B.platform === 'bili');

// ============ 2. 替身清单：第三个会话 ============
console.log('\n[2] 新增会话的自动推导');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-sess-'));
const synPath = path.join(tmp, 'sessions.json');
fs.writeFileSync(synPath, JSON.stringify({
  sessions: [
    { key: 'weibo', label: '微博', dir: 'data' },
    { key: 'bili', label: 'B站', dir: 'bili', platform: 'bili' },
    { key: 'weibo2', label: '小号', dir: 'data2' },
  ],
}, null, 2), 'utf8');
process.env.DM_SESSIONS_JSON = synPath;
const M2 = await import('../sessions.mjs?syn=1');
const syn = M2.loadSessions();
chk('替身清单读到 3 个会话', syn.length === 3, syn.length);

const X = syn.find(s => s.key === 'weibo2');
chk('新会话全局名自动生成为 DM_DATA_WEIBO2', X && X.globals.data === 'DM_DATA_WEIBO2', X && X.globals.data);
chk('新会话 ocr/vlm 全局名也自动生成',
  X && X.globals.ocr === 'DM_OCR_WEIBO2' && X.globals.vlm === 'DM_VLM_WEIBO2');
chk('新会话 builtin=false（页面要动态注入）', X && X.builtin === false);
chk('新会话 files 指向自己的目录',
  X && X.files && X.files.messages === 'data2/messages.js' && X.files.vlm === 'data2/vlm.js',
  X && JSON.stringify(X.files));
chk('新会话 title 按 label 生成', X && X.title === '小号私信备份', X && X.title);
chk('新会话 empty 指向自己的目录', X && /data2\/messages\.js/.test(X.empty), X && X.empty);
chk('新会话 skip 按 platform 取默认（pic_）', X && X.skip.includes('pic_'));

// 关键回归：省略 globals 时，内置两个必须落到历史短名上（不是 DM_DATA_BILI）
chk('省略 globals 的 weibo 仍拿到 DM_DATA',
  syn.find(s => s.key === 'weibo').globals.data === 'DM_DATA',
  syn.find(s => s.key === 'weibo').globals.data);
chk('省略 globals 的 bili 仍拿到 DM_DATA_B（不是 DM_DATA_BILI）',
  syn.find(s => s.key === 'bili').globals.data === 'DM_DATA_B',
  syn.find(s => s.key === 'bili').globals.data);
chk('defaultGlobals 对内置走历史短名',
  defaultGlobals('bili').data === 'DM_DATA_B' && defaultGlobals('x9').data === 'DM_DATA_X9');

// files 里的路径必须真的带目录，不能是裸文件名
chk('非 builtin 会话的 files 都带目录前缀',
  ['messages', 'faces', 'ocr', 'vlm'].every(k => X.files[k].startsWith('data2/')));

// ============ 3. 非法配置必须报错 ============
console.log('\n[3] 非法配置的报错路径');
let seq = 0;
async function loadWith(sessions) {
  const p = path.join(tmp, 'bad' + (++seq) + '.json');
  fs.writeFileSync(p, JSON.stringify({ sessions }), 'utf8');
  process.env.DM_SESSIONS_JSON = p;
  const m = await import('../sessions.mjs?bad=' + seq);
  return m.loadSessions();
}
const cases = [
  ['缺 key', [{ dir: 'x' }], /缺少 key/],
  ['key 含非法字符', [{ key: 'we ibo', dir: 'x' }], /字母/],
  ['key 重复', [{ key: 'a', dir: 'x' }, { key: 'a', dir: 'y' }], /重复/],
  ['缺 dir', [{ key: 'a' }], /缺少 dir/],
  ['dir 是绝对路径', [{ key: 'a', dir: 'C:/tmp/x' }], /相对路径/],
  ['dir 含 ..', [{ key: 'a', dir: '../x' }], /相对路径/],
  ['platform 不认识', [{ key: 'a', dir: 'x', platform: 'wechat' }], /platform/],
];
for (const [name, sessions, re] of cases) {
  const msg = await (async () => {
    try { await loadWith(sessions); return null; } catch (e) { return e.message; }
  })();
  chk('拒绝：' + name, msg !== null && re.test(msg), msg === null ? '（没有报错！）' : msg);
}

// ============ 4. --session 解析 ============
console.log('\n[4] --session 参数解析');
process.env.DM_SESSIONS_JSON = synPath;
const M4 = await import('../sessions.mjs?a=4');
chk('不传 --session 时用默认值', M4.sessionFromArgs([], 'weibo') === 'weibo');
chk('--session bili 能取到', M4.sessionFromArgs(['--session', 'bili'], 'weibo') === 'bili');
chk('--session 放中间也能取到',
  M4.sessionFromArgs(['--full', '--session', 'weibo2', '--no-img'], 'weibo') === 'weibo2');
chk('--session 后面没值 → 报错',
  /要跟会话 key/.test(throws(() => M4.sessionFromArgs(['--session'], 'weibo')) || ''));
chk('--session 后面直接跟另一个开关 → 报错',
  /要跟会话 key/.test(throws(() => M4.sessionFromArgs(['--session', '--full'], 'weibo')) || ''));
chk('findSession 认出去不存在的 key',
  /不认识会话/.test(throws(() => M4.findSession('nope')) || ''));

// ============ 5. build_sessions.mjs --check ============
console.log('\n[5] build_sessions.mjs --check');
// ⚠ 子进程环境必须显式清掉 DM_SESSIONS_JSON：{...process.env} 里本来就带着它，
//   只在拷贝上 delete 是没用的 —— 子进程实际还会去读替身清单（这个坑踩过一次）。
//   语义：extra 里**没写** DM_SESSIONS_JSON 就当作「未设置」，走真实清单。
function childEnv(extra) {
  const e = { ...process.env, PYTHONIOENCODING: 'utf-8', ...extra };
  if (!extra || !('DM_SESSIONS_JSON' in extra)) delete e.DM_SESSIONS_JSON;
  return e;
}
function runBuild(extra) {
  try {
    const out = execFileSync(NODE, [path.join(ROOT, 'scripts', 'build_sessions.mjs'), '--check'],
      { cwd: ROOT, env: childEnv(extra), encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}
{
  const r = runBuild({});
  chk('真实清单下 --check 通过（sessions.js 是最新的）', r.code === 0, 'exit ' + r.code + ' ' + r.out.trim());
}
{
  const r = runBuild({ DM_SESSIONS_JSON: synPath });
  chk('清单变了 --check 就报过期（exit 1）', r.code === 1, 'exit ' + r.code);
}

// ============ 6. python 侧 ============
console.log('\n[6] python 侧 SETS 合并');
const scriptsDir = path.join(ROOT, 'scripts');
function py(code, env) {
  try {
    const out = execFileSync(PY, ['-c', code],
      { cwd: ROOT, env: childEnv(env), encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}
{
  const r = py(`
import sys; sys.path.insert(0, r'${scriptsDir}')
import image_ocr as a, image_vlm as b
print(sorted(a.SETS), sorted(b.SETS))
print(a.SETS['weibo2']['js'], b.SETS['weibo2']['js'])
print(a.SETS['weibo2']['dir'], a.SETS['weibo2']['skip'])
`, { DM_SESSIONS_JSON: synPath });
  chk('python 也读到了第三个会话', /weibo2/.test(r.out), r.out.trim());
  chk('python 自动推出的 ocr 全局名是 DM_OCR_WEIBO2', /DM_OCR_WEIBO2/.test(r.out));
  chk('python 自动推出的 vlm 全局名是 DM_VLM_WEIBO2', /DM_VLM_WEIBO2/.test(r.out));
  chk('python 的 dir / skip 跟着 manifest 走', /data2.*pic_/.test(r.out.replace(/\n/g, ' ')), r.out.trim());
}
{
  const r = py(`
import sys; sys.path.insert(0, r'${scriptsDir}')
import image_ocr as a
print(sorted(a.SETS))
`, { DM_SESSIONS_JSON: path.join(tmp, 'nope.json') });
  chk('清单文件缺失时 python 退回内置两个', /\[.bili., .weibo.\]|\[.bili., .weibo.\]/.test(r.out), r.out.trim());
}
{
  // --set 校验：argparse 在解析期就该拒绝（真跑之前）
  const r = py(`pass`, {});
  const ocr = path.join(scriptsDir, 'image_ocr.py');
  let code = 0, out = '';
  try {
    execFileSync(PY, [ocr, '--set', 'nosuch'],
      { cwd: ROOT, env: childEnv({}), encoding: 'utf8' });
  } catch (e) { code = e.status; out = (e.stderr || '') + (e.stdout || ''); }
  chk('image_ocr.py --set nosuch 被拒绝（exit 2）', code === 2, 'exit ' + code);
  chk('拒绝信息里列出了可用的 set', /weibo/.test(out) && /bili/.test(out), out.trim().slice(0, 200));
}

// 收尾：清掉临时目录
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log('\n' + '='.repeat(56));
console.log(`多会话清单验证：通过 ${pass} · 失败 ${fail}`);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);
