/* 一次性脚本：github.com 主机被网络阻断时，用 GitHub Git Data API 推送已提交的 commit。
   用法：node scripts/_explore/_push_via_api.mjs <local-commit-sha>
   做法：读本地 commit 的 tree/author/committer/message → 在远端按同样数据重建
   blob/tree/commit → 更新 main 引用。因为输入与本地提交完全一致，产出的 commit SHA
   应当与本地 SHA 相同（父提交也相同），这本身就是最强的对账。
   ⚠ 只适用于「api.github.com 通、github.com 不通」这种单一主机被阻断的情况。 */
import { execFileSync } from 'node:child_process';

const REPO = 'Tsingyun/bili-weibo-dm-backup';
const API = 'https://api.github.com';
const SHA = process.argv[2];
if (!SHA) { console.error('用法: node _push_via_api.mjs <commit-sha>'); process.exit(2); }

const git = (args) => execFileSync('git', args, { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (!TOKEN) throw new Error('拿不到 gh token');

async function api(path, method = 'GET', body) {
  const r = await fetch(API + path, {
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
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

/* ---- 1. 本地提交的原始信息 ---- */
const raw = git(['cat-file', 'commit', SHA]).toString('utf8');
const head = raw.slice(0, raw.indexOf('\n\n'));
const lines = head.split('\n');
const treeLine = lines.find(l => l.startsWith('tree '));
const parentLine = lines.find(l => l.startsWith('parent '));
const authorLine = lines.find(l => l.startsWith('author '));
const committerLine = lines.find(l => l.startsWith('committer '));
const message = raw.slice(raw.indexOf('\n\n') + 2);
if (!treeLine || !authorLine || !committerLine) throw new Error('本地 commit 解析失败');
const parseWho = (l) => {                       // "author Name <mail> 1697000000 +0800"
  const m = /^(?:author|committer) (.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(l);
  if (!m) throw new Error('who 行解析失败: ' + l);
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
};
const local = {
  tree: treeLine.slice(5).trim(),
  parent: parentLine ? parentLine.slice(7).trim() : null,
  author: parseWho(authorLine), committer: parseWho(committerLine), message,
};

/* ---- 2. 远端当前 main ---- */
const ref = await api(`/repos/${REPO}/git/ref/heads/main`);
console.log('远端 main =', ref.object.sha, '| 本地父提交 =', local.parent);
if (ref.object.sha !== local.parent) {
  throw new Error(`远端 main 与本地父提交不一致（${ref.object.sha} != ${local.parent}）—— 先弄清谁先推了，别硬来`);
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
  const b64 = content.toString('base64');
  const blob = await api(`/repos/${REPO}/git/blobs`, 'POST', { content: b64, encoding: 'base64' });
  if (blob.sha !== sha) throw new Error(`blob SHA 不一致（${blob.sha} != ${sha}）：${p} —— 内容没 round-trip，中止`);
  treeEntries.push({ path: p, mode, type: 'blob', sha });
  console.log(`  blob ✓ ${p} (${content.length} B)`);
}

/* ---- 4. 在远端树上叠这些条目 ---- */
const tree = await api(`/repos/${REPO}/git/trees`, 'POST', { base_tree: rcommit.tree.sha, tree: treeEntries });
console.log('新 tree =', tree.sha, tree.truncated ? '⚠ truncated' : '');

/* ---- 5. 造 commit（author/committer/message 全照本地）---- */
const commit = await api(`/repos/${REPO}/git/commits`, 'POST', {
  message: local.message, tree: tree.sha, parents: [ref.object.sha],
  author: local.author, committer: local.committer,
});
console.log('新 commit =', commit.sha, '| 本地 =', SHA, commit.sha === SHA ? '✓ 完全一致' : '⚠ 与本地不同（时间戳/父亲差异，正常）');

/* ---- 6. 更新 main ---- */
const upd = await api(`/repos/${REPO}/git/refs/heads/main`, 'PATCH', { sha: commit.sha, force: false });
console.log('main 已更新 →', upd.object.sha);

/* ---- 7. 复核：远端 main 的 tree 必须等于本地 commit 的 tree ---- */
const verify = await api(`/repos/${REPO}/commits/main`);
console.log('复核：远端 main tree =', verify.commit.tree.sha, '| 本地 tree =', local.tree,
  verify.commit.tree.sha === local.tree ? '✓ 树一致' : '✗ 树不一致');
if (verify.commit.tree.sha !== local.tree) process.exit(1);
console.log('\n全部完成。');
