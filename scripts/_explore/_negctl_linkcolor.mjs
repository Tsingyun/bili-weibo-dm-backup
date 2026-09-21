/* 反向验证（negative control）：
   把 2026-09-15 修掉的那个「分享卡片白字落在浅色底」的 bug **临时改回去**，
   确认 shot_bili_real.mjs 第 9 节能真的报红 —— 测试若不能抓到 bug 就等于没测。
   跑完自动还原。用法：node scripts/_explore/_negctl_linkcolor.mjs [restore] */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const FILE = path.join(ROOT, '查看备份.html');
const BAK = path.join(ROOT, 'scripts', '_explore', '.查看备份.html.negctl.bak');

const mode = process.argv[2] || 'break';

if (mode === 'restore') {
  if (!fs.existsSync(BAK)) { console.error('[×] 没有备份，无法还原'); process.exit(2); }
  fs.copyFileSync(BAK, FILE);
  fs.unlinkSync(BAK);
  console.log('[ok] 已还原 查看备份.html');
  process.exit(0);
}

// ---- 打补丁：把三处修复回退成有 bug 的旧写法 ----
fs.copyFileSync(FILE, BAK);
let s = fs.readFileSync(FILE, 'utf8');
const patches = [
  // 1) 去掉「透明气泡还原正常字色」这条 —— 白字继续落在浅色页面上
  ['.msg.me .bubble.plain{color:var(--text)}\n', ''],
  // 2) 链接回到「半透明白底 + 白字」
  ['.msg.me .bubble:not(.plain):not(.sys) .wcard-link{background:rgba(255,255,255,.94);color:var(--link-ink)}',
   '.msg.me .wcard-link{background:rgba(255,255,255,.2);color:#fff}'],
  // 3) 卡片标题回到「title 与 text 各渲染一遍」
  ["var cardText = (card.text && card.text.trim() !== (card.title || '').trim()) ? card.text : '';",
   "var cardText = card.text;"],
];
let n = 0;
for (const [from, to] of patches) {
  if (!s.includes(from)) { console.error('[×] 找不到待回退的片段（页面结构变了？）：' + from.slice(0, 60)); process.exit(2); }
  s = s.replace(from, to);
  n++;
}
fs.writeFileSync(FILE, s, 'utf8');
console.log('[ok] 已注入 ' + n + ' 处「旧 bug 写法」，现在跑验证应报红；跑完执行 restore 还原');
