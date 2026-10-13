/* 应急推送通道：github.com 主机被网络阻断、但 api.github.com 通时，用 GitHub Git Data API
   把**已经 commit 好的**本地提交推上远端 main。
   用法：node scripts/_explore/_push_via_api.mjs <local-commit-sha> [--onto <base-sha>]

   做法：读本地 commit 的 tree / author / committer / message → 在远端按同样数据重建
   blob / tree / commit → 更新 main 引用 → 再把远端提交链 adopt 回本地并对齐引用。

   ⚠ 只适用于「单一主机被阻断」这种情形（本次：代理对 github.com 的 CONNECT 回 502，
     而 api.github.com 与直连都正常）。github.com 恢复后请改用普通 `git push`。

   ⚠ 三条硬守卫，都是踩过才知道的：
     1. 基提交必须是**远端当前 tip**（`--onto` 也只是显式指定当前 tip）——
        拿旧 tip 当基会把中间那次推送整个抹掉。
     2. 每个 blob 上传后，GitHub 返回的 SHA 必须与本地 `git ls-tree` 读到的一致，
        否则说明内容没 round-trip（行尾 / 编码），直接中止。
     3. 推送后复核「远端 main 的 tree == 本地 commit 的 tree」——树一致即内容逐字节一致。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'Tsingyun/bili-weibo-dm-backup';
const API = 'https://api.github.com';
const SHA = process.argv[2];
if (!SHA || SHA.startsWith('--')) { console.error('用法: node _push_via_api.mjs <commit-sha> [--onto <base-sha>]'); process.exit(2); }

const git = (args) => execFileSync('git', args, { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const hasObject = (sha) => { try { execFileSync('git', ['cat-file', '-e', sha], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; } };
const TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (!TOKEN) throw new Error('拿不到 gh token（gh auth token 为空）');

async function api(p, method = 'GET', body) {
  const r = await fetch(API + p, {
    method,
    headers: {
      authorization: 'Bearer ' + TOKEN,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dm-archive-push-via-api',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

/* ---- 把远端 commit 对象（含缺失的父链）重建回本地对象库 ----
   不走 github.com 就拿不到对象，本地 `git log` 会断在父提交上、`git status` 会假显 ahead。
   两个实测细节：
   · GitHub 存盘时会给 commit 消息补一个尾换行，API 返回时又剥掉 → 重建必须补回去
     （不补：12428e09；补了：e7e69b08，与 API 的 sha 一致）。
   · 别用 stdin 管道喂 `git hash-object`：本机实测 execFileSync 的 input 管道会让 git
     读到空内容（报 object fails fsck: unterminatedHeader）。把临时文件路径当参数传最稳。 */
async function adopt(sha) {
  if (hasObject(sha)) return;
  const c = await api(`/repos/${REPO}/git/commits/${sha}`);
  const who = (w) => `${w.name} <${w.email}> ${Math.floor(Date.parse(w.date) / 1000)} +0000`;
  const raw = 'tree ' + c.tree.sha + '\n' +
    c.parents.map(p => 'parent ' + p.sha).join('\n') + '\n' +
    'author ' + who(c.author) + '\n' + 'committer ' + who(c.committer) + '\n\n' + c.message + '\n';
  const tmp = path.join(os.tmpdir(), 'adopt_' + sha.slice(0, 10) + '.raw');
  fs.writeFileSync(tmp, Buffer.from(raw, 'utf8'));
  const got = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--literally', tmp],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.unlinkSync(tmp);
  if (got !== sha) throw new Error(`adopt 出来的 SHA 不对（${got} != ${sha}）—— 消息/时区规范化规则又变了？`);
  console.log('  adopt ✓', sha.slice(0, 10), '·', c.message.split('\n')[0].slice(0, 46));
  if (!hasObject(c.tree.sha)) console.log('  ⚠ 该提交的 tree 对象本地也没有，git show/log --stat 仍会缺内容');
  for (const p of c.parents) await adopt(p.sha);
}

/* ---- 1. 本地提交的原始信息 ---- */
const raw = git(['cat-file', 'commit', SHA]).toString('utf8');
const cut = raw.indexOf('\n\n');
const lines = raw.slice(0, cut).split('\n');
const message = raw.slice(cut + 2);
const parseWho = (l) => {                       // "author Name <mail> 1697000000 +0800"
  const m = /^(?:author|committer) (.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(l);
  if (!m) throw new Error('who 行解析失败: ' + l);
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
};
const local = {
  tree: (lines.find(l => l.startsWith('tree ')) || '').slice(5).trim(),
  parent: (lines.find(l => l.startsWith('parent ')) || '').slice(7).trim() || null,
  author: parseWho(lines.find(l => l.startsWith('author '))),
  committer: parseWho(lines.find(l => l.startsWith('committer '))),
  message,
};
if (!local.tree) throw new Error('本地 commit 解析失败（没有 tree 行）');

/* ---- 2. 远端当前 main，并确定基提交 ---- */
/* --onto <sha>：本地父提交不是远端 tip 时用（典型场景：上一轮已经用本通道推过一版、
   本地又 amend 过）。⚠ 只允许「就着远端当前 tip 往上盖」，不允许拿旧 tip 当基。 */
const ontoIdx = process.argv.indexOf('--onto');
const onto = ontoIdx !== -1 ? process.argv[ontoIdx + 1] : null;
const ref = await api(`/repos/${REPO}/git/ref/heads/main`);
console.log('远端 main =', ref.object.sha, '| 本地父提交 =', local.parent);
const base = onto || local.parent;
if (base !== ref.object.sha) {
  throw new Error(`基提交不是远端当前 tip（${base} != ${ref.object.sha}）—— 先弄清谁先推了，别硬来`);
}
/* diff-tree 要遍历父提交，父对象不在本地会直接 fatal → 先把缺的 adopt 回来 */
if (local.parent && !hasObject(local.parent)) {
  console.log('本地缺少父提交对象，先从远端 adopt：');
  await adopt(local.parent);
}
const rcommit = await api(`/repos/${REPO}/git/commits/${ref.object.sha}`);
console.log('远端 tree =', rcommit.tree.sha);

/* ---- 3. 本地 commit 相对父提交改动的文件 ---- */
const diff = git(['diff-tree', '-r', '--name-only', '-z', '--no-renames', '--no-commit-id', SHA]).toString('utf8');
const changed = diff.split('\0').filter(Boolean);
console.log('改动文件', changed.length, '个：', changed.map(s => JSON.stringify(s)).join(' '));
if (!changed.length) { console.log('没有改动，无需推送'); process.exit(0); }

const treeEntries = [];
for (const p of changed) {
  const meta = git(['ls-tree', '-z', SHA, '--', p]).toString('utf8').trim();
  const m = /^(\d+) (\w+) ([0-9a-f]{40})\t/.exec(meta);
  if (!m) throw new Error('ls-tree 解析失败: ' + p);
  const [, mode, , sha] = m;
  const content = git(['cat-file', 'blob', sha]);           // 已经是 git 清洗过（LF）的内容
  const blob = await api(`/repos/${REPO}/git/blobs`, 'POST', { content: content.toString('base64'), encoding: 'base64' });
  if (blob.sha !== sha) throw new Error(`blob SHA 不一致（${blob.sha} != ${sha}）：${p} —— 内容没 round-trip，中止`);
  treeEntries.push({ path: p, mode, type: 'blob', sha });
  console.log(`  blob ✓ ${p} (${content.length} B)`);
}

/* ---- 4. 在远端树上叠这些条目 ---- */
const tree = await api(`/repos/${REPO}/git/trees`, 'POST', { base_tree: rcommit.tree.sha, tree: treeEntries });
console.log('新 tree =', tree.sha, tree.truncated ? '⚠ truncated' : '');

/* ---- 5. 造 commit（author / committer / message 全照本地）---- */
const commit = await api(`/repos/${REPO}/git/commits`, 'POST', {
  message: local.message, tree: tree.sha, parents: [base],
  author: local.author, committer: local.committer,
});
console.log('新 commit =', commit.sha, '| 本地 =', SHA, commit.sha === SHA ? '✓ 与本地完全相同' : '（与本地 SHA 不同：父提交/时区写法/消息尾换行有差异，正常）');

/* ---- 6. 更新 main ---- */
const upd = await api(`/repos/${REPO}/git/refs/heads/main`, 'PATCH', { sha: commit.sha, force: false });
console.log('main 已更新 →', upd.object.sha);

/* ---- 7. 复核：远端 main 的 tree 必须等于本地 commit 的 tree ---- */
const verify = await api(`/repos/${REPO}/commits/main`);
console.log('复核：远端 main tree =', verify.commit.tree.sha, '| 本地 tree =', local.tree,
  verify.commit.tree.sha === local.tree ? '✓ 树一致（内容逐字节相同）' : '✗ 树不一致');
if (verify.commit.tree.sha !== local.tree) process.exit(1);

/* ---- 8. adopt 回本地并对齐引用 ---- */
console.log('\n把远端提交链 adopt 回本地：');
await adopt(commit.sha);
execFileSync('git', ['update-ref', 'refs/remotes/origin/main', commit.sha], { stdio: ['ignore', 'pipe', 'pipe'] });
execFileSync('git', ['update-ref', 'refs/heads/main', commit.sha], { stdio: ['ignore', 'pipe', 'pipe'] });
console.log('本地 main / origin/main 已对齐到', commit.sha);
console.log('\n全部完成。');
