#!/usr/bin/env node
/**
 * 验证：导入的他人备份能在查看页里**真的用起来**（合成数据，不含任何私人内容）
 * ==============================================================
 * 为什么单独写这一个套件：
 *   现有回归全都跑在本机**内置**的两个会话上（key 恰好叫 weibo / bili），
 *   于是有两个只在「导入别人的备份」时才会暴露的缺陷长期没人覆盖：
 *
 *   ① `import_backup.mjs` 把 bundle 里的 messages.json（**裸数组**）原样
 *      透传成 messages.js —— 而查看页 `boot()` 读的是 `D.meta` / `D.messages`。
 *      裸数组的 `.messages` 是 undefined → 导入的会话在查看页里**一条都渲染不出来**
 *      （页面还好好地开着，只是空空如也，极其容易被当成「这份备份就是空的」）。
 *   ② 平台判定写成了 `SRC.key === 'bili'`。导入会话的 key 形如
 *      `tangshu_daniaigou_bili`，永远不等于 `bili` → 被当成**微博**处理 →
 *      分类改走文案匹配，B站 靠 `msg_source` / `media_type` 结构化判定的
 *      自动回复 / 系统通知 / 礼物提示全部判错。
 *
 * 这两个 bug 的共同点：**只在 key 不叫 bili 的 B站 会话上出现**。
 * 所以这里刻意造一个 key 叫 `synthbili_imp` 的 B站 导入会话，走完整链路
 * （合成 bundle → importBackup() → sessions.js → 查看页渲染）。
 *
 * 断言里的「分类对不对」不看颜色不看文案，看**统计面板报的数**和
 * 「隐藏自动回复」开关前后的条数差 —— 这两个都是页面上真实可见的量。
 *
 * ⚠ 全程合成数据：不读本机 data/ / bili/ 的内容，也不打印任何昵称 / uid。
 *   页面顶部的静态 <script> 仍会加载本机那两个文件（HTML 里写死的标签，
 *   绕不开），但**没有任何断言**落在它们身上。
 * ⚠ 本套件会临时改写项目根的 sessions.json / sessions.js 并在 `imported/`
 *   下建一个批次目录 —— 全部在 finally 里还原 / 删除（见文件末尾）。
 *
 * 跑法：
 *   NODE_PATH=<node workspace>/node_modules node scripts/_explore/verify_import_render.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadDep, rmTree } from './_deps.mjs';

const { chromium } = loadDep('playwright');
const ROOT = path.resolve(import.meta.dirname, '..', '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
function head(t) { console.log('\n' + t); }
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* ==============================================================
   0. 隔离：把会话清单指到一个临时文件
   --------------------------------------------------------------
   ⚠ `sessions.mjs` 的 MANIFEST_PATH 是在**模块加载时**求值的，
     所以必须先写 env、再动态 import —— 在文件顶部静态 import 会读到默认值。
   临时清单初始为空数组 → importBackup 只会往里加合成会话
   → 生成的 sessions.js 里只有它 → 页面加载快、断言也不会被本机数据干扰。
   ============================================================== */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-import-'));
const MANI = path.join(TMP, 'sessions.json');
fs.writeFileSync(MANI, JSON.stringify({ sessions: [] }), 'utf8');
process.env.DM_SESSIONS_JSON = MANI;

const REAL_JSON = path.join(ROOT, 'sessions.json');
const REAL_JS = path.join(ROOT, 'sessions.js');
const BAK_JSON = fs.existsSync(REAL_JSON) ? fs.readFileSync(REAL_JSON) : null;
const BAK_JS = fs.existsSync(REAL_JS) ? fs.readFileSync(REAL_JS) : null;

/* ==============================================================
   1. 合成一份 B站 备份包
   --------------------------------------------------------------
   8 条消息，每条都带 text（保证能渲染出来），分类只靠结构化字段区分 ——
   这样即使退化到微博的文案匹配分支，也**不可能**碰巧判对：
       3 条 count（文字 / 文字 / 表情）
       2 条 sys （media_type 5 撤回、10 官方通知）
       2 条 auto（msg_source 10 关键词、media_type 16 关注后推送）
       1 条 gift（media_type 13）
   ============================================================== */
const T0 = Date.UTC(2026, 0, 5, 2, 0, 0);          // 2026-01-05 10:00 (+08:00)
function mk(i, o) {
  const ts = T0 + i * 60000;
  return Object.assign({
    id: 900000 + i, seqno: 800000 + i, ts,
    time: new Date(ts).toISOString(),
    from: (i % 2) ? 'peer' : 'me', sender: '',
    type: 'text', media_type: 1, msg_source: 1,
    recalled: 0, text: '合成消息 · 分类探针 ' + (i + 1),
    images: [], links: [], card: null,
  }, o);
}
const MSGS = [
  mk(0),                                                        // count
  mk(1),                                                        // count
  mk(2, { type: 'emoji', media_type: 6, from: 'peer' }),        // count
  mk(3, { media_type: 5, from: 'me' }),                         // sys  撤回
  mk(4, { media_type: 10, msg_source: 6, from: 'peer' }),       // sys  官方通知
  mk(5, { msg_source: 10, from: 'peer' }),                      // auto 关键词
  mk(6, { media_type: 16, from: 'peer' }),                      // auto 关注后推送
  mk(7, { media_type: 13, from: 'peer' }),                      // gift
];
const WANT = { total: 8, count: 3, sys: 2, auto: 2, gift: 1 };

const BUNDLE = path.join(TMP, 'bundle');
fs.mkdirSync(BUNDLE, { recursive: true });
fs.writeFileSync(path.join(BUNDLE, 'manifest.json'), JSON.stringify({
  format: 'dm-archive-backup',
  sessions: [{ dir: '.', key: 'imp', label: '合成B站备份', platform: 'bili', records: MSGS.length }],
}), 'utf8');
/* ⚠ bundle 里的 messages.json 按导出器口径是**裸数组**，meta 单独放一份 ——
   这正是修复前会被原样透传成 .js 的形状。 */
fs.writeFileSync(path.join(BUNDLE, 'messages.json'), JSON.stringify(MSGS), 'utf8');
fs.writeFileSync(path.join(BUNDLE, 'meta.json'), JSON.stringify({
  peer_name: '合成对方', self_name: '合成我', total: MSGS.length,
}), 'utf8');

/* ---------- 工具 ---------- */
/* ⚠ sessions.js 开头有一段「本文件自动生成」的注释，所以不能用 ^ 锚定；
   这里从 `window.X =` 贪心吃到最后一个 `;`（JSON 内部不会有裸分号）。 */
const parseGlobalJs = (txt) => {
  const m = txt.match(/window\.([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*);\s*$/);
  if (!m) return null;
  try { return { name: m[1], value: JSON.parse(m[2]) }; } catch { return { name: m[1], value: null, bad: true }; }
};
const numIn = (txt, re) => {
  const m = String(txt).match(re);
  return m ? Number(String(m[1]).replace(/,/g, '')) : null;
};

/** 清理（含告警文案）：删不掉只提示，绝不把套件拖红 —— 见 `_deps.mjs` 的 rmTree */
function clean(p, label) {
  if (rmTree(p)) return;
  console.log('  ⚠ 清理未完成（' + label + '）：本回合删除配额被前面的套件用完了（宿主 safe-delete shim）');
  console.log('    残留 ' + p + ' —— 在 `imported/` 下、已被 gitignore，不影响仓库；');
  console.log('    单独再跑一次本套件会先清掉它（那时配额是新的）。');
}

let browser = null, srv = null, batch = null;

async function main() {
  const { importBackup } = await import('../lib/import_backup.mjs');

  /* 上一轮要是崩在清理阶段，会留一个 imported/synthbili —— 先清掉，
     否则 uniqueBatch() 会把这一轮改成 synthbili-2，残留永远躺着。 */
  clean(path.join(ROOT, 'imported', 'synthbili'), '上轮残留');

  head('§1 导入落盘（合成包 → imported/<批次>）');
  const res = await importBackup({ srcPath: BUNDLE, name: 'synthbili', label: '合成B站备份' });
  batch = res.batch;
  ok('导入成功并建了批次目录', !!batch && fs.existsSync(path.join(ROOT, 'imported', batch)));
  ok('登记了 1 个会话', res.sessions.length === 1, res.sessions.length);

  const one = res.sessions[0];
  const KEY = one.key;
  ok('会话条数 == 合成条数', one.records === WANT.total, one.records);
  ok('平台识别为 bili', one.platform === 'bili', one.platform);
  /* 这条是 bug ② 的触发条件本身：key 不叫 bili。写死断言，别让它悄悄变回去。 */
  ok('key 不是 "bili"（正是触发 bug 的形状）', KEY !== 'bili', KEY);
  ok('导入会话带 imported / readonly 保护', (() => {
    const m = JSON.parse(fs.readFileSync(MANI, 'utf8'));
    const s = m.sessions.find((x) => x.key === KEY);
    return !!s && s.imported === true && s.readonly === true;
  })());

  head('§2 bug ①：messages.js 必须是 {meta, messages} 对象形状');
  const dirAbs = path.join(ROOT, 'imported', batch);
  const jsPath = path.join(dirAbs, 'messages.js');
  ok('生成了 messages.js', fs.existsSync(jsPath));
  const parsed = parseGlobalJs(fs.readFileSync(jsPath, 'utf8'));
  ok('能解析成 `window.<名> = <JSON>`', !!parsed && !parsed.bad);
  ok('不是裸数组（Array.isArray === false）', !!parsed && !Array.isArray(parsed.value));
  ok('有 .messages 且是数组', !!parsed && Array.isArray(parsed.value && parsed.value.messages));
  ok('.messages 长度 == ' + WANT.total, !!parsed && (parsed.value.messages || []).length === WANT.total,
    parsed && (parsed.value.messages || []).length);
  ok('有 .meta 且带 total', !!parsed && parsed.value.meta && parsed.value.meta.total === WANT.total);
  ok('meta 补出了时间范围', !!parsed && !!parsed.value.meta.first_time && !!parsed.value.meta.last_time);
  /* bundle 里的 .json 必须保持裸数组 —— 导入端条数统计 / build_fts / audit_gaps 都按数组读 */
  const inBundle = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'messages.json'), 'utf8'));
  ok('bundle 内 messages.json 仍是裸数组（没被改写）', Array.isArray(inBundle) && inBundle.length === WANT.total);
  ok('另外三个包装文件也生成了', ['faces.js', 'ocr.js', 'vlm.js']
    .every((f) => fs.existsSync(path.join(dirAbs, f))));

  head('§3 bug ②：sessions.js 必须把 platform 带出去');
  /* 导入必须顺带重建 sessions.js —— 少了这一步，查看页顶上不会出现这个会话。
     本项目里这一步是 importBackup 内部 spawn 的，返回 'ok' 才算真跑成功。 */
  ok('importBackup 触发了 sessions.js 重建', res.sessionsJs === 'ok', res.sessionsJs);
  const sj = parseGlobalJs(fs.readFileSync(REAL_JS, 'utf8'));
  ok('sessions.js 能解析', !!sj && Array.isArray(sj.value));
  ok('清单里只有合成会话（隔离生效）', !!sj && sj.value.length === 1, sj && sj.value.length);
  const entry = (sj && sj.value || []).find((s) => s.key === KEY) || {};
  ok('会话条目带 platform=bili', entry.platform === 'bili', entry.platform);
  ok('会话条目带 dir / globals / files', !!entry.dir && !!entry.globals && !!entry.files);
  ok('非内置会话 → 由页面动态注入脚本', entry.builtin === false && !!entry.files.messages);

  head('§4 浏览器：渲染 + 分类口径（真实 Chromium）');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8' };
  /* ⚠ 必须 resolve 归一化：path.join 在 Windows 上产出反斜杠，
     而静态服务的 startsWith(ROOT) 是字符串前缀比较 → 不归一化会全部 403 */
  const ROOT_N = path.resolve(ROOT);
  srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    /* ⚠ 别写成 '.' + u —— 那会拼出 `ROOT/.查看备份.html`（前面多一个点）→ 全站 404。
       同时必须 resolve 归一化：path.join 在 Windows 上产出反斜杠，
       而下面的 startsWith(ROOT_N) 是字符串前缀比较 → 不归一化会全部 403。 */
    const p = u ? path.resolve(ROOT_N, u) : ROOT_N;
    if (p !== ROOT_N && !p.startsWith(ROOT_N + path.sep)) { res.writeHead(403); res.end('no'); return; }
    fs.readFile(p, (e, d) => {
      if (e) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
      res.end(d);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const URL_ = 'http://127.0.0.1:' + srv.address().port + '/查看备份.html';

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(URL_, { waitUntil: 'load' });
  const ready = await page.waitForFunction(
    () => document.querySelectorAll('#chat .msg[data-ai]').length > 0, null, { timeout: 20000 },
  ).then(() => true).catch(() => false);
  if (!ready) {
    console.log('  ⚠ 诊断：' + JSON.stringify(await page.evaluate(() => ({
      sessions: (window.DM_SESSIONS || []).map((s) => s.key),
      chatText: ((document.getElementById('chat') || {}).innerText || '').slice(0, 120),
    }))));
    console.log('  ⚠ 页面错误：' + errs.slice(0, 5).join(' | '));
  }

  const countMsg = () => page.evaluate(() => document.querySelectorAll('#chat .msg[data-ai]').length);
  const swBtns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#srcSw button[data-src]')).map((b) => b.dataset.src));
  ok('顶部切换条只有合成会话', swBtns.length === 1 && swBtns[0] === KEY, swBtns.join(','));
  ok('渲染出 ' + WANT.total + ' 条', (await countMsg()) === WANT.total, await countMsg());
  ok('皮肤跟着 platform 走（data-skin=bili）',
    (await page.evaluate(() => document.documentElement.getAttribute('data-skin'))) === 'bili');
  ok('页面里的数据全局量不是裸数组', await page.evaluate((k) => {
    const g = 'DM_DATA_' + k.toUpperCase();
    return !Array.isArray(window[g]) && Array.isArray((window[g] || {}).messages);
  }, KEY));

  /* 统计面板：B站 口径文案里会出现 msg_source（微博口径没有这个词）——
     这是「platform 真的生效了」最直接的一手证据。 */
  await page.click('#statBtn');
  await page.waitForSelector('#stat.on', { timeout: 5000 });
  const cal = await page.evaluate(() => (document.getElementById('caliber') || {}).innerText || '');
  ok('统计口径走的是 B站 结构化分支（提到 msg_source）', /msg_source/.test(cal));
  ok('自动回复 ' + WANT.auto + ' 条',
    numIn(cal, /自动回复 \/ 自动消息：(\d[\d,]*) 条/) === WANT.auto,
    numIn(cal, /自动回复 \/ 自动消息：(\d[\d,]*) 条/));
  ok('系统通知与撤回 ' + WANT.sys + ' 条',
    numIn(cal, /系统通知与撤回提示：(\d[\d,]*) 条/) === WANT.sys,
    numIn(cal, /系统通知与撤回提示：(\d[\d,]*) 条/));
  ok('其它非双方消息 ' + WANT.gift + ' 条',
    numIn(cal, /其它非双方消息：(\d[\d,]*) 条/) === WANT.gift,
    numIn(cal, /其它非双方消息：(\d[\d,]*) 条/));
  await page.click('#statClose');

  /* 「隐藏自动回复」开关：直接量出被判成 auto 的条数。
     如果退回微博的文案匹配分支，这里会是 0（合成文本不可能撞上自动回复文案）。 */
  await page.click('#autoChip');
  const afterHide = await countMsg();
  ok('隐藏自动回复后剩 ' + (WANT.total - WANT.auto) + ' 条（说明判出了 ' + WANT.auto + ' 条 auto）',
    afterHide === WANT.total - WANT.auto, afterHide);
  await page.click('#autoChip');
  ok('再点回来恢复 ' + WANT.total + ' 条', (await countMsg()) === WANT.total);

  head('§5 反向验证：把 messages.js 换回「裸数组」旧形状，页面必须渲染 0 条');
  const good = fs.readFileSync(jsPath, 'utf8');
  const gname = parseGlobalJs(good).name;
  fs.writeFileSync(jsPath, 'window.' + gname + ' = ' + JSON.stringify(MSGS) + ';\n', 'utf8');
  await page.reload({ waitUntil: 'load' });
  const broken = await countMsg();
  ok('裸数组形状 → 一条都渲染不出来（bug 复现）', broken === 0, broken);
  fs.writeFileSync(jsPath, good, 'utf8');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#chat .msg', { timeout: 20000 });
  ok('还原后回到 ' + WANT.total + ' 条', (await countMsg()) === WANT.total, await countMsg());
}

try {
  await main();
} catch (e) {
  fail++;
  console.log('\n  ❌ 未捕获异常 → ' + ((e && e.stack) || e));
} finally {
  if (browser) { try { await browser.close(); } catch {} }
  if (srv) { try { srv.close(); } catch {} }
  /* 还原项目根的 sessions.json / sessions.js（逐字节比对，不静默留下脏状态） */
  for (const [p, bak] of [[REAL_JSON, BAK_JSON], [REAL_JS, BAK_JS]]) {
    if (bak === null) { if (fs.existsSync(p)) fs.unlinkSync(p); continue; }
    fs.writeFileSync(p, bak);
    if (sha(fs.readFileSync(p)) !== sha(bak)) console.log('  ⚠ 还原失败：' + path.basename(p));
  }
  /* 删掉合成批次目录 + 临时目录（清理失败只告警，不影响 exit code） */
  if (batch) clean(path.join(ROOT, 'imported', batch), '合成批次目录');
  clean(TMP, '临时目录');
}

console.log('\n=== 结果 ===');
console.log('  通过 ' + pass + ' / 失败 ' + fail + '（合计 ' + (pass + fail) + '）');
console.log('  断言总数请对上：' + (pass + fail));
process.exit(fail ? 1 : 0);
