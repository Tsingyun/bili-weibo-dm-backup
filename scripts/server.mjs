#!/usr/bin/env node
/**
 * 私信备份 · 本地 WebUI 服务
 * ===============================================================
 * 设计原则（决定了为什么是这个形状）：
 *
 * 1. **只监听 127.0.0.1**。这是一个能读到全部私信、还能驱动浏览器登录的程序，
 *    绝不能因为"顺手"就绑 0.0.0.0 暴露到局域网。
 *
 * 2. **零依赖**。整条链路只用 Node 内置模块（http / fs / child_process / zlib）。
 *    用户拿到的是一份代码，不是一份要 npm install 的工程 —— 解压即用是硬要求。
 *
 * 3. **服务端只做两件事**：读写工作区文件、起子进程跑既有脚本。
 *    抓取 / OCR / 导出这些逻辑**一行都不在这里重写**，全在 scripts/ 下那批脚本里，
 *    否则 WebUI 会和命令行版本慢慢长成两套口径（内容一样、结果不一样的经典事故）。
 *
 * 4. **写操作要带专属头**（`X-DM-WebUI: 1`）。本地服务最现实的攻击面不是"外网打进来"，
 *    而是用户浏览器里某个网页偷偷 POST 到 127.0.0.1。要求一个自定义头 + 校验 Origin，
 *    跨站表单发不出来（浏览器不允许自定义头跨域发送），足够挡住这类 CSRF。
 *
 * 启动：node scripts/server.mjs [--port 8787] [--open]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  ROOT, MANIFEST_PATH, readManifest, loadSessions, findSession, sessionDirs,
} from './sessions.mjs';
import {
  ensureDir, safeJoin, rel, dirStat, humanSize, writeJson, readJson, exists, safeSegment,
} from './lib/paths.mjs';
import { startJob, getJob, listJobs, killJob, subscribe, anyRunning } from './lib/jobs.mjs';
import { FORMATS, KINDS, runExport, collect } from './lib/export_engine.mjs';
import { importBackup, listImported, deleteImported } from './lib/import_backup.mjs';
import { findBrowser, statusFor, isPortOpen, readCookies, saveCookie, COOKIE_HINT, PORT as CDP_PORT } from './login.mjs';

const ARGS = process.argv.slice(2);
const val = (f, d = null) => {
  const i = ARGS.indexOf(f);
  const v = i >= 0 ? ARGS[i + 1] : null;
  return (v && !v.startsWith('--')) ? v : d;
};
const PORT = Number(val('--port', process.env.DM_WEBUI_PORT || 8787));
const HOST = '127.0.0.1';
const SELF = process.execPath;
const S = (n) => path.join(ROOT, 'scripts', n);

/* 运行环境来源。
   便携包在 runtime\node\ 里自带一份运行时（启动器会优先用它），
   这时界面要说清「不需要额外安装 Node」—— 新手最容易卡的就是这一步。
   Windows 路径大小写不敏感，比较前统一转小写。 */
const RUNTIME_DIR = path.join(ROOT, 'runtime', 'node');
const BUILTIN_RUNTIME = path.dirname(SELF).toLowerCase() === RUNTIME_DIR.toLowerCase();

/* ================================================================
   小工具
   ================================================================ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.zip': 'application/zip',
};

function sendJson(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function sendText(res, text, code = 200, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
}
function fail(res, code, msg, extra = {}) {
  sendJson(res, { ok: false, error: msg, ...extra }, code);
}

function tooBig() {
  const e = new Error('请求体过大（上限 2 GB）');
  e.httpCode = 413;                 // 让外层能回 413 而不是含糊的 500
  return e;
}

/** 收集请求体（带大小上限，避免一个超大 body 把内存吃光） */
function readBody(req, limit = 2 * 1024 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(tooBig()); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 把请求体**直接写到磁盘**（不整块进内存）。
 * 上传的备份包动辄几百 MB，用 readBody 攒成一个 Buffer 会把内存顶上去。
 */
function saveBody(req, dest, limit = 2 * 1024 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    let n = 0;
    let done = false;
    const cleanup = () => { try { ws.destroy(); } catch {} };
    const bail = (e) => {
      if (done) return; done = true;
      cleanup();
      try { fs.unlinkSync(dest); } catch {}          // 别留下半个文件
      reject(e);
    };
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { req.destroy(); bail(tooBig()); return; }
      if (!ws.write(c)) { req.pause(); ws.once('drain', () => req.resume()); }
    });
    req.on('end', () => {
      if (done) return; done = true;
      ws.end(() => resolve({ bytes: n }));
    });
    req.on('error', bail);
    ws.on('error', bail);
  });
}

/**
 * 统一的文件输出。
 * ⚠ 客户端中途断开（关标签页、点停止）会让 socket 报 ECONNRESET：
 *   写端不接这个错误 = 未处理的 'error' 事件 = **整个服务进程崩掉**。
 *   这里把 res 和读流两头的错误都吞掉：一个用户断开了，不该影响其他人。
 */
function pipeFile(req, res, full, asAttachment) {
  let st;
  try { st = fs.statSync(full); } catch { return fail(res, 404, '文件不存在'); }
  res.on('error', () => { try { res.destroy(); } catch {} });
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(asAttachment
      ? { 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(path.basename(full)) + '"' }
      : {}),
  });
  const src = fs.createReadStream(full);
  src.on('error', () => { try { res.end(); } catch {} });
  src.pipe(res);
}
async function readJsonBody(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); }
  catch { throw new Error('请求体不是合法 JSON'); }
}

/**
 * CSRF 防线：写操作必须带 X-DM-WebUI 头；若浏览器带了 Origin，必须同源。
 * 自定义头 + 跨域预检这两条组合起来，普通 <form> 和 <img> 打不进来。
 */
function guardWrite(req, res) {
  if (req.headers['x-dm-webui'] !== '1') {
    fail(res, 403, '缺少 X-DM-WebUI 请求头（本接口只允许本机 WebUI 调用）');
    return false;
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      const u = new URL(origin);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
        fail(res, 403, '拒绝跨站请求（Origin=' + origin + '）');
        return false;
      }
    } catch { fail(res, 403, 'Origin 不合法'); return false; }
  }
  return true;
}

/* ================================================================
   环境探测 / 状态汇总
   ================================================================ */
function findOcrPython() {
  const p = path.join(ROOT, '.ocr-env', 'Scripts', 'python.exe');
  return exists(p) ? p : null;
}
function hasGlmKey(sessionDir) {
  if (process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY || process.env.BIGMODEL_API_KEY) return true;
  return exists(path.join(ROOT, sessionDir || 'data', 'glm_key.txt')) ||
         exists(path.join(ROOT, 'data', 'glm_key.txt'));
}

function sessionStats(s) {
  const base = path.join(ROOT, s.dir);
  const meta = readJson(path.join(base, 'meta.json'), null);
  const out = {
    key: s.key, label: s.label, title: s.title, dir: s.dir, platform: s.platform,
    imported: !!s.imported, readonly: !!s.readonly,
    peer: { uid: s.peer.uid, name: s.peer.name },
    self: { uid: s.self.uid, name: s.self.name },
    hasData: exists(path.join(base, 'messages.json')) || exists(path.join(base, 'messages.js')),
    hasMessagesJson: exists(path.join(base, 'messages.json')),
    hasCookieFile: exists(path.join(base, 'cookie_header.txt')),
    hasGlmKey: hasGlmKey(s.dir),
    counts: { messages: 0, images: 0, ocr: 0, vlm: 0 },
    range: { first: null, last: null },
    names: { peer: '', self: '' },
  };
  if (meta && typeof meta === 'object') {
    out.counts.messages = Number(meta.total) || 0;
    out.counts.images = Number(meta.images) || 0;
    out.range.first = meta.first_time || null;
    out.range.last = meta.last_time || null;
    out.names.peer = meta.peer_name || '';
    out.names.self = meta.self_name || '';
  } else if (out.hasMessagesJson) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(base, 'messages.json'), 'utf8'));
      if (Array.isArray(m)) {
        out.counts.messages = m.length;
        out.names.peer = (m.find((x) => x.from === 'peer') || {}).sender || '';
        out.names.self = (m.find((x) => x.from === 'me') || {}).sender || '';
      }
    } catch {}
  }
  for (const k of ['ocr', 'vlm']) {
    const p = path.join(base, k + '.json');
    if (!exists(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      out.counts[k] = j && typeof j === 'object'
        ? (Array.isArray(j) ? j.length : Object.keys(j).length) : 0;
    } catch {}
  }
  const st = dirStat(base);
  out.bytes = st.bytes; out.human = humanSize(st.bytes); out.files = st.files;
  return out;
}

/**
 * /api/state 每 20 秒被前端轮询一次。旧实现每次都对每个会话目录做**整棵递归 stat**
 * （几千个文件逐个 statSync）再读一遍 ocr.json / vlm.json —— 纯浪费，
 * 数据越大越明显。这里按会话缓存 8 秒：这个量级的目录内容不会变得那么快。
 */
const STAT_CACHE = new Map();
const STAT_TTL = 8000;
function sessionStatsCached(s) {
  const key = String(s.dir || '') + '|' + (s.key || '');
  const now = Date.now();
  const hit = STAT_CACHE.get(key);
  if (hit && now - hit.at < STAT_TTL) return { ...hit.v };
  const v = sessionStats(s);
  STAT_CACHE.set(key, { at: now, v });
  return { ...v };                   // 返回副本：调用方会往上挂 login/imported 字段
}

/**
 * 登录态缓存（按平台）。
 *
 * ⚠ 为什么必须缓存：statusFor() 现在会**真去打一次平台接口**，一次几十到几百毫秒。
 *   /api/state 是每 20 秒轮询一次的，不缓存就是每 20 秒对每个平台发一次外网请求，
 *   既慢又容易被平台当成异常流量。TTL 60 秒足够：登录状态不会瞬变，
 *   而「刷新登录状态」按钮和登录任务结束后都会强制刷新（fresh=true）。
 */
const LOGIN_CACHE = new Map();
const LOGIN_TTL = 60000;
async function loginStatusFor(s, opts = {}) {
  const pf = s.platform;
  const now = Date.now();
  const hit = LOGIN_CACHE.get(pf);
  if (!opts.fresh && hit && now - hit.at < LOGIN_TTL) return hit.st;
  const st = await statusFor({ key: s.key, platform: pf, dir: s.dir });
  LOGIN_CACHE.set(pf, { at: now, st });
  return st;
}
function invalidateLoginCache(platform) {
  if (platform) LOGIN_CACHE.delete(platform);
  else LOGIN_CACHE.clear();
}

/**
 * 「这一步需不需要登录」—— 抓取用 Cookie 打接口，表情包用 Cookie 下载图片，都需要。
 * 体检/快照/OCR/图片描述只读本地文件，不需要。
 */
const NEEDS_LOGIN = new Set(['fetch', 'faces']);

/**
 * 备份前的登录前置检查：没登录就**别起任务**。
 * 旧行为是先起一个任务、跑到 update.mjs 里才报「未登录/失效」——
 * 用户看到的是"点了备份，然后失败了"，而不是"你还没登录"。
 */
async function requireLoginOrFail(res, s) {
  const st = await loginStatusFor(s, { fresh: true });
  if (st.loggedIn) return false;
  // 连不上平台接口 ≠ 未登录：这时候拦下用户是误诊，放行让抓取自己去报
  if (st.invalidReason === 'network') return false;
  const why = st.invalidReason === 'expired'
    ? '本地 Cookie 还在，但平台接口已经不认它了（多半是过期）'
    : '还没有登录凭据';
  fail(res, 401, '「' + s.label + '」还没有有效的登录态 —— ' + why +
    '。请先到第 2 步「授权登录」点一次登录（已登录过就点「重新登录」）。');
  return true;
}

function recentExports(limit = 20) {
  const dir = path.join(ROOT, 'exports');
  if (!exists(dir)) return [];
  const out = [];
  const walk = (d, depth) => {
    if (depth > 1) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) {
        const st = fs.statSync(full);
        out.push({ name: e.name, rel: rel(full), size: st.size, human: humanSize(st.size), mtime: st.mtimeMs });
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function readStateFile() {
  return readJson(path.join(ROOT, '.webui', 'state.json'), {}) || {};
}
function writeStateFile(patch) {
  const cur = readStateFile();
  writeJson(path.join(ROOT, '.webui', 'state.json'), { ...cur, ...patch });
}

async function buildState() {
  let sessions = [];
  let configError = null;
  try { sessions = loadSessions(); }
  catch (e) { configError = e.message; }

  // ⚠ sessions.json 坏掉时 readManifest() 会抛；不接住的话 /api/state 直接 500，
  //   页面上连「配置有问题」这句话都看不到 —— 而这一页本来就是用来告诉用户配置坏了的。
  let raw = [];
  try { raw = readManifest().sessions || []; }
  catch (e) { configError = configError || e.message; }
  const rawByKey = new Map(raw.map((s) => [s.key, s]));
  const enriched = sessions.map((s) => {
    const st = sessionStatsCached({ ...s, imported: (rawByKey.get(s.key) || {}).imported });
    const r = rawByKey.get(s.key) || {};
    st.imported = !!r.imported;
    st.readonly = !!r.readonly;
    st.importBatch = r.importBatch || '';
    st.importedAt = r.importedAt || '';
    return st;
  });

  const py = findOcrPython();
  const browser = findBrowser();
  const browserUp = await isPortOpen(CDP_PORT);

  // 每个平台的登录态（同一平台只问一次；statusFor 会真去打平台接口，不能每次都打）
  for (const s of enriched) {
    if (s.imported) continue;
    const c = await loginStatusFor(s);
    s.login = {
      loggedIn: c.loggedIn, source: c.source,
      hasSavedCookie: c.hasSavedCookie, savedLooksValid: c.savedLooksValid,
      verified: c.verified, invalidReason: c.invalidReason, account: c.account,
    };
  }

  return {
    ok: true,
    root: ROOT,
    manifest: MANIFEST_PATH,
    port: PORT,
    cdpPort: CDP_PORT,
    node: process.version,
    runtime: { builtin: BUILTIN_RUNTIME, execPath: SELF },
    configError,
    env: {
      browser: browser || null,
      browserUp,
      ocrReady: !!py,
      ocrPython: py,
      glmKey: hasGlmKey('data'),
      running: anyRunning(),
    },
    sessions: enriched,
    formats: FORMATS,
    kinds: KINDS,
    jobs: listJobs(),
    imported: listImported(),
    exports: recentExports(),
    state: readStateFile(),
  };
}

/* ================================================================
   会话增删改
   ================================================================ */
function regenSessionsJs() {
  try {
    return execFileSync(SELF, [S('build_sessions.mjs'), '--mkdir'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    return '生成 sessions.js 失败：' + String(e.stdout || e.message).trim();
  }
}

function upsertSession(body) {
  const action = body.action || 'save';
  const raw = readManifest();
  raw.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];

  if (action === 'delete') {
    const key = String(body.key || '').trim();
    const at = raw.sessions.findIndex((s) => s.key === key);
    if (at < 0) throw new Error('没有这个会话：' + key);
    if (!raw.sessions[at].imported) {
      // 只在配置里移除，**绝不自动删数据**（用户的备份比配置值钱）
      const dir = raw.sessions[at].dir;
      raw.sessions.splice(at, 1);
      writeJson(MANIFEST_PATH, raw);
      return { removed: key, note: '只从清单里移除了配置；数据目录 ' + dir + ' 原样保留（要清自己删）', sessionsJs: regenSessionsJs() };
    }
    raw.sessions.splice(at, 1);
    writeJson(MANIFEST_PATH, raw);
    return { removed: key, note: '已移除导入的会话', sessionsJs: regenSessionsJs() };
  }

  const key = String(body.key || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(key)) throw new Error('会话 key 只能含字母 / 数字 / 下划线');
  const platform = body.platform === 'bili' ? 'bili' : 'weibo';
  const isBuiltin = key === 'weibo' || key === 'bili';
  let dir = String(body.dir || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/+/, '');
  if (!dir) dir = isBuiltin ? (key === 'bili' ? 'bili' : 'data') : 'data_' + key;
  if (dir.split('/').includes('..') || /^[A-Za-z]:/.test(dir)) throw new Error('数据目录必须是工作区内的相对路径');

  const existing = raw.sessions.find((s) => s.key === key);
  if (existing && existing.imported) throw new Error('会话「' + key + '」是导入的只读备份，不能改配置');

  const entry = existing || { key };
  entry.key = key;
  entry.label = String(body.label || entry.label || key).trim();
  entry.dir = dir;
  entry.platform = platform;
  entry.peer = {
    uid: String((body.peer && body.peer.uid) || '').trim(),
    name: String((body.peer && body.peer.name) || '').trim(),
  };
  entry.self = {
    uid: String((body.self && body.self.uid) || '').trim(),
    name: String((body.self && body.self.name) || '').trim(),
  };

  if (!existing) raw.sessions.push(entry);
  writeJson(MANIFEST_PATH, raw);

  // 顺手把数据目录骨架建起来
  for (const d of [dir, dir + '/images', dir + '/faces', dir + '/raw']) {
    ensureDir(path.join(ROOT, d));
  }
  return { saved: key, dir, sessionsJs: regenSessionsJs() };
}

/**
 * `/api/download` 是 **GET**，拿不到 X-DM-WebUI 头（那是写接口的防线），
 * 所以它必须自己把范围收紧：不限制的话 `?path=data/cookie_header.txt`
 * 就能把登录凭据原样拿走（本地进程 / 直接访问地址都拦不住）。
 */
const DOWNLOAD_DIRS = ['exports/', 'imports/', 'imported/'];

/**
 * 任何出口都不该带出去的文件。登录 Cookie 和 API Key 跟账号密码是一档的，
 * 哪怕只是"自己机器上顺手看一眼"也不该被下载 / 被静态服务吐出去。
 */
const SENSITIVE_RE = /(^|\/)(cookie_header\.txt|.*_key\.txt|\.env(\..*)?|id_rsa.*|.*\.pem|.*\.pfx|.*\.p12)$/i;

/* ================================================================
   路由
   ================================================================ */
async function handleApi(req, res, u) {
  const p = u.pathname;
  const q = u.searchParams;

  /* ---------- 读 ---------- */
  if (req.method === 'GET' && p === '/api/state') {
    return sendJson(res, await buildState());
  }
  if (req.method === 'GET' && p === '/api/jobs') {
    return sendJson(res, { ok: true, jobs: listJobs() });
  }
  if (req.method === 'GET' && p === '/api/job') {
    const j = getJob(q.get('id') || '');
    if (!j) return fail(res, 404, '没有这个任务');
    return sendJson(res, { ok: true, job: j.summary(), lines: j.lines, dropped: j.dropped });
  }
  if (req.method === 'GET' && p === '/api/job/stream') {
    const j = getJob(q.get('id') || '');
    if (!j) return fail(res, 404, '没有这个任务');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // SSE 是长连接：前端关掉标签页时 socket 会报错，不接住就是未处理的 error 事件
    let iv = null;
    res.on('error', () => { if (iv) clearInterval(iv); try { res.destroy(); } catch {} });
    const since = Number(q.get('since') || 0);          // 前端已收到的行数，支持断线重连
    for (let i = since; i < j.lines.length; i++) {
      res.write('data: ' + JSON.stringify({ t: 'line', line: j.lines[i] }) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({ t: 'status', ...j.summary(), lines: j.lines.length }) + '\n\n');
    const un = subscribe(j.id, (line) => {
      res.write('data: ' + JSON.stringify({ t: 'line', line }) + '\n\n');
    });
    // 任务结束时推一条终态，然后收尾
    // ⚠ `queued` 也算"还没完"：勾了两个平台时，第二个任务建出来就是排队状态，
    //   若把它当终态，前端会在第一个平台跑完前就以为整轮结束了。
    const parked = (st) => st === 'running' || st === 'queued';
    let lastStatus = j.status;
    let tick = 0;
    iv = setInterval(() => {
      tick++;
      if (!parked(j.status)) {                            // 终态：推一帧再收尾
        res.write('data: ' + JSON.stringify({ t: 'status', ...j.summary(), lines: j.lines.length }) + '\n\n');
        clearInterval(iv); un(); res.end();
        return;
      }
      if (j.status !== lastStatus) {                      // 「排队中 → 开跑」要立刻告诉前端
        lastStatus = j.status;
        res.write('data: ' + JSON.stringify({ t: 'status', ...j.summary(), lines: j.lines.length }) + '\n\n');
        return;
      }
      if (tick % 3 === 0) res.write(': ping\n\n');
    }, 1000);
    req.on('close', () => { clearInterval(iv); un(); });
    return;
  }
  if (req.method === 'GET' && p === '/api/login/status') {
    const key = q.get('session');
    try {
      const s = findSession(key || 'weibo');
      // ?fresh=1 → 跳过 60 秒缓存，真去打一次接口（「刷新登录状态」按钮用）
      const st = await loginStatusFor(s, { fresh: q.get('fresh') === '1' });
      return sendJson(res, { ok: true, status: st });
    } catch (e) { return fail(res, 400, e.message); }
  }
  if (req.method === 'GET' && p === '/api/exports') {
    return sendJson(res, { ok: true, files: recentExports(50) });
  }
  if (req.method === 'GET' && p === '/api/imported') {
    return sendJson(res, { ok: true, batches: listImported() });
  }
  if (req.method === 'GET' && p === '/api/download') {
    const target = String(q.get('path') || '');
    let full;
    try { full = safeJoin(target); } catch (e) { return fail(res, 400, e.message); }
    const rp = rel(full).replace(/\\/g, '/');
    if (!DOWNLOAD_DIRS.some((d) => rp.startsWith(d))) {
      return fail(res, 403, '只允许下载 exports/ · imports/ · imported/ 里的文件');
    }
    if (SENSITIVE_RE.test(rp)) return fail(res, 403, '这个文件含登录凭据或密钥，不允许下载');
    if (!exists(full) || fs.statSync(full).isDirectory()) return fail(res, 404, '文件不存在');
    return pipeFile(req, res, full, true);
  }
  if (req.method === 'GET' && p === '/api/preview') {
    // 导出预览：把记录裁到 N 条，让 UI 先给用户看一眼再决定导不导
    const opts = {
      sessions: q.get('sessions') && q.get('sessions') !== 'all' ? q.get('sessions').split(',') : 'all',
      since: q.get('since') || null,
      until: q.get('until') || null,
      limit: Number(q.get('limit') || 20),
      kinds: q.get('kinds') ? q.get('kinds').split(',') : [],
      mask: q.get('mask') === '1',
      images: q.get('images') !== '0',
    };
    try {
      const { groups, warnings } = collect(opts);
      return sendJson(res, {
        ok: true, warnings,
        groups: groups.map((g) => ({
          key: g.session.key, label: g.session.label, total: g.totalBeforeFilter,
          shown: g.rows.length, peerName: g.peerName, selfName: g.selfName,
          rows: g.rows.map((r) => ({
            time: r.time, date: r.date, from: r.from, sender: r.sender,
            kind: r.kind, text: r.text, images: r.images.length,
            ocr: r.ocr, vlm: r.vlm, card: r.card, links: r.links,
          })),
        })),
      });
    } catch (e) { return fail(res, 400, e.message); }
  }

  /* ---------- 写 ---------- */
  if (req.method !== 'POST') return fail(res, 405, 'Method Not Allowed');
  if (!guardWrite(req, res)) return;

  if (p === '/api/session') {
    try { return sendJson(res, { ok: true, ...upsertSession(await readJsonBody(req)) }); }
    catch (e) { return fail(res, 400, e.message); }
  }

  if (p === '/api/login/refresh') {
    // 「刷新登录状态」：把缓存掐掉，让下一次 /api/state 拿到的是刚校验过的结论
    invalidateLoginCache();
    return sendJson(res, { ok: true, refreshed: true });
  }

  if (p === '/api/login/cookie') {
    /* 手动通道：用户在自己浏览器里登录后，把 Cookie 复制出来贴进来。
     * 自动那条路（专用浏览器窗口 + 平台接口）走不通时的**兜底**，
     * 走的是同一个 Cookie 文件，后面抓取用法完全一样。 */
    const body = await readJsonBody(req);
    let s;
    try { s = findSession(body.session || 'weibo'); }
    catch (e) { return fail(res, 400, e.message); }
    if (s.imported) return fail(res, 400, '这是导入的只读备份，不需要登录');
    const r = saveCookie(s, body.cookie);         // 形状校验 + 落盘（在 login.mjs 里，不在这里重写一遍）
    if (!r.ok) return fail(res, 400, r.error);
    invalidateLoginCache(s.platform);
    // 当场真校验一次：让用户立刻知道"这串能用"还是"平台不认"
    const st = await loginStatusFor(s, { fresh: true });
    return sendJson(res, { ok: true, file: r.file, status: st, hint: COOKIE_HINT[s.platform] || '' });
  }

  if (p === '/api/login') {
    const body = await readJsonBody(req);
    let s;
    try { s = findSession(body.session || 'weibo'); }
    catch (e) { return fail(res, 400, e.message); }
    if (s.imported) return fail(res, 400, '这是导入的只读备份，不需要登录');
    // force=「重新登录」：清掉旧登录态（本地 Cookie 文件 + 浏览器里的 Cookie）再走完整流程。
    // 没有它，login.mjs 一看本地有 Cookie 文件就直接 return 0，浏览器窗口根本不弹。
    const force = body.force === true || body.force === '1' || body.force === 1;
    const args = [S('login.mjs'), '--session', s.key, '--timeout', String(body.timeout || 300)];
    if (force) args.push('--force');
    invalidateLoginCache(s.platform);          // 这次登录会改变状态，旧结论立刻作废
    const job = startJob({
      title: (force ? '重新登录 · ' : '授权登录 · ') + s.label,
      exe: SELF,
      args,
      tag: 'login:' + s.key,
    });
    return sendJson(res, { ok: true, job: job.summary(), force });
  }

  if (p === '/api/fetch') {
    const body = await readJsonBody(req);
    const keys = Array.isArray(body.sessions) && body.sessions.length ? body.sessions : ['weibo', 'bili'];
    const chosen = [];
    for (const k of keys) {
      try {
        const s = findSession(k);
        if (s.imported) return fail(res, 400, '会话「' + k + '」是导入的只读备份，不能抓取');
        chosen.push(s);
      } catch (e) { return fail(res, 400, e.message); }
    }
    if (!chosen.length) return fail(res, 400, '至少要选一个会话');
    // 先看这次会不会抓（steps 里有没有要联网登录的）；不指定 steps = 跑完整链路 = 要抓
    const steps = Array.isArray(body.steps) && body.steps.length ? body.steps : ['fetch', 'faces'];
    if (steps.some((x) => NEEDS_LOGIN.has(x))) {
      for (const s of chosen) if (await requireLoginOrFail(res, s)) return;
    }
    /* 勾了几个平台就建几个任务，交给**服务端队列**串行执行。
     *
     * ⚠ 旧实现是「建一个 job 就 break」，注释写着"前端会串行接着发起下一个"——
     *   可前端从来没实现这个接力。于是勾了「微博 + B站」点开始备份，**只有第一个会跑**，
     *   用户得手动取消微博、再单独选 B站才能跑 B站。这里改成一次性全建出来，
     *   队列保证同一时刻只有一个在跑（两平台同时跑会抢同一个浏览器调试端口、
     *   抢同一块写盘，日志也会糊在一起），前一个结束自动起下一个。 */
    const jobs = [];
    for (const s of chosen) {
      const a = [S('run_pipeline.mjs'), '--session', s.key, '--mode', body.mode || 'incr'];
      if (body.since) a.push('--since', body.since);
      if (body.until) a.push('--until', body.until);
      if (body.noImg) a.push('--no-img');
      if (body.compress) a.push('--compress');
      if (Array.isArray(body.steps) && body.steps.length) a.push('--steps', body.steps.join(','));
      jobs.push(startJob({ title: '备份 · ' + s.label, exe: SELF, args: a, tag: 'fetch:' + s.key },
        { queue: 'serial' }).summary());
    }
    writeStateFile({ lastFetchAt: new Date().toISOString(), lastFetchSessions: chosen.map((s) => s.key) });
    return sendJson(res, { ok: true, jobs, queued: chosen.map((s) => s.key) });
  }

  if (p === '/api/run') {
    const body = await readJsonBody(req);
    let s;
    try { s = findSession(body.session || 'weibo'); }
    catch (e) { return fail(res, 400, e.message); }
    if (s.imported && body.step !== 'doctor') return fail(res, 400, '导入的只读备份只能跑体检');
    const step = String(body.step || 'doctor');
    if (NEEDS_LOGIN.has(step) && await requireLoginOrFail(res, s)) return;
    const a = [S('run_pipeline.mjs'), '--session', s.key, '--steps', step];
    const job = startJob({ title: step + ' · ' + s.label, exe: SELF, args: a, tag: 'step:' + step });
    return sendJson(res, { ok: true, job: job.summary() });
  }

  if (p === '/api/job/kill') {
    const body = await readJsonBody(req);
    return sendJson(res, { ok: killJob(body.id) });
  }

  if (p === '/api/export') {
    const body = await readJsonBody(req);
    try {
      const r = runExport({
        sessions: (Array.isArray(body.sessions) && body.sessions.length) ? body.sessions : 'all',
        since: body.since || null,
        until: body.until || null,
        limit: body.limit ? Number(body.limit) : null,
        kinds: Array.isArray(body.kinds) ? body.kinds : [],
        mask: !!body.mask,
        ocr: body.ocr !== false,
        vlm: body.vlm !== false,
        images: body.images !== false,
        format: body.format || 'jsonl',
        name: body.name || 'dm',
      });
      writeStateFile({ lastExportAt: new Date().toISOString(), lastExportFormat: body.format || 'jsonl' });
      return sendJson(res, { ok: true, ...r });
    } catch (e) { return fail(res, 400, e.message); }
  }

  if (p === '/api/import') {
    const body = await readJsonBody(req);
    try {
      const r = importBackup({ srcPath: body.path, name: body.name, label: body.label });
      writeStateFile({ lastImportAt: new Date().toISOString(), lastImportBatch: r.batch });
      return sendJson(res, { ok: true, ...r });
    } catch (e) { return fail(res, 400, e.message); }
  }

  if (p === '/api/import/upload') {
    // 浏览器把文件当原始字节发上来（不做 multipart，省一层解析）
    const name = decodeURIComponent(String(req.headers['x-dm-filename'] || 'upload.zip'));
    // ⚠ 文件名要压成单段：如果允许 `..`，`imports/..` 就指到工作区根，
    //   写文件会变成往根目录写。safeSegment 把分隔符和开头的点都拍平。
    const base = path.basename(name).replace(/\.(zip|ZIP)$/, '');   // 别叠成 xxx.zip.zip
    const safeName = safeSegment(base, 'upload') + '.zip';
    const dir = ensureDir(path.join(ROOT, 'imports'));
    const dest = path.join(dir, safeName);
    const saved = await saveBody(req, dest);
    if (!saved.bytes) return fail(res, 400, '上传内容为空');
    try {
      const r = importBackup({ srcPath: dest, name: safeName.replace(/\.[^.]+$/, '') });
      writeStateFile({ lastImportAt: new Date().toISOString(), lastImportBatch: r.batch });
      return sendJson(res, { ok: true, uploaded: rel(dest), ...r });
    } catch (e) {
      return fail(res, 400, '已接收文件（imports/' + safeName + '），但导入失败：' + e.message);
    }
  }

  if (p === '/api/imported/delete') {
    const body = await readJsonBody(req);
    try { return sendJson(res, { ok: true, ...deleteImported(String(body.batch || '')) }); }
    catch (e) { return fail(res, 400, e.message); }
  }

  return fail(res, 404, '未知接口：' + p);
}

/* ================================================================
   静态文件
   ================================================================ */
const STATIC_PREFIXES = ['webui/', 'data/', 'bili/', 'imported/', 'exports/', 'imports/', 'assets/'];

function serveStatic(req, res, u) {
  let p = decodeURIComponent(u.pathname);
  if (p === '/' || p === '') p = '/webui/index.html';
  if (p === '/viewer' || p === '/viewer/') p = '/查看备份.html';
  const allowed = STATIC_PREFIXES.some((x) => p.startsWith('/' + x)) ||
    p === '/查看备份.html' || p === '/sessions.js' || p === '/方案评估报告.html';

  // 首页是从 `/` 提供的（不是 `/webui/`），而 index.html 里写的是相对路径
  // （href="style.css" / src="app.js"）—— 浏览器会按 `/style.css` 去要，
  // 于是落在白名单之外、整页样式和脚本全 404：页面看着在、其实一点都点不动。
  // 所以白名单外再兜一层：只要 `webui/` 下有同名文件就给它。
  // （仍然进不去 webui/ 以外的目录，白名单的意图没被放松。）
  let full = null;
  if (allowed) {
    try { full = safeJoin(p.slice(1)); } catch (e) { return sendText(res, '403 ' + e.message, 403); }
  } else {
    let alt = null;
    try { alt = safeJoin('webui/' + p.replace(/^\/+/, '')); } catch { return sendText(res, '403 Forbidden', 403); }
    if (exists(alt) && !fs.statSync(alt).isDirectory()) full = alt;
  }
  if (!full || !exists(full) || fs.statSync(full).isDirectory()) return sendText(res, '404 Not Found', 404);
  // 静态服务也要过一遍敏感名单：`data/` 是查看页必须读的目录，
  // 但里面的 cookie_header.txt 不该能被 http://127.0.0.1:8787/data/cookie_header.txt 取到。
  if (SENSITIVE_RE.test(rel(full).replace(/\\/g, '/'))) return sendText(res, '403 Forbidden', 403);
  return pipeFile(req, res, full, false);
}

/* ================================================================
   启动
   ================================================================ */
const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://' + HOST + ':' + PORT); }
  catch { return sendText(res, '400 Bad Request', 400); }

  try {
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
    return serveStatic(req, res, u);
  } catch (e) {
    const code = (e && e.httpCode) || 500;
    if (!res.headersSent) fail(res, code, String(e && e.message || e));
    else try { res.end(); } catch {}
  }
});

/* 端口被占用 / 被系统拦下时自动往后找 —— 常见于「重复双击启动」
   或 8787 恰好在系统的排除端口段（Hyper-V / WSL 会保留整段端口）。 */
let ACTUAL_PORT = PORT;
let PORT_SHIFT = 0;
let STARTED = false;

server.on('error', (e) => {
  // 已经起来之后再来一个错误（多半是某个连接的底层问题），
  // 绝不能再走下面的「退出进程」分支 —— 那会因为一次连接异常把整个界面干掉。
  if (STARTED) {
    console.error('  [!] 服务运行中出错（已忽略）：' + e.message);
    return;
  }
  if ((e.code === 'EADDRINUSE' || e.code === 'EACCES') && PORT_SHIFT < 20) {
    const prev = PORT + PORT_SHIFT;
    PORT_SHIFT += 1;
    const next = PORT + PORT_SHIFT;
    console.log(`  [!] 端口 ${prev} 用不了（${e.code === 'EACCES' ? '被系统保留/无权限' : '已被占用'}），改用 ${next} …`);
    setTimeout(() => { try { server.listen(next, HOST); } catch {} }, 30);
    return;
  }
  console.error('');
  console.error('  [x] 服务端启动失败：' + e.message);
  console.error('      换一个端口试试：node scripts/server.mjs --port 18787');
  console.error('');
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  STARTED = true;
  ACTUAL_PORT = server.address().port;
  const url = `http://${HOST}:${ACTUAL_PORT}/`;
  console.log('');
  console.log('==========================================');
  console.log('  私信备份 · 本地 WebUI');
  console.log('==========================================');
  console.log('  工作区    ' + ROOT);
  console.log('  地址      ' + url);
  console.log('  浏览器    ' + (findBrowser() || '（未找到 Edge / Chrome）'));
  console.log('  OCR 环境  ' + (findOcrPython() ? '已就绪' : '未安装（图内文字/图片描述会跳过）'));
  console.log('');
  console.log('  只监听本机回环地址，局域网访问不到。');
  console.log('  按 Ctrl+C 结束。');
  console.log('');

  if (ARGS.includes('--open')) {
    // 用默认浏览器打开（打不开也不影响，地址已经打在上面了）
    try {
      const b = findBrowser();
      if (b) {
        const c = spawn(b, [url], { detached: true, stdio: 'ignore' });
        c.unref();
      }
    } catch (e) {
      console.log('  [!] 自动打开浏览器失败：' + e.message);
    }
  }
});
