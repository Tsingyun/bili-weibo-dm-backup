/**
 * WebUI 端到端回归（2026-09-21）
 * ================================================================
 * 跑法：node scripts/_explore/verify_webui.mjs
 *
 * 为什么是「真起一个服务端、真发 HTTP 请求」，而不是直接 import 那些模块：
 *   这一层的风险几乎全在**边界**上 —— CSRF 守卫有没有漏、路径穿越挡没挡住、
 *   过滤器有没有被 HTTP 层吃掉、导出完的文件能不能原样下载回来、
 *   导入别人的包会不会污染本机 sessions.json。这些都只有在真跑一遍时才暴露。
 *   直接调 `collect()` 再断言，等于把要测的那一层（HTTP + 守卫 + 序列化）绕开了。
 *
 * 三类容易被自己骗过去的地方，改这个脚本前先看：
 *   1. **只断言 200 是不够的**。写接口不加 `X-DM-WebUI` 必须 403，
 *      但反过来「加了头却被拒」也说明守卫写歪了 —— 两个方向都要测。
 *   2. **导出要断言「内容」而不只是「文件存在」**。记录条数一律和进程内
 *      `collect()` 的口径对账，而不是写死数字（数据一更新就假失败）。
 *   3. **导入测试会真的改写 sessions.json**。脚本开头备份、finally 还原，
 *      中途崩了也不会留下一个假的"导入会话"混进用户的查看页。
 *
 * ⚠ 白天边界（05:00）那一段用**纯 Date 算术独立复算**，不复用 msg_kind.mjs，
 *   否则等于拿被测函数验证自己。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeZip, readZipFile } from '../lib/zip.mjs';
import { collect } from '../lib/export_engine.mjs';
import { loadSessions, MANIFEST_PATH } from '../sessions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TMP = path.join(HERE, '_tmp', 'webui');
const EXPORT_PREFIX = 'wbtest-';

const pass = [], fail = [];
const chk = (ok, label, extra) => {
  (ok ? pass : fail).push(label);
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  → ' + String(extra).slice(0, 200) : ''));
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================
   0. 起服务端（自己挑一个空闲端口，跑完杀掉）
   ================================================================ */
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function req(port, method, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, opts.headers || {});
    let body = null;
    if (opts.json !== undefined) {
      body = Buffer.from(JSON.stringify(opts.json), 'utf8');
      headers['Content-Type'] = 'application/json';
    } else if (opts.raw) {
      body = Buffer.isBuffer(opts.raw) ? opts.raw : Buffer.from(opts.raw);
    }
    if (body) headers['Content-Length'] = body.length;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, buf, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const H = { 'X-DM-WebUI': '1' };                      // 写接口必需的自家头

const PORT = await freePort();
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'server.mjs'), '--port', String(PORT)],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
child.stdout.on('data', (d) => { serverOut += d; });
child.stderr.on('data', (d) => { serverOut += d; });

/* 先扫掉上一次被强杀留下的探针残迹 ——
   否则"开头备份"会把残迹当成原始状态，结尾一比对就永远不相等（假红）。
   （进程被 SIGTERM 杀掉时 try/finally 是不会跑的，所以这一步必须在开头做。） */
try {
  const m0 = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const n0 = (m0.sessions || []).length;
  m0.sessions = (m0.sessions || []).filter((s) => s.key !== 'wbtest_forceprobe');
  if (m0.sessions.length !== n0) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m0, null, 2), 'utf8');
    console.log('  [!] 已清掉上次遗留的探针会话 wbtest_forceprobe');
  }
  fs.rmSync(path.join(ROOT, '_wbtest_forceprobe'), { recursive: true, force: true });
} catch { /* 没有就算了 */ }

/* 备份 sessions.json —— 导入测试会写它，一定要还回去 */
const MANIFEST_BAK = path.join(TMP, 'sessions.json.bak');
fs.mkdirSync(TMP, { recursive: true });
const hadManifest = fs.existsSync(MANIFEST_PATH);
if (hadManifest) fs.copyFileSync(MANIFEST_PATH, MANIFEST_BAK);

/* 跑之前先记下 imported/ 里已经有什么 —— 导入测试会往里写目录，
   收尾按「差集」把本次新增的删掉（不能只靠 sessions.json 里还挂着 importBatch，
   原因见 finally 里那段说明）。 */
const IMPORTED_DIR = path.join(ROOT, 'imported');
const importedBefore = new Set(fs.existsSync(IMPORTED_DIR) ? fs.readdirSync(IMPORTED_DIR) : []);

let importedBatch = null;                             // 万一中途失败，finally 里兜底删

try {
  /* 等服务端就绪 */
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await req(PORT, 'GET', '/api/state'); up = r.status === 200; } catch { /* 还没起 */ }
    if (!up) await sleep(250);
  }
  if (!up) {
    console.log('服务端没起来，输出如下：\n' + serverOut);
    console.log('（提示：某些端口会被系统保留/沙箱拦下，server.mjs 会自动往后找；'
      + '真正的端口看上面输出的「地址」那一行）');
    process.exit(2);
  }
  section('0. 服务端启动');
  chk(true, '服务端在 127.0.0.1:' + PORT + ' 就绪');
  chk(child.exitCode === null, '进程仍存活');
  chk(serverOut.includes('127.0.0.1'), '启动横幅里有本机地址', serverOut.split('\n').find((l) => l.includes('地址')) || '');
  chk(serverOut.includes('只监听本机回环地址'), '明确声明只监听回环');

  /* ================================================================
     1. 静态资源与目录穿越
     ================================================================ */
  section('1. 静态资源（含穿越防护）');
  const home = await req(PORT, 'GET', '/');
  chk(home.status === 200 && /text\/html/.test(home.headers['content-type']), 'GET / 返回 HTML', home.status);
  chk(/步骤|step/i.test(home.text) && /app\.js/.test(home.text), '首页含步骤导航并加载 app.js');
  chk(/环境检查[\s\S]*授权登录[\s\S]*选择会话[\s\S]*导出/.test(home.text),
    '★ 七步引导都在（环境→登录→会话→备份→导入→导出→维护）');

  const css = await req(PORT, 'GET', '/style.css');
  chk(css.status === 200 && /text\/css/.test(css.headers['content-type']) && css.buf.length > 800,
    'style.css 正常返回', css.status + ' / ' + css.buf.length + 'B');

  const js = await req(PORT, 'GET', '/app.js');
  chk(js.status === 200 && /javascript/.test(js.headers['content-type']) && js.buf.length > 5000,
    'app.js 正常返回', js.status + ' / ' + js.buf.length + 'B');
  chk(/X-DM-WebUI/.test(js.text), '★ 前端确实带上了 X-DM-WebUI 头（否则写接口全 403）');
  chk(!/if\s+[A-Za-z_$][\w$]*\s*\(\s*\)\s*;/.test(js.text), '★ app.js 里没有 `if fn();` 这种残缺判断');

  const viewer = await req(PORT, 'GET', '/viewer');
  chk(viewer.status === 200 && /text\/html/.test(viewer.headers['content-type']), '/viewer → 查看备份.html');

  const trav = await req(PORT, 'GET', '/webui/%2e%2e%2f%2e%2e%2f' + encodeURIComponent('使用说明.md'));
  chk(trav.status === 403 || trav.status === 404, '★ 编码穿越 /webui/../../ 被挡住', trav.status);
  const trav2 = await req(PORT, 'GET', '/' + encodeURIComponent('使用说明.md'));
  chk(trav2.status === 404, '不在白名单里的文件读不到（404）', trav2.status);
  const trav3 = await req(PORT, 'GET', '/scripts/server.mjs');
  chk(trav3.status === 404, 'scripts/ 不在静态白名单里', trav3.status);

  /* ================================================================
     2. /api/state
     ================================================================ */
  section('2. 状态接口');
  const st = await req(PORT, 'GET', '/api/state');
  chk(st.status === 200 && st.json && st.json.ok, '/api/state 可用', st.status);
  const S0 = st.json || {};
  chk(S0.root === ROOT, 'root 指向工作区', S0.root);
  chk(!!S0.env && typeof S0.env === 'object', 'env 存在');
  chk(typeof S0.configError === 'string' || S0.configError === null, 'configError 字段类型正确', String(S0.configError));
  chk(Array.isArray(S0.sessions) && S0.sessions.length >= 2, '★ 至少曝光 weibo / bili 两个会话', (S0.sessions || []).length);
  chk((S0.sessions || []).every((s) => s.key && s.label && s.platform), '每个会话都有 key/label/platform');
  chk((S0.sessions || []).filter((s) => !s.imported).every((s) => s.login && typeof s.login.loggedIn === 'boolean'),
    '★ 非导入会话都带登录态（前端第 2 步要用）');
  chk((S0.sessions || []).filter((s) => !s.imported).every((s) => s.login && 'hasSavedCookie' in s.login),
    '登录态里含 hasSavedCookie');
  chk(typeof S0.env.running === 'boolean', 'env.running 是布尔（前端靠它决定是否轮询）');
  chk(typeof S0.port === 'number', 'port 有值', S0.port);

  /* ================================================================
     3. CSRF / 方法守卫
     ================================================================ */
  section('3. CSRF 守卫（两个方向都要测）');
  const noHdr = await req(PORT, 'POST', '/api/job/kill', { json: { id: 'x' } });
  chk(noHdr.status === 403 && /X-DM-WebUI/.test(noHdr.text), '★ 不带自家头 → 403', noHdr.status);

  const evil = await req(PORT, 'POST', '/api/job/kill', { json: { id: 'x' }, headers: Object.assign({}, H, { Origin: 'http://evil.example' }) });
  chk(evil.status === 403 && /跨站/.test(evil.text), '★ 跨站 Origin → 403', evil.status);

  const okLocal = await req(PORT, 'POST', '/api/job/kill', { json: { id: 'nope' }, headers: Object.assign({}, H, { Origin: 'http://127.0.0.1:' + PORT }) });
  chk(okLocal.status === 200 && okLocal.json && okLocal.json.ok === false, '★ 同源 + 自家头 → 放行（假 id 返回 ok:false）', okLocal.status);
  const okLocalhost = await req(PORT, 'POST', '/api/job/kill', { json: { id: 'nope' }, headers: Object.assign({}, H, { Origin: 'http://localhost:' + PORT }) });
  chk(okLocalhost.status === 200, 'localhost 也算同源', okLocalhost.status);
  const badOrigin = await req(PORT, 'POST', '/api/job/kill', { json: {}, headers: Object.assign({}, H, { Origin: 'not-a-url' }) });
  chk(badOrigin.status === 403, 'Origin 不是合法 URL → 403', badOrigin.status);

  const put = await req(PORT, 'PUT', '/api/state', { headers: H });
  chk(put.status === 405 || put.status === 403, '非 GET/POST 方法被拒', put.status);
  const postUnknown = await req(PORT, 'POST', '/api/nope', { json: {}, headers: H });
  chk(postUnknown.status === 404, '未知 POST 接口 → 404', postUnknown.status);

  /* ================================================================
     4. 只读列表接口
     ================================================================ */
  section('4. 列表 / 日志接口');
  const exps = await req(PORT, 'GET', '/api/exports');
  chk(exps.status === 200 && Array.isArray(exps.json.files), '/api/exports 返回列表');
  chk((exps.json.files || []).every((f) => f.rel && f.human !== undefined), '导出列表每项含 rel/human');

  const imp = await req(PORT, 'GET', '/api/imported');
  chk(imp.status === 200 && Array.isArray(imp.json.batches), '/api/imported 返回批次列表');

  const jobs0 = await req(PORT, 'GET', '/api/jobs');
  chk(jobs0.status === 200 && Array.isArray(jobs0.json.jobs), '/api/jobs 返回列表');

  const logins = await req(PORT, 'GET', '/api/login/status?session=weibo');
  chk(logins.status === 200 && logins.json.status && 'loggedIn' in logins.json.status,
    '/api/login/status 可用', logins.status);
  const loginBad = await req(PORT, 'GET', '/api/login/status?session=' + encodeURIComponent('不存在的会话'));
  chk(loginBad.status === 400, '未知会话的登录态查询 → 400', loginBad.status);

  /* ---- 登录态必须是「真校验」的结果，不能只看本地有没有 Cookie 文件 ---- */
  const ls = (logins.json || {}).status || {};
  chk('verified' in ls && 'invalidReason' in ls && 'account' in ls,
    '★ 登录态带真校验字段（verified / invalidReason / account）', JSON.stringify(ls).slice(0, 160));
  chk(ls.loggedIn === (ls.verified === true),
    '★ loggedIn 与接口校验结果一致（不再"文件里有 SUB= 就算已登录"）',
    'loggedIn=' + ls.loggedIn + ' verified=' + ls.verified);
  if (ls.loggedIn) {
    chk(!!ls.account, '★ 已登录时能报出登录账号', ls.account);
  } else {
    chk(ls.invalidReason === 'expired' || ls.invalidReason === 'no-cookie' || ls.invalidReason === 'network',
      '未登录时说清是"过期 / 没有 / 连不上"中的哪一种', ls.invalidReason);
  }
  const loginFresh = await req(PORT, 'GET', '/api/login/status?session=weibo&fresh=1');
  chk(loginFresh.status === 200 && 'loggedIn' in (loginFresh.json.status || {}),
    '★ ?fresh=1 能跳过缓存重新校验', loginFresh.status);
  const loginRefresh = await req(PORT, 'POST', '/api/login/refresh', { headers: H, json: {} });
  chk(loginRefresh.status === 200 && loginRefresh.json.ok === true,
    '/api/login/refresh 能清掉登录态缓存', loginRefresh.status);

  /* ---- 未登录时，需要登录的步骤必须在**起任务之前**就被拦下（401） ---- */
  // 从 state 里挑一个"当前确实没登录、且不是网络问题"的会话 —— 没有就跳过这组断言
  const cand = ((S0.sessions) || []).find((s) => !s.imported && s.login &&
    s.login.loggedIn === false && s.login.invalidReason !== 'network');
  const notLogged = cand ? cand.key : null;
  if (notLogged) {
    const runBlocked = await req(PORT, 'POST', '/api/run', { headers: H, json: { session: notLogged, step: 'fetch' } });
    chk(runBlocked.status === 401, '★ 未登录跑「抓取」→ 401 拦下（不再起了任务才失败）',
      runBlocked.status + ' ' + (runBlocked.json || {}).error);
    chk(/登录/.test(String((runBlocked.json || {}).error || '')),
      '401 的提示里说了要先去登录', (runBlocked.json || {}).error);
    const fetchBlocked = await req(PORT, 'POST', '/api/fetch', { headers: H, json: { sessions: [notLogged] } });
    chk(fetchBlocked.status === 401, '★ 未登录点「备份」→ 401 拦下', fetchBlocked.status);
    const docOk = await req(PORT, 'POST', '/api/run', { headers: H, json: { session: notLogged, step: 'doctor' } });
    chk(docOk.status === 200, '不需要登录的步骤（体检）不该被 401 挡住', docOk.status);
    if (docOk.json && docOk.json.job) {
      await req(PORT, 'POST', '/api/job/kill', { headers: H, json: { id: docOk.json.job.id } });
    }
  } else {
    console.log('  [跳过] 当前没有「确定未登录」的平台，401 拦截断言本次不测');
  }

  /* ---- login.mjs 的判定口径：空 Cookie 必须报 no-cookie，不能报"已登录" ---- */
  const LG = await import(pathToFileURL(path.join(ROOT, 'scripts', 'login.mjs')).href);
  const vEmpty = await LG.verifyCookie({ platform: 'weibo' }, '');
  chk(vEmpty.ok === false && vEmpty.reason === 'no-cookie',
    '★ 没有 Cookie 时报 no-cookie（不是"已登录"）', JSON.stringify(vEmpty));
  const vJunk = await LG.verifyCookie({ platform: 'weibo' }, 'SUB=deadbeef; SUBP=xxx');
  chk(vJunk.reason === 'expired' || vJunk.reason === 'network',
    '★ 伪造/过期的 Cookie 不会被判成有效', vJunk.reason);
  const stNoVerify = await LG.statusFor({ key: 'x', platform: 'weibo', dir: 'data' }, { verify: false });
  chk('loggedIn' in stNoVerify && 'verified' in stNoVerify,
    'statusFor 关掉校验时仍有完整字段（退化为"形状像"）', JSON.stringify(stNoVerify).slice(0, 120));

  /* ---- 前端：点登录按钮**不能**再跳到第 4 步（那正是"点了没反应/跳错页"的由来） ---- */
  const appSrc = fs.readFileSync(path.join(ROOT, 'webui', 'app.js'), 'utf8');
  const mStart = appSrc.match(/async function startLogin\([\s\S]*?\n}\n/);
  chk(!!mStart, '能从 app.js 里定位到 startLogin 函数');
  if (mStart) {
    chk(!/showStep\(4\)/.test(mStart[0]),
      '★ startLogin 里不再有 showStep(4)（登录就停在第 2 步）');
    chk(/force/.test(mStart[0]) && /\/api\/login/.test(mStart[0]),
      'startLogin 会把 force 传给 /api/login');
  }
  chk(/data-force=/.test(appSrc), '★ 登录按钮带 data-force（已登录时走强制重登）');
  chk(/重新登录（清除旧登录态）/.test(appSrc), '★ 已登录时按钮文案是「重新登录（清除旧登录态）」');

  const jobNo = await req(PORT, 'GET', '/api/job?id=zzz');
  chk(jobNo.status === 404, '未知任务 → 404', jobNo.status);
  const streamNo = await req(PORT, 'GET', '/api/job/stream?id=zzz');
  chk(streamNo.status === 404, '未知任务的日志流 → 404', streamNo.status);

  /* ================================================================
     5. 预览：过滤口径必须和进程内一致
     ================================================================ */
  section('5. 导出预览（口径对账）');
  const pv = await req(PORT, 'GET', '/api/preview?sessions=weibo&limit=5');
  chk(pv.status === 200 && pv.json.ok, '/api/preview 可用', pv.status + (pv.json && pv.json.warnings ? ' / warnings=' + pv.json.warnings.length : ''));
  chk((pv.json.groups || []).every((g) => g.shown <= 5), 'limit 生效：每组不超过 5 条',
    (pv.json.groups || []).map((g) => g.shown).join(','));
  chk((pv.json.groups || []).every((g) => g.rows.length === g.shown), 'rows 长度与 shown 自洽');

  const ref5 = collect({ sessions: ['weibo'], limit: 5 });
  chk(JSON.stringify((pv.json.groups || []).map((g) => [g.key, g.shown])) ===
      JSON.stringify(ref5.groups.map((g) => [g.session.key, g.rows.length])),
    '★ HTTP 预览条数 == 进程内 collect() 条数（HTTP 层没吃掉 limit）',
    JSON.stringify((pv.json.groups || []).map((g) => [g.key, g.shown])));

  const pvKind = await req(PORT, 'GET', '/api/preview?sessions=weibo&kinds=count&limit=50');
  const kindRows = (pvKind.json.groups || []).flatMap((g) => g.rows);
  chk(kindRows.length > 0, 'kinds=count 能筛出记录', kindRows.length);
  chk(kindRows.every((r) => r.kind === 'count'), '★ kinds 过滤真的生效（没有别的类型混进来）');

  const pvBad = await req(PORT, 'GET', '/api/preview?sessions=' + encodeURIComponent('不存在的会话'));
  chk(pvBad.status === 400, '未知会话的预览 → 400', pvBad.status);

  /* ---- 白天边界：用纯 Date 算术独立复算 ---- */
  const allSessions = loadSessions().filter((s) => !s.imported);
  const target = allSessions.find((s) => fs.existsSync(path.join(ROOT, s.dir, 'messages.json')));
  if (target) {
    const msgs = JSON.parse(fs.readFileSync(path.join(ROOT, target.dir, 'messages.json'), 'utf8'));
    const withTs = msgs.filter((m) => m && m.ts != null);
    // 挑一个真的落在某天 05:00 之后、次日 05:00 之前的日期（否则边界测不出东西）
    const DAY = '2026-03-08';
    const lo = new Date(DAY + 'T05:00:00').getTime();
    const hi = new Date('2026-03-09' + 'T05:00:00').getTime();
    const expect = withTs.filter((m) => m.ts >= lo && m.ts < hi).length;
    const pvDay = await req(PORT, 'GET',
      `/api/preview?sessions=${encodeURIComponent(target.key)}&since=${DAY}&until=${DAY}&limit=100000`);
    const got = (pvDay.json.groups || []).reduce((n, g) => n + g.rows.length, 0);
    chk(expect > 0, '★ 取样日 ' + DAY + ' 有数据（否则这条断言是空的）', expect + ' 条');
    chk(got === expect,
      '★ since=until=同一天 == 独立算出的 [05:00, 次日05:00) 条数（05:00 口径没被绕开）',
      'HTTP ' + got + ' / 独立算 ' + expect);
  } else {
    chk(false, '找不到任何有 messages.json 的会话，白天边界这条没测到');
  }

  /* ================================================================
     6. 导出：五种格式 + 下载 + 穿越
     ================================================================ */
  section('6. 导出（格式 / 内容 / 下载）');
  const refLimit = collect({ sessions: ['weibo'], limit: 3 });
  const refRows = refLimit.groups.reduce((n, g) => n + g.rows.length, 0);
  chk(refRows > 0, '参照样本非空（weibo 最近 3 条）', refRows + ' 条');

  const FORMATS = ['jsonl', 'json', 'csv', 'md', 'html', 'bundle'];
  const made = [];
  for (const fmt of FORMATS) {
    const r = await req(PORT, 'POST', '/api/export', {
      json: { sessions: ['weibo'], limit: 3, format: fmt, name: EXPORT_PREFIX + fmt, images: false },
      headers: H,
    });
    if (r.status !== 200 || !r.json || !r.json.ok) {
      chk(false, `导出 ${fmt} 成功`, r.status + ' ' + (r.text || '').slice(0, 120));
      continue;
    }
    const f = r.json.files[0];
    made.push(f);
    chk(!!f && fs.existsSync(f.path), `导出 ${fmt}：文件真的落盘了`, f && f.rel);
    chk(r.json.stats.records === refRows, `★ 导出 ${fmt}：记录数 == 预览口径`, r.json.stats.records + ' / ' + refRows);
    chk(r.json.format === fmt, `导出 ${fmt}：回执格式正确`, r.json.format);
    chk(!!f && f.size > 0, `导出 ${fmt}：文件非空`, f && f.human);
  }

  const bundle = made.find((f) => /\.zip$/i.test(f.name || ''));
  if (bundle) {
    const z = readZipFile(bundle.path);
    const names = z.map((e) => e.name);
    chk(names.includes('manifest.json'), '★ bundle 里有 manifest.json（导入端靠它认包）');
    chk(names.includes('先读我.md'), 'bundle 里有「先读我.md」（给收到包的人看的）');
    chk(names.some((n) => /messages\.(json|js)$/.test(n)), 'bundle 里有 messages.json/js');
    const mani = JSON.parse(z.find((e) => e.name === 'manifest.json').data.toString('utf8'));
    chk(mani.format === 'dm-archive-backup' && mani.version === 1, 'manifest.format/version 正确', mani.format);
    chk(mani.sessions.reduce((n, s) => n + s.records, 0) === refRows, '★ manifest 里记的条数 == 导出口径',
      mani.sessions.reduce((n, s) => n + s.records, 0) + ' / ' + refRows);
    chk(!z.some((e) => /(^|\/)\.\.\//.test(e.name)), '★ bundle 里没有 ../ 条目');
  } else {
    chk(false, '没产出 bundle 压缩包');
  }

  const dl = await req(PORT, 'GET', '/api/download?path=' + encodeURIComponent(made[0].rel));
  chk(dl.status === 200 && dl.headers['content-disposition'], '★ 导出的文件能下载回来',
    dl.status + ' / ' + dl.buf.length + 'B');
  chk(dl.buf.length === made[0].size, '下载字节数 == 磁盘大小', dl.buf.length + ' / ' + made[0].size);
  chk(/attachment/.test(dl.headers['content-disposition'] || ''), '下载带 attachment（不会在浏览器里打开）');

  const dlTrav = await req(PORT, 'GET', '/api/download?path=' + encodeURIComponent('../../使用说明.md'));
  chk(dlTrav.status === 400, '★ 下载接口拒绝 ../ 穿越', dlTrav.status);
  const dlAbs = await req(PORT, 'GET', '/api/download?path=' + encodeURIComponent('C:/Windows/win.ini'));
  chk(dlAbs.status === 400, '下载接口拒绝绝对路径', dlAbs.status);
  const dlMissing = await req(PORT, 'GET', '/api/download?path=' + encodeURIComponent('exports/没有这个文件.txt'));
  chk(dlMissing.status === 404, '不存在的文件 → 404', dlMissing.status);

  const exps2 = await req(PORT, 'GET', '/api/exports');
  chk((exps2.json.files || []).some((f) => f.name.startsWith(EXPORT_PREFIX)),
    '刚导出的文件出现在「最近导出」列表里');

  /* ================================================================
     7. 导入别人的备份
     ================================================================ */
  section('7. 加载他人备份（导入 → 只读 → 删除）');
  const day = (n) => new Date(2026, 2, n, 14, 0, 0).getTime();
  const fake = JSON.stringify([
    { id: 'a1', ts: day(1), from: 'peer', type: 'text', text: '这是一份外部备份的第一条' },
    { id: 'a2', ts: day(2), from: 'me', type: 'text', text: '第二条，手机号 13800138000 应被掩盖' },
    { id: 'a3', ts: day(3), from: 'peer', type: 'text', text: '第三条' },
  ]);
  const zipPath = path.join(TMP, 'shared-backup.zip');
  writeZip([
    { name: 'manifest.json', data: JSON.stringify({
      format: 'dm-archive-backup', version: 1, exportedAt: new Date().toISOString(),
      generator: 'test', sessions: [{ key: 'weibo', label: '外部分享', platform: 'weibo', dir: 'data', records: 3 }],
    }) },
    { name: 'data/messages.json', data: fake },
    { name: 'data/messages.js', data: 'window.DM_DATA = ' + fake + ';\n' },
    { name: 'data/meta.json', data: JSON.stringify({ peer_name: '外部对方', self_name: '外部自己' }) },
  ], zipPath);
  chk(fs.existsSync(zipPath) && fs.statSync(zipPath).size > 100, '构造出一份外部备份 zip', fs.statSync(zipPath).size + 'B');

  const upBad = await req(PORT, 'POST', '/api/import/upload', { raw: Buffer.alloc(0), headers: Object.assign({}, H, { 'X-DM-Filename': 'empty.zip' }) });
  chk(upBad.status === 400, '空上传 → 400', upBad.status);

  const upRes = await req(PORT, 'POST', '/api/import/upload', {
    raw: fs.readFileSync(zipPath),
    headers: Object.assign({}, H, { 'X-DM-Filename': encodeURIComponent('shared-backup.zip') }),
  });
  chk(upRes.status === 200 && upRes.json.ok, '★ 上传 zip 导入成功', upRes.status + ' ' + (upRes.text || '').slice(0, 160));
  if (upRes.json && upRes.json.ok) {
    importedBatch = upRes.json.batch;
    chk(!!importedBatch, '拿到批次名', importedBatch);
    chk(upRes.json.sessions.length === 1, '识别出 1 个会话', upRes.json.sessions.length);
    chk(upRes.json.sessions[0].records === 3, '★ 认出的条数 == 包里的 3 条', upRes.json.sessions[0].records);
    chk(upRes.json.sessions[0].platform === 'weibo', '平台识别正确', upRes.json.sessions[0].platform);
    chk(upRes.json.sessions[0].peerName === '外部对方', '★ 昵称从 meta.json 读出来（没写死）', upRes.json.sessions[0].peerName);

    const batchDir = path.join(ROOT, 'imported', importedBatch);
    chk(fs.existsSync(batchDir), '解包目录存在', 'imported/' + importedBatch);
    for (const w of ['messages.js', 'faces.js', 'ocr.js', 'vlm.js']) {
      chk(fs.existsSync(path.join(batchDir, 'data', w)), '★ 补齐了 ' + w + '（查看页只认 <script src>）');
    }
    const wrapped = fs.readFileSync(path.join(batchDir, 'data', 'messages.js'), 'utf8');
    chk(/^window\.[A-Za-z0-9_]+\s*=/.test(wrapped.trim()), '生成的 .js 是 window.DM_xx = 形式（能被查看页读）');

    const man = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const entry = (man.sessions || []).find((s) => s.importBatch === importedBatch);
    chk(!!entry, 'sessions.json 里登记了这条导入会话');
    chk(entry && entry.imported === true && entry.readonly === true, '★ 导入会话标了 imported/readonly', entry && (entry.imported + '/' + entry.readonly));
    chk(fs.existsSync(path.join(ROOT, 'sessions.js')), 'sessions.js 已重新生成');
    if (!entry) throw new Error('sessions.json 里没登记导入会话，后面的断言无法进行');
    const impKey = entry.key;

    const imp2 = await req(PORT, 'GET', '/api/imported');
    const b = (imp2.json.batches || []).find((x) => x.batch === importedBatch);
    chk(!!b, '导入批次出现在 /api/imported', importedBatch);
    chk(b && b.sessions.length === 1, '批次里有 1 个会话');
    chk(b && b.files >= 4, '批次文件数统计合理', b && b.files);

    const st2 = await req(PORT, 'GET', '/api/state');
    const impSess = (st2.json.sessions || []).find((s) => s.key === impKey);
    chk(!!impSess, '★ /api/state 里能看到导入的会话（页面切换栏会出现它）', impKey);
    chk(impSess && impSess.imported === true && impSess.readonly === true, 'state 里也标了只读');
    chk(impSess && !impSess.login, '★ 导入会话不查询登录态（不该拿本机登录态去套别人的包）');

    /* 只读：不能抓取 */
    const fetchImp = await req(PORT, 'POST', '/api/fetch', { json: { sessions: [impKey] }, headers: H });
    chk(fetchImp.status === 400 && /只读/.test(fetchImp.text), '★ 对导入会话发起抓取 → 400 拒绝', fetchImp.status);
    const runImp = await req(PORT, 'POST', '/api/run', { json: { session: impKey, step: 'fetch' }, headers: H });
    chk(runImp.status === 400, '对导入会话跑「抓取」步骤 → 400', runImp.status);

    /* 只读会话也能预览（用户要能翻别人的记录） */
    const pvImp = await req(PORT, 'GET', '/api/preview?sessions=' + encodeURIComponent(impKey) + '&limit=10');
    const impRows = (pvImp.json.groups || []).flatMap((g) => g.rows);
    chk(pvImp.status === 200 && impRows.length === 3, '★ 导入的备份能预览（3 条）', pvImp.status + ' / ' + impRows.length);
    chk(impRows.some((r) => r.text.includes('外部备份')), '预览里能看到导入的正文');

    /* 体检这条只读步骤：服务端放行、且应当真的能跑完 */
    const doctor = await req(PORT, 'POST', '/api/run', { json: { session: impKey, step: 'doctor' }, headers: H });

    chk(doctor.status === 200 && doctor.json.job, '导入会话允许跑体检（UI 承诺的能力）', doctor.status);
    if (doctor.status === 200) {
      const jid = doctor.json.job.id;
      let fin = null;
      for (let i = 0; i < 120; i++) {
        const jr = await req(PORT, 'GET', '/api/job?id=' + jid);
        if (jr.json && jr.json.job.status !== 'running') { fin = jr.json; break; }
        await sleep(500);
      }
      chk(!!fin, '★ 任务在 60 秒内结束（job 状态机能走到终态）', fin && fin.job.status);
      const lines = (fin && fin.lines) || [];
      chk(lines.length > 0, '★ 子进程输出被流回来了（日志不是空的）', lines.length + ' 行');
      chk(fin && fin.job.code !== 4,
        '★ 体检没被「导入=只读」直接 exit(4) 拦掉（run_pipeline 只挡会写的步骤）',
        fin && ('code=' + fin.job.code));
      const sj = await req(PORT, 'GET', '/api/job/stream?id=' + jid);
      chk(sj.status === 200 && /text\/event-stream/.test(sj.headers['content-type']),
        '★ 日志流是 text/event-stream（EventSource 接得上）', sj.status);
      chk(/^data: /m.test(sj.text) && /"t":"status"/.test(sj.text),
        '★ 流里既有 data: 行也有终态 status 帧');
    }
  } else {
    chk(false, '导入失败，后续导入断言跳过：' + (upRes.text || '').slice(0, 200));
  }

  /* 坏包：应当明确报错而不是造出一个空会话 */
  const badZip = path.join(TMP, 'not-a-backup.zip');
  writeZip([{ name: 'readme.txt', data: 'nothing here' }], badZip);
  const upBad2 = await req(PORT, 'POST', '/api/import/upload', {
    raw: fs.readFileSync(badZip), headers: Object.assign({}, H, { 'X-DM-Filename': 'not-a-backup.zip' }),
  });
  chk(upBad2.status === 400 && /messages/.test(upBad2.text), '★ 不像备份的包 → 400 并说清原因', upBad2.text.slice(0, 120));
  const manAfterBad = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  chk(!(manAfterBad.sessions || []).some((s) => s.importBatch === 'not-a-backup'),
    '★ 坏包没有污染 sessions.json（失败不留残迹）');

  const notFound = await req(PORT, 'POST', '/api/import', { json: { path: 'D:/绝对不存在的路径.zip' }, headers: H });
  chk(notFound.status === 400 && /找不到/.test(notFound.text), '路径不存在 → 400 并说清原因', notFound.status);

  /* 删除批次 */
  if (importedBatch) {
    const batchDir = path.join(ROOT, 'imported', importedBatch);
    const del = await req(PORT, 'POST', '/api/imported/delete', { json: { batch: importedBatch }, headers: H });
    chk(del.status === 200 && del.json.ok && del.json.removed >= 1, '删除导入批次成功', del.status);
    chk(!fs.existsSync(batchDir), '★ 目录被删掉了', batchDir);
    const man2 = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    chk(!(man2.sessions || []).some((s) => s.importBatch === importedBatch),
      '★ sessions.json 里的条目也没了');
    importedBatch = null;
    const del2 = await req(PORT, 'POST', '/api/imported/delete', { json: { batch: '不存在的批次' }, headers: H });
    chk(del2.status === 400, '删不存在的批次 → 400', del2.status);
  }

  /* ================================================================
     8. 收尾：确认没有「顺手把用户数据改了」
     ================================================================ */
  /* ================================================================
     7.5 安全防线（审计加固项，防止以后被改回去）
     ================================================================ */
  section('7.5 安全防线');

  /* 下载出口：只允许 exports/ imports/ imported/，且敏感文件一律不给 */
  const dlDir = path.join(ROOT, 'exports');
  fs.mkdirSync(dlDir, { recursive: true });
  const probeName = EXPORT_PREFIX + 'probe.txt';
  fs.writeFileSync(path.join(dlDir, probeName), 'probe', 'utf8');
  const dlOk = await req(PORT, 'GET', '/api/download?path=' + encodeURIComponent('exports/' + probeName));
  chk(dlOk.status === 200 && dlOk.text === 'probe', '★ 白名单目录里的文件能正常下载',
    'status=' + dlOk.status);
  chk(dlOk.headers['x-content-type-options'] === 'nosniff', '下载响应带 nosniff（不被浏览器嗅探执行）',
    String(dlOk.headers['x-content-type-options']));

  const dlOut = await req(PORT, 'GET', '/api/download?path=' + encodeURIComponent('scripts/server.mjs'));
  chk(dlOut.status >= 400, '★ 白名单目录外的文件不给下载（源码/配置不外泄）', 'status=' + dlOut.status);

  const dlEsc = await req(PORT, 'GET', '/api/download?path=' + encodeURIComponent('exports/../../../data/cookie_header.txt'));
  chk(dlEsc.status >= 400, '★ 下载路径里的 ../ 穿越被挡住', 'status=' + dlEsc.status);

  /* 敏感文件：即使摆在白名单目录里，也不许下载 */
  fs.writeFileSync(path.join(dlDir, 'cookie_header.txt'), 'SESSDATA=fake', 'utf8');
  const dlSec = await req(PORT, 'GET', '/api/download?path=' + encodeURIComponent('exports/cookie_header.txt'));
  chk(dlSec.status === 403, '★ 含登录凭据的文件不给下载（cookie_header.txt）', 'status=' + dlSec.status);
  const stSec = await req(PORT, 'GET', '/exports/cookie_header.txt');
  chk(stSec.status === 403, '★ 静态出口同样挡住凭据文件（不能靠改 URL 绕过）', 'status=' + stSec.status);
  fs.rmSync(path.join(dlDir, 'cookie_header.txt'), { force: true });

  const stEsc = await req(PORT, 'GET', '/data/cookie_header.txt');
  chk(stEsc.status >= 400, '★ 静态出口不给工作区根下的任意文件', 'status=' + stEsc.status);

  /* 上传文件名压成单段：../../evil.zip 不能写到工作区根 */
  const upEsc = await req(PORT, 'POST', '/api/import/upload', {
    headers: Object.assign({ 'X-DM-WebUI': '1', 'x-dm-filename': encodeURIComponent('../../evil-pwn.zip') }, {}),
    raw: Buffer.from('not a zip at all', 'utf8'),
  });
  chk(upEsc.status >= 400, '★ 恶意文件名的上传被拒（不是备份包）', 'status=' + upEsc.status);
  chk(!fs.existsSync(path.join(ROOT, 'evil-pwn.zip')) && !fs.existsSync(path.join(ROOT, '..', 'evil-pwn.zip')),
    '★ ../ 文件名没有越狱写到工作区外');
  const importsDir = path.join(ROOT, 'imports');
  const escaped = fs.existsSync(importsDir)
    ? fs.readdirSync(importsDir).filter((f) => f.includes('..') || path.basename(f) !== f)
    : [];
  chk(escaped.length === 0, 'imports/ 里没有带路径分隔符的文件名', escaped.join(','));

  /* 输出投毒：CSV 公式注入 + HTML 里的 javascript: 链接 */
  const EE = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'export_engine.mjs')).href);
  chk(EE.csvCell('=1+1').startsWith("'"), '★ CSV 公式注入被中和（=1+1 前面补单引号）', EE.csvCell('=1+1'));
  chk(EE.csvCell('@sum').startsWith("'"), '★ @ 开头的单元格也被中和', EE.csvCell('@sum'));
  chk(EE.csvCell('-2+3').startsWith("'"), '★ - 开头的表达式被中和', EE.csvCell('-2+3'));
  chk(EE.csvCell('-5') === '-5', '纯数字不该被加引号（否则数字变文本）', EE.csvCell('-5'));
  chk(EE.csvCell('a,b') === '"a,b"', '含逗号仍正常加引号转义', EE.csvCell('a,b'));
  chk(EE.safeUrl('javascript:alert(1)') === '', '★ HTML 导出里的 javascript: 链接被清空', EE.safeUrl('javascript:alert(1)'));
  chk(EE.safeUrl('data:text/html,x') === '', 'data: 链接也被清');
  chk(EE.safeUrl('https://a.com/x') === 'https://a.com/x', '正常 https 链接保留');

  /* safeSegment：名字压成单安全段（防 rmSync 删库） */
  const P = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'paths.mjs')).href);
  chk(P.safeSegment('../../etc/passwd', 'x') === 'etcpasswd' ||
      P.safeSegment('../../etc/passwd', 'x') === 'passwd' ||
      !/[\/\\]/.test(P.safeSegment('../../etc/passwd', 'x')),
    '★ safeSegment 把 ../ 拍平（不含路径分隔符）', P.safeSegment('../../etc/passwd', 'x'));
  chk(!P.safeSegment('..', 'fb').startsWith('.'), '★ safeSegment 挡住 ".." 本身', P.safeSegment('..', 'fb'));
  chk(P.safeSegment('', 'fb') === 'fb', '空名回落到默认名（不会删到空路径）', P.safeSegment('', 'fb'));
  chk(P.safeSegment('a'.repeat(300), 'fb').length <= 64, '超长名被截断（不会撞文件名长度上限）',
    String(P.safeSegment('a'.repeat(300), 'fb').length));

  /* 2026-09 隐私审计加固项回归（防改回去）：
     M1 Host 校验 / M2 静态出口类型白名单 / H2 导入不复用包内 .js / H3 统一转义 */
  const hostEvil = await req(PORT, 'GET', '/api/state', { headers: { Host: 'evil.example:' + PORT } });
  chk(hostEvil.status === 403, '★ M1：Host 不是本机地址 → 403（DNS rebinding 挡死）', 'status=' + hostEvil.status);
  const hostGood = await req(PORT, 'GET', '/api/state', { headers: { Host: 'localhost:' + PORT } });
  chk(hostGood.status === 200, '★ M1：localhost 正常放行', 'status=' + hostGood.status);

  fs.writeFileSync(path.join(ROOT, 'data', 'zz_probe_v2.html'), '<script>alert(1)</script>', 'utf8');
  const htmlProbe = await req(PORT, 'GET', '/data/zz_probe_v2.html');
  chk(htmlProbe.status === 200 &&
      htmlProbe.headers['content-type'] === 'application/octet-stream' &&
      /attachment/.test(String(htmlProbe.headers['content-disposition'])),
    '★ M2：data/ 里的 .html 不内联（octet-stream + 强制下载）',
    htmlProbe.headers['content-type'] + ' / ' + htmlProbe.headers['content-disposition']);
  fs.rmSync(path.join(ROOT, 'data', 'zz_probe_v2.html'), { force: true });

  const msgJs = fs.readFileSync(path.join(ROOT, 'data', 'messages.js'), 'utf8');
  chk(msgJs.length > 0 && !msgJs.includes('<'),
    '★ H3：data/messages.js 全文没有一个裸 <（</script> 注入死透）',
    'chars=' + msgJs.length);

  /* H2：包内自带的 .js 一律视为不可信输入 —— 导入后必须由 .json 重新生成覆盖 */
  // 上一次强杀可能留下探针残迹（与 wbtest_forceprobe 同理），先扫掉
  try {
    const m0 = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const n0 = (m0.sessions || []).length;
    m0.sessions = (m0.sessions || []).filter((s) => !(s.importBatch || '').startsWith('zz-probe-evil'));
    if (m0.sessions.length !== n0) fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m0, null, 2) + '\n', 'utf8');
  } catch {}
  fs.rmSync(path.join(ROOT, 'imports', 'zz-probe-evil.zip'), { force: true });
  {
    const imp0 = path.join(ROOT, 'imported');
    if (fs.existsSync(imp0)) {
      for (const d of fs.readdirSync(imp0)) {
        if (d.startsWith('zz-probe-evil')) fs.rmSync(path.join(imp0, d), { recursive: true, force: true });
      }
    }
  }
  const evilMark = 'alert(1)ZZEVIL';
  const evilZip = path.join(ROOT, 'imports', 'zz-probe-evil.zip');
  fs.mkdirSync(path.join(ROOT, 'imports'), { recursive: true });
  writeZip([
    { name: 'data/messages.json', data: JSON.stringify([{ id: 'e1', ts: 1, from: 'peer', type: 'text', text: '正常数据' }]) },
    { name: 'data/messages.js', data: 'window.DM_DATA = [{ id: "e1", text: ' + JSON.stringify(evilMark) + ' }];\n' },
  ], evilZip);
  const evilUp = await req(PORT, 'POST', '/api/import/upload', {
    raw: fs.readFileSync(evilZip),
    headers: Object.assign({}, H, { 'X-DM-Filename': encodeURIComponent('zz-probe-evil.zip') }),
  });
  chk(evilUp.status === 200 && evilUp.json && evilUp.json.ok, '★ H2：数据合法但带恶意 .js 的包能正常导入', evilUp.status);
  if (evilUp.json && evilUp.json.ok) {
    // 会话目录以响应里的 dir 为准（有 manifest 时是 <batch>/data，没有时是 <batch> 本身）
    const sdir = path.join(ROOT, evilUp.json.sessions[0].dir);
    const evilJs = fs.readFileSync(path.join(sdir, 'messages.js'), 'utf8');
    chk(!evilJs.includes(evilMark), '★ H2：包内自带的 .js 被数据重新生成覆盖（恶意代码没活下来）');
    chk(evilUp.json.sessions[0].records === 1, '★ H2：条数按 .json 数（不是 .js 里的假数据）',
      String(evilUp.json.sessions[0].records));
    const delE = await req(PORT, 'POST', '/api/imported/delete', { json: { batch: evilUp.json.batch }, headers: H });
    chk(delE.status === 200 && delE.json && delE.json.ok, 'H2 探针批次已清掉', delE.status);
  }
  fs.rmSync(evilZip, { force: true });

  fs.rmSync(path.join(dlDir, probeName), { force: true });

  /* ================================================================
     7.6 「重新登录」必须真的重来，不能沿用旧登录态直接跳过
     ------------------------------------------------------------------
     ⚠ 为了**不真的弹出浏览器窗口**，这里在 9333 上起一个假 CDP 端点：
       login.mjs 一看到端口开着就认为"浏览器已在运行"，于是不会 spawn Edge。
       如果 9333 已经被真浏览器占着，这组断言就整段跳过。
     ⚠ 探针用**自己的临时目录**，绝不碰真实平台的 Cookie 文件。
     ================================================================ */
  section('7.6 重新登录 = 清掉旧态重来');
  const fakeCdp = await new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"Browser":"fake-cdp"}');
    });
    srv.once('error', () => resolve(null));
    srv.listen(9333, '127.0.0.1', () => resolve(srv));
  });
  if (!fakeCdp) {
    console.log('  [跳过] 9333 端口被占用（多半是专用浏览器开着），本组断言跳过');
  } else {
    const probeKey = 'wbtest_forceprobe';      // key 只许字母/数字/下划线（带 - 会被 sessions.mjs 拒）
    const probeDir = '_wbtest_forceprobe';
    const probeCookie = path.join(ROOT, probeDir, 'cookie_header.txt');
    try {
      const man = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
      man.sessions = (man.sessions || []).filter((s) => s.key !== probeKey);
      man.sessions.push({
        key: probeKey, label: '强制重登探针', platform: 'weibo', dir: probeDir,
        peer: { uid: '1', name: 'probe' },
      });
      fs.writeFileSync(MANIFEST_PATH, JSON.stringify(man, null, 2), 'utf8');
      fs.mkdirSync(path.dirname(probeCookie), { recursive: true });
      fs.writeFileSync(probeCookie, 'SUB=fake-old-cookie; SUBP=fake', 'utf8');

      // ⚠ 用 spawnSync：这个探针最后一定是「等待超时」退出（退出码 3），
      //   execFileSync 遇到非 0 会直接抛，拿不到 stdout。
      const runLogin = (extra) => spawnSync(process.execPath,
        [path.join(ROOT, 'scripts', 'login.mjs'), '--session', probeKey, '--timeout', '1', ...extra],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).stdout || '';

      // 对照组：不带 --force，且本地那份 Cookie 是**假的**（接口校验不过）
      const plain = runLogin([]);
      chk(!/已经是登录状态了/.test(plain),
        '★ 本地 Cookie 通不过校验时，不会再说「已经是登录状态了」（老 bug 的典型症状）',
        plain.trim().split('\n').find((l) => /登录状态/.test(l)) || '');

      const forced = runLogin(['--force']);
      chk(/强制重新登录/.test(forced), '★ --force 走的是强制重登分支', '没出现「强制重新登录」');
      chk(/已删除本地 Cookie 文件/.test(forced), '★ --force 删掉了旧的本地 Cookie 文件');
      chk(!fs.existsSync(probeCookie), '★ Cookie 文件确实没了（不会被继续当成"已登录"）');
      chk(!/已经是登录状态了/.test(forced), '★ --force 不再打印「已经是登录状态了」然后直接返回');
      chk(/等待登录完成/.test(forced), '★ --force 之后确实进入了「等登录」流程（会弹窗口或用已开的窗口）');
  chk(/当前页面|Cookie|必需 Cookie|接着查/.test(forced),
    '★ 超时时会打印自查用的现场信息（页面 / Cookie / 怎么接着查）');

  /* ---- 页面状态分类：风控/验证码 与 "确实没登录" 必须分得开 ---- */
  chk(LG.classifyPage({ href: 'https://passport.weibo.com/protection/index?token=x', title: '安全校验' }) === 'challenge',
    '★ 风控/安全校验页 → challenge（不是"未登录"）',
    LG.classifyPage({ href: 'https://passport.weibo.com/protection/index?token=x' }));
  chk(LG.classifyPage({ href: 'https://weibo.com/', hasCaptcha: true }) === 'challenge',
    '★ 页面出现验证码元素 → challenge');
  chk(LG.classifyPage({ href: 'https://passport.weibo.com/sso/login.php' }) === 'login-page',
    '登录页 → login-page', LG.classifyPage({ href: 'https://passport.weibo.com/sso/login.php' }));
  chk(LG.classifyPage({ href: 'https://api.weibo.com/chat', text: '登录账号：小明 消息列表' }) === 'unknown',
    '★ 已进聊天页、正文里带"登录"二字 → 不会被误判成登录页',
    LG.classifyPage({ href: 'https://api.weibo.com/chat', text: '登录账号：小明' }));
  chk(LG.cookieSummary('SUB=abcdefg; SUBP=xyz').indexOf('abcdefg') === -1,
    '★ Cookie 摘要不含明文值（只列名和长度，日志外泄也不泄露凭据）', LG.cookieSummary('SUB=abcdefg'));
  chk(LG.cookieSummary('') === '（一个都没有）', '没有 Cookie 时的摘要是「一个都没有」');
    } catch (e) {
      chk(false, '强制重登探针跑通了', e.message.slice(0, 200));
    } finally {
      /* 探针会话必须撤干净，否则会混进用户的选择列表 */
      try {
        const man = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        man.sessions = (man.sessions || []).filter((s) => s.key !== probeKey);
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify(man, null, 2), 'utf8');
      } catch { /* */ }
      try { fs.rmSync(path.join(ROOT, probeDir), { recursive: true, force: true }); } catch { /* */ }
      try { fakeCdp.close(); } catch { /* */ }
    }
  }

  /* ================================================================
     7.7 登录校验：浏览器开着时走「页面里」那条通道
     ------------------------------------------------------------------
     为什么必须测这一段：本机装了 Clash 这类 TUN 代理时，**Node 直连平台接口会被
     网关挡成 502**，而浏览器里页面却是好好的已登录状态。旧的判定把 502 一律当成
     "Cookie 已失效"，于是永远显示失效 —— 这是"明明登录了却说没登录"的真根因。
     这里用 `_mock_cdp.mjs`（手写的最小 CDP 端点）模拟浏览器，三种场景都要判对。
     ================================================================ */
  section('7.7 登录校验走浏览器通道');
  const { startMockCdp } = await import(pathToFileURL(path.join(HERE, '_mock_cdp.mjs')).href);
  const runStatus = (port) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'login.mjs'), '--session', 'weibo', '--status'],
      { cwd: ROOT, env: Object.assign({}, process.env, { DM_CDP_PORT: String(port) }) });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => { let j = null; try { j = JSON.parse(out); } catch { /* */ } resolve({ code, j, out }); });
  });

  let mc = await startMockCdp(0, {});                       // 页面里 fetch → 返回 profile
  const ok1 = await runStatus(mc.port);
  chk(ok1.j && ok1.j.loggedIn === true && ok1.j.via === 'browser',
    '★ 页面里确认已登录 → loggedIn=true（走的浏览器通道）', ok1.out.trim().slice(0, 160));
  chk(ok1.j && ok1.j.account === 'mock_user', '★ 还能拿到登录账号', ok1.j && ok1.j.account);
  chk(ok1.code === 0, '已登录时 --status 退出码 0', ok1.code);
  await mc.close();

  mc = await startMockCdp(0, { body: '502\n<html>502 Bad Gateway</html>' });
  const gw = await runStatus(mc.port);
  /* ⚠ 行为在 7.8 之后变了，断言也得跟着改语义：
     浏览器那条路被网关挡住时，**不再直接判死**，而是回退去试直连的其它端点
     （本机直连走的是和抓取同一套的 webim/，多半是通的）。
     所以这里盯的是"绝不许判成 expired"，而不是"必须报 network"。 */
  chk(gw.j && gw.j.invalidReason !== 'expired',
    '★ 网关 502 **不会**被误判成 Cookie 已失效', gw.j && gw.j.invalidReason);
  chk(gw.j && (gw.j.loggedIn === true || gw.j.invalidReason === 'network'),
    '浏览器那条路被挡时：要么直连兜底确认已登录，要么报 network —— 没有第三种',
    gw.j && gw.j.invalidReason + ' / loggedIn=' + gw.j.loggedIn);
  chk(gw.code !== 3, '★ "连不上"不会被当成"未登录"（退出码不是 3）', gw.code);
  // 通道本身单独测：502 在浏览器通道里必须判 network，诊断里写明 HTTP 502
  const via502 = await LG.verifyInBrowser(mc.port, 'weibo');
  chk(via502 && via502.reason === 'network' && /502/.test(via502.detail || ''),
    '★ 浏览器通道里 502 → network，诊断写明 HTTP 502', via502 && via502.reason + ' ' + via502.detail);
  await mc.close();

  // WAF 那种「403 + HTML」也不能当成"没登录"
  mc = await startMockCdp(0, { body: '403\n<!DOCTYPE HTML><html>access denied</html>' });
  const via403 = await LG.verifyInBrowser(mc.port, 'weibo');
  chk(via403 && via403.reason === 'network',
    '★ 403 但返回的是 HTML（WAF 拦截页）→ network，不是 Cookie 已失效', via403 && via403.reason);
  await mc.close();

  mc = await startMockCdp(0, { body: '200\n{"ok":0}' });
  const no = await runStatus(mc.port);
  chk(no.j && no.j.invalidReason === 'expired', '确实没登录时才判 expired', no.j && no.j.invalidReason);
  chk(no.code === 3, '确实没登录时退出码 3', no.code);
  await mc.close();

  /* 浏览器没开时：直连那条路也不能把 5xx 说成失效 */
  const v502 = await LG.verifyCookie({ platform: 'weibo' }, 'SUB=fake', { allowBrowser: false });
  chk(!v502.ok, '伪造 Cookie 不会通过校验', v502.reason);

  /* ================================================================
     7.8 校验端点必须和抓取脚本是同一套 + 手动 Cookie 兜底通道
     ------------------------------------------------------------------
     为什么必须测这一段：早年校验用的是 `/chat/query_primary_info.json`，
     抓取 update.mjs 用的却是 `/webim/query_primary_info.json` —— 路径不一致；
     而且 `/chat/` 这条会被网络上的透明网关挡成 **502**（同 host 的 `/webim/` 正常 200），
     于是"明明登录着"被报成「连不上平台接口」。这条断言盯死两者不许再分家。
     ================================================================ */
  section('7.8 校验端点与抓取一致 + 手动 Cookie 通道');
  const updSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'update.mjs'), 'utf8');
  const loginSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'login.mjs'), 'utf8');
  const apiBase = (updSrc.match(/const API_BASE\s*=\s*'([^']+)'/) || [])[1] || '';
  chk(apiBase === 'https://api.weibo.com/webim/', '抓取脚本的 API_BASE 取到了', apiBase);
  chk(loginSrc.indexOf("'" + apiBase + "query_primary_info.json?source=209678993'") >= 0,
    '★ 登录校验的主端点 == 抓取脚本的 API_BASE + query_primary_info.json（两者不许分家）');

  // 直连校验判 network 时，必须是「多个候选端点都试过」才下结论，并把试过哪些写进诊断
  const vTry = await LG.verifyCookie({ platform: 'weibo' }, 'SUB=probe_fake', { allowBrowser: false });
  if (vTry.reason === 'network') {
    chk(Array.isArray(vTry.tried) && vTry.tried.length >= 2 && vTry.tried.some((u) => /webim/.test(u)),
      '★ 候选端点全试过才判 network，且诊断里列出试过哪些', JSON.stringify(vTry.tried));
  } else {
    chk(true, '直连校验拿到了明确结论（' + vTry.reason + '），无需候选端点兜底');
  }

  /* 手动 Cookie：形状不对 → 400 且**不落盘**；形状对 → 落盘并当场真校验一次。
     ⚠ 这段会碰真实的 data/cookie_header.txt：必须先备份、finally 里原样还回去。 */
  const CK = path.join(ROOT, 'data', 'cookie_header.txt');
  const CK_BAK = CK + '.probebak';
  const hadCk = fs.existsSync(CK);
  const ckOrig = hadCk ? fs.readFileSync(CK, 'utf8') : '';
  try {
    if (hadCk) fs.writeFileSync(CK_BAK, ckOrig, 'utf8');     // 磁盘备份：进程被杀也找得回来
    const bad1 = await req(PORT, 'POST', '/api/login/cookie', { headers: H, json: { session: 'weibo', cookie: '' } });
    chk(bad1.status === 400, '空 Cookie → 400', bad1.status + ' ' + bad1.text.slice(0, 80));
    const bad2 = await req(PORT, 'POST', '/api/login/cookie', { headers: H, json: { session: 'weibo', cookie: 'foo=bar; baz=1' } });
    chk(bad2.status === 400 && /SUB=/.test(bad2.text), '缺 SUB= 的串 → 400，且提示缺的是哪一段', bad2.status);
    chk(hadCk ? fs.readFileSync(CK, 'utf8') === ckOrig : !fs.existsSync(CK),
      '★ 校验不通过时真实 Cookie 文件一个字节都没动');
    const bad3 = await req(PORT, 'POST', '/api/login/cookie', { headers: H, json: { session: '不存在的会话', cookie: 'SUB=x' } });
    chk(bad3.status === 400, '不存在的会话 → 400', bad3.status);
    const okSave = await req(PORT, 'POST', '/api/login/cookie', { headers: H, json: { session: 'weibo', cookie: 'SUB=probe_fake; SUBP=probe' } });
    chk(okSave.status === 200 && okSave.json && okSave.json.ok, '形状对 → 200 并落盘', okSave.status + ' ' + okSave.text.slice(0, 120));
    chk(okSave.json && okSave.json.status && okSave.json.status.loggedIn === false,
      '★ 手动粘的假 Cookie 照样真校验一次，不会直接当成"已登录"',
      okSave.json && okSave.json.status && okSave.json.status.invalidReason);
  } finally {
    try { if (hadCk) fs.writeFileSync(CK, ckOrig, 'utf8'); else if (fs.existsSync(CK)) fs.unlinkSync(CK); } catch { /* */ }
    try { if (fs.existsSync(CK_BAK)) fs.unlinkSync(CK_BAK); } catch { /* */ }
  }
  chk(hadCk ? fs.readFileSync(CK, 'utf8') === ckOrig : true, '★ 探针跑完，真实 Cookie 文件原样恢复');

  /* ================================================================
     7.9 勾多个平台：每个平台都要建出任务 + 服务端串行（队列）
     ------------------------------------------------------------------
     旧 bug：`/api/fetch` 建完第一个 job 就 `break`（注释写着"前端会接力发起下一个"），
     可前端从来没实现接力 → 勾了「微博 + B站」点开始备份**只跑微博**，
     用户得手动取消微博、再单独选 B站才能跑 B站。
     这里盯死三件事：① 两个都建出来；② 同一时刻最多一个在跑（不抢浏览器端口）；
     ③ 排队中的任务能被取消（否则点了「停止」，队列里那个会自己跑起来）。
     用 `--steps doctor` 跑：不联网、不写数据，几秒就有结论。
     ================================================================ */
  section('7.9 多平台备份：任务都建出来 + 串行执行');
  const rf = await req(PORT, 'POST', '/api/fetch', {
    headers: H, json: { sessions: ['weibo', 'bili'], steps: ['doctor'], mode: 'incr' },
  });
  chk(rf.status === 200 && rf.json && rf.json.jobs.length === 2,
    '★ 勾两个平台 → 两个任务都建出来（不再只跑第一个）',
    rf.status + ' jobs=' + (rf.json && rf.json.jobs && rf.json.jobs.length));
  chk(rf.json && Array.isArray(rf.json.queued) && rf.json.queued.length === 2
    && rf.json.queued.includes('weibo') && rf.json.queued.includes('bili'),
    '返回的排队列表里两个会话都在', rf.json && JSON.stringify(rf.json.queued));

  const jl = await req(PORT, 'GET', '/api/jobs');
  const allJobs = (jl.json && jl.json.jobs) || [];
  const runNow = allJobs.filter((j) => j.status === 'running');
  chk(runNow.length <= 1, '★ 同一时刻最多一个任务在跑（串行，不抢浏览器调试端口）', runNow.length);
  const viaQueue = allJobs.filter((j) => j.queue === 'serial');
  chk(viaQueue.length >= 2, '这一轮的任务都挂在同一个串行队列上', viaQueue.length);

  const idFirst = rf.json.jobs[0].id, idSecond = rf.json.jobs[1].id;
  // 取消排队中的任务：状态必须离开 queued，否则它会一直挂着、轮到时自己跑起来
  const kq = await req(PORT, 'POST', '/api/job/kill', { headers: H, json: { id: idSecond } });
  const j2 = await req(PORT, 'GET', '/api/job?id=' + idSecond);
  chk(kq.json && kq.json.ok === true, '排队中的任务能被取消（kill 返回 ok）', JSON.stringify(kq.json));
  chk(j2.json && j2.json.job.status !== 'queued',
    '★ 取消后不再是 queued（不会轮到时自己又跑起来）', j2.json && j2.json.job.status);

  await req(PORT, 'POST', '/api/job/kill', { headers: H, json: { id: idFirst } });
  await new Promise((r) => setTimeout(r, 700));
  const jl2 = await req(PORT, 'GET', '/api/jobs');
  const still = ((jl2.json && jl2.json.jobs) || []).filter((j) => j.status === 'running' || j.status === 'queued');
  chk(still.length === 0, '★ 取消后没有任务还在跑/排队（不留僵尸任务）', still.length);

  section('8. 副作用检查');
  if (hadManifest) {
    const now = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const bak = fs.readFileSync(MANIFEST_BAK, 'utf8');
    const strip = (s) => JSON.stringify((JSON.parse(s).sessions || []).map((x) => x.key).sort());
    chk(strip(now) === strip(bak), '★ sessions.json 的会话列表回到原样（导入测试没留残迹）',
      strip(now) === strip(bak) ? '' : strip(now) + ' vs ' + strip(bak));
  }
  const leftovers = fs.existsSync(path.join(ROOT, 'imported'))
    ? fs.readdirSync(path.join(ROOT, 'imported')).filter((d) => /^shared-backup/.test(d))
    : [];
  chk(leftovers.length === 0, 'imported/ 里没有测试残留目录', leftovers.join(','));

} finally {
  /* 兜底：万一中途抛错，把批次和 sessions.json 都收拾干净 */
  try {
    if (importedBatch) {
      const man = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
      if ((man.sessions || []).some((s) => s.importBatch === importedBatch)) {
        man.sessions = man.sessions.filter((s) => s.importBatch !== importedBatch);
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify(man, null, 2), 'utf8');
        const dir = path.join(ROOT, 'imported', importedBatch);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        console.log('  [!] finally：已回滚残留的导入批次 ' + importedBatch);
      }
    }
  } catch (e) { console.log('  [!] 回滚导入批次失败，请手动检查：' + e.message); }

  try {
    if (hadManifest && fs.existsSync(MANIFEST_BAK)) {
      /* ⚠ 这里必须**按字节**比，不能只比「会话 key 列表」。
         中途几次写回用的是 `JSON.stringify(…, null, 2)`，而原文件常常没有结尾换行
         → 语义一样、字节不同（实测 2813 → 2814 字节）。
         只比 key 就会「认为已经干净 → 不还原」，于是用户真实的 sessions.json
         每跑一次回归就悄悄多一个换行；而「跑完真实数据一个字节都没变」那条复核
         会**假报 FAILED** —— 真出事时反而分不清是真改坏还是这个换行。
         对齐 extras 对 `bili/ocr.json` 的口径：探针跑完必须逐字节复原。 */
      const curBuf = fs.readFileSync(MANIFEST_PATH);
      const bakBuf = fs.readFileSync(MANIFEST_BAK);
      if (!curBuf.equals(bakBuf)) {
        fs.copyFileSync(MANIFEST_BAK, MANIFEST_PATH);
        spawn(process.execPath, [path.join(ROOT, 'scripts', 'build_sessions.mjs')], { cwd: ROOT, stdio: 'ignore' });
        console.log('  [!] finally：sessions.json 已按字节还原（与备份不一致）');
      }
    }
  } catch (e) { console.log('  [!] 还原 sessions.json 失败，请手动检查：' + e.message); }

  /* 清 imported/ 残留：只按「跑之前有什么 / 跑完多出什么」做差集。
     ⚠ 不能只依赖上面那段「sessions.json 里还挂着 importBatch」的判定 —— 测试自己在
     正常路径末尾就会把那条登记删掉，于是 `some(...)` 为 false，批次目录成了孤儿。
     那一刻留下的目录对**下一条断言**（imported/ 里没有测试残留目录）是致命的：
     一次异常退出（被 kill / 超时）会让**之后每一次回归都红在同一条**，而人只会
     以为「这次又不行了」，不会想到是上一轮的尸体 —— 自毒式测试垃圾。
     （同口径参考 verify_extras 对 snapshots/ 的做法：先记清单，跑完删多出来的。） */
  try {
    if (fs.existsSync(IMPORTED_DIR)) {
      for (const d of fs.readdirSync(IMPORTED_DIR)) {
        if (importedBefore.has(d)) continue;         // 跑之前就有的，是用户真实的导入，绝不动
        fs.rmSync(path.join(IMPORTED_DIR, d), { recursive: true, force: true });
        console.log('  [!] finally：清掉本次导入测试留下的 imported/' + d);
      }
    }
  } catch (e) { console.log('  [!] 清理 imported/ 残留失败，请手动检查：' + e.message); }

  try { child.kill(); } catch { /* 已经退了 */ }
}

/* 清掉本次测试产生的导出文件（保留其它历史导出） */
let cleaned = 0;
for (const f of fs.existsSync(path.join(ROOT, 'exports')) ? fs.readdirSync(path.join(ROOT, 'exports')) : []) {
  if (f.startsWith(EXPORT_PREFIX)) { try { fs.rmSync(path.join(ROOT, 'exports', f), { force: true }); cleaned++; } catch { /* 占用 */ } }
}
if (cleaned) console.log('\n（已清理本次测试导出 ' + cleaned + ' 个文件）');

/* 清掉本次测试上传到 imports/ 的假包（真包是用户自己放的，只认测试用过的那几个名字） */
let cleanedUp = 0;
for (const f of fs.existsSync(path.join(ROOT, 'imports')) ? fs.readdirSync(path.join(ROOT, 'imports')) : []) {
  if (/^(empty|evil-pwn|not-a-backup|shared-backup)/.test(f)) {
    try { fs.rmSync(path.join(ROOT, 'imports', f), { force: true }); cleanedUp++; } catch { /* 占用 */ }
  }
}
if (cleanedUp) console.log('（已清理本次测试上传 ' + cleanedUp + ' 个文件）');

/* 全绿才清 scratch；有失败就留着，方便翻现场 */
if (!fail.length) {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用 */ }
}

console.log('\n' + '='.repeat(60));
console.log(`WebUI 端到端：通过 ${pass.length} · 失败 ${fail.length} · 合计 ${pass.length + fail.length}`);
if (fail.length) console.log('失败项：\n  · ' + fail.join('\n  · '));
console.log('='.repeat(60));
process.exit(fail.length ? 1 : 0);
