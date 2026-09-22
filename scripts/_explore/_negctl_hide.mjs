/* 反向验证（negative control）：
   把 2026-09-16 这轮修掉/新增的东西**临时改回旧写法**，确认 verify_hide.mjs 真会报红
   —— 测试若不能抓到 bug 就等于没测（这是本项目的老规矩：
   _negctl_linkcolor.mjs 就是这么验「分享卡片白字」那条的）。

   注入 4 处「旧写法」：
     P1  applyFilter 不再排除单独隐藏的消息      → 「隐藏后搜不到」应报红
     P2  上下文不再跳过自动回复                  → 「上下文跳过自动回复」应报红
     P3  hideTxt 退回 `!!AUTO_REPLY && …`（只认微博） → 「B站正文不漏」应报红
     P4  类型兜底不再区分「被隐藏的自动回复」     → 「不再出现 [文字]」应报红

   用法：
     node scripts/_explore/_negctl_hide.mjs            # 注入 → 跑 verify_hide → 核对报红项 → 自动还原
     node scripts/_explore/_negctl_hide.mjs restore    # 万一中途挂了，手动还原
*/
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.cwd());
const FILE = path.join(ROOT, '查看备份.html');
const BAK = path.join(ROOT, 'scripts', '_explore', '.查看备份.html.hide-negctl.bak');
const NODE = process.execPath;
const VERIFY = path.join(ROOT, 'scripts', '_explore', 'verify_hide.mjs');

function restore() {
  if (fs.existsSync(BAK)) {
    fs.copyFileSync(BAK, FILE);
    fs.unlinkSync(BAK);
    console.log('[ok] 已还原 查看备份.html');
  } else {
    console.log('[--] 没有备份文件，无需还原');
  }
}

if ((process.argv[2] || '') === 'restore') { restore(); process.exit(0); }
if (fs.existsSync(BAK)) { console.error('[×] 上次的反向验证没还原干净，先跑一次 restore'); process.exit(2); }

/* 每处都必须**确实存在**，否则说明页面结构变了、这套反向验证已经失效（宁可炸掉也别静默通过） */
const patches = [
  ['P1 隐藏项不再从列表/搜索里排除',
    '      if(isHid(m)) return false;',
    '      if(false) return false;   /* NEGCTL */'],
  ['P2 上下文不再跳过自动回复',
    '      for(k = from; k < ai; k++) if(!ctxMuted(k)) put(k, null, true);',
    '      for(k = from; k < ai; k++) put(k, null, true);   /* NEGCTL */'],
  ['P2b 上下文不再跳过自动回复（下半段）',
    '      for(k = ai + 1; k <= to; k++) if(!ctxMuted(k)) put(k, null, true);',
    '      for(k = ai + 1; k <= to; k++) put(k, null, true);   /* NEGCTL */'],
  ['P3 hideTxt 退回「只认微博文案」的旧写法（B站判定失效）',
    '                    autoMuted;',
    "                    (!!AUTO_REPLY && tt === AUTO_REPLY && st.hideAuto);   /* NEGCTL */"],
  ['P4 类型兜底不再区分「被隐藏的自动回复」→ 露出 [文字]',
    "      if(!inner) inner = autoMuted\n        ? '<span class=\"mutedph\">🙈 自动回复已隐藏</span>'\n        : '<span style=\"opacity:.6\">[' + esc(TYPE_LABEL[m.type] || m.type) + ']</span>';",
    "      if(!inner) inner = '<span style=\"opacity:.6\">[' + esc(TYPE_LABEL[m.type] || m.type) + ']</span>';   /* NEGCTL */"],
];

fs.copyFileSync(FILE, BAK);
let s = fs.readFileSync(FILE, 'utf8');
for (const [name, from, to] of patches) {
  const n = s.split(from).length - 1;
  if (n !== 1) {
    console.error(`[×] ${name}：期望命中 1 处，实际 ${n} 处 —— 页面结构变了，这套反向验证得重写`);
    restore();
    process.exit(2);
  }
  s = s.replace(from, to);
  console.log('[注入] ' + name);
}
fs.writeFileSync(FILE, s, 'utf8');

console.log('\n跑 verify_hide.mjs（期望报红）…\n' + '-'.repeat(56));
const r = spawnSync(NODE, [VERIFY], { cwd: ROOT, encoding: 'utf8' });
const out = (r.stdout || '') + (r.stderr || '');
console.log(out.split('\n').filter(l => /❌|隐藏消息专项/.test(l)).join('\n'));
console.log('-'.repeat(56));

/* 这 5 条是「本次修复的核心」——必须能被反向验证打红，否则测试是摆设 */
const mustFail = [
  '不再出现 [文字] 占位气泡',
  '上下文里自动回复被跳过',
  '隐藏后：搜索结果里不再出现这条消息',
  'B站：一条自动回复正文都没有漏出来',
  'B站：上下文里自动回复被跳过',
];
const failBlock = out.split('失败项：')[1] || '';
const missing = mustFail.filter(l => !failBlock.includes(l.replace('★ ', '')) && !failBlock.includes(l));

console.log('');
if (r.status !== 0) console.log('[ok] 验证脚本确实失败了（exit=' + r.status + '）');
else console.log('[×] 验证脚本竟然还全绿 —— 说明这些断言根本抓不到 bug！');
if (!missing.length) console.log('[ok] 5 条核心断言都被打红：' + mustFail.length + '/5');
else console.log('[×] 这些核心断言没被触发（测试是摆设）：\n    · ' + missing.join('\n    · '));

restore();
process.exit((r.status !== 0 && !missing.length) ? 0 : 1);
