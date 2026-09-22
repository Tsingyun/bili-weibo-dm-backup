/* 私信备份 · 本地控制台前端
   ---------------------------------------------------------------
   和很多"前端调一堆接口"的项目不同，这里刻意保持很薄：
   所有真正的活（抓取 / OCR / 导出 / 解包）都在服务端和后端的脚本里，
   前端只做三件事：把状态显示出来、把用户的选择**原样**传下去、把日志流出来。
   这样 WebUI 和命令行两条路不会长出两套口径。 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

let STATE = null;
let LOG_LINES = [];
let flushTimer = null;
let es = null;
let currentJob = null;

/* ---------------- 基础 ---------------- */
async function api(path, opts = {}) {
  const o = { ...opts };
  if (o.method && o.method !== 'GET') {
    o.headers = Object.assign({ 'X-DM-WebUI': '1' }, o.headers || {});
    if (o.json !== undefined) {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(o.json);
      delete o.json;
    }
  }
  const r = await fetch(path, o);
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch { /* 非 JSON */ }
  if (!r.ok) {
    const msg = (j && j.error) || txt.slice(0, 300) || ('HTTP ' + r.status);
    const e = new Error(msg);
    e.status = r.status;             // 调用方要能认出 401（未登录）这类语义
    throw e;
  }
  return j;
}

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.hidden = true; }, kind === 'bad' ? 7000 : 3200);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function nfmt(n) { return (Number(n) || 0).toLocaleString('zh-CN'); }
function hsize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i ? v.toFixed(v < 10 ? 1 : 0) : v) + ' ' + u[i];
}
function dt(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? String(s) : d.toLocaleString('zh-CN', { hour12: false });
}

/* ---------------- 步骤切换 ---------------- */
function showStep(n) {
  n = String(n);
  $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== n; });
  $$('.step').forEach((b) => {
    const v = Number(b.dataset.go), cur = Number(n);
    b.classList.toggle('active', v === cur);
    b.classList.toggle('done', v < cur);
  });
  window.scrollTo({ top: 0 });
}
$$('.step').forEach((b) => b.addEventListener('click', () => showStep(b.dataset.go)));
$('#btnNext1').onclick = () => showStep(2);
$('#btnNext2').onclick = () => showStep(3);

/* ---------------- 状态 ---------------- */
async function refreshState() {
  try {
    STATE = await api('/api/state');
  } catch (e) {
    toast('读取状态失败：' + e.message, 'bad');
    return;
  }
  renderEnv(); renderLogin(); renderSessions(); renderImported();
  renderExportForm(); renderExports(); renderRunTable(); renderJobs();
  $('#rootPath').textContent = STATE.root;
  // 真实端口要显眼：文档里写的是 8787，但被占用/被系统保留时服务会自己往后挪，
  // 用户照着文档敲 8787 会连不上（本机实测过 8787 直接 EACCES）。
  $('#svcAddr').textContent = '服务地址 http://127.0.0.1:' + STATE.port + '/';
}

function renderEnv() {
  const e = STATE.env;
  const chips = [
    ['Node ' + STATE.node, true],
    ['浏览器', !!e.browser],
    ['OCR 环境', e.ocrReady],
    ['图片描述 Key', e.glmKey],
    ['浏览器已运行', e.browserUp],
    ['配置正常', !STATE.configError],
  ];
  $('#envChips').innerHTML = chips
    .map(([t, ok]) => `<span class="chip ${ok ? 'on' : 'off'}">${esc(t)}${ok ? '' : ' ✗'}</span>`)
    .join('');

  // 便携包会自带 runtime\node\node.exe：新手最怕「是不是漏装了什么」，
  // 所以第一张卡就直接给结论，而不是让他自己去猜 Node 是哪来的。
  const rt = STATE.runtime || {};
  const rtText = rt.builtin
    ? '用包内自带的 Node ' + STATE.node + '（不用另外安装，也不写进系统环境）'
    : '用系统已安装的 Node ' + STATE.node + '（本项目零第三方依赖，不需要 npm install）';

  // 路径里的中文/空格不会让程序直接崩，但个别环节（浏览器调试端口、命令行传参）
  // 历史上真出过问题 —— 提前提醒一次，别等卡住了才回头怀疑路径。
  const pathBad = /[\u3400-\u9FFF\uF900-\uFAFF]/.test(STATE.root) || /\s/.test(STATE.root);
  const pathText = pathBad
    ? STATE.root + ' —— ⚠ 含中文或空格。多数情况能用；万一登录或抓取卡住，' +
      '把整个文件夹挪到 D:\\dm-backup 这类纯英文、无空格的路径再试。'
    : STATE.root + '（纯英文、无空格，最稳妥）';

  const items = [
    ['运行环境', true, rtText],
    ['工作区路径', !pathBad, pathText],
    ['Edge / Chrome', !!e.browser, e.browser || '没找到 —— 授权登录和抓取都需要它，装上 Edge 即可'],
    ['专用浏览器窗口', e.browserUp, e.browserUp ? '正在运行，调试端口 ' + STATE.cdpPort + ' 已就绪' : '还没启动（点「授权登录」会自己拉起来）'],
    ['OCR 环境（图内文字）', e.ocrReady, e.ocrReady ? e.ocrPython : '未安装 —— 双击「命令/图片与OCR/安装OCR环境.cmd」可启用；不装也不影响备份正文'],
    ['图片描述 Key', e.glmKey, e.glmKey ? '已配置（只会把「没有文字的照片」发给免费模型）' : '未配置 —— 会跳过这一步，不影响其它功能'],
    ['会话配置', !STATE.configError, STATE.configError || '读取正常：' + STATE.manifest],
  ];
  $('#envGrid').innerHTML = items.map(([t, ok, d]) => `
    <div class="card">
      <h3><span class="tag ${ok ? 'ok' : 'warn'}">${ok ? '就绪' : '注意'}</span>${esc(t)}</h3>
      <div class="kv">${esc(d)}</div>
    </div>`).join('');

  if (STATE.configError) {
    $('#envGrid').insertAdjacentHTML('afterbegin',
      `<div class="card errbox" style="grid-column:1/-1"><h3>配置有问题</h3>
       <div class="kv">${esc(STATE.configError)}</div>
       <div class="kv">修好后点「重新检查」。文件位置：<code>${esc(STATE.manifest)}</code></div></div>`);
  }
}

/* ---------------- 授权登录 ----------------
   ⚠ 这里的每个字都必须和「真正抓取时会发生什么」一致：
   以前只拿本地 Cookie 文件的**形状**（有没有 SUB=）就显示"已登录"，
   而过期的 Cookie 里照样有 SUB= —— 于是界面说已登录、抓取却报未登录。
   现在登录态是**真打了一次平台接口**得到的（login.mjs 的 verifyCookie），
   所以这里显示的"已登录/已失效"就是抓取时的那个结论。 */
function loginStateText(lg) {
  if (lg.loggedIn) {
    const from = lg.source === 'browser' ? '浏览器' : '本地 Cookie 文件';
    return `<span class="tag ok">已登录</span><span class="dim">来源：${esc(from)}` +
      (lg.account ? ` · 账号：${esc(lg.account)}` : '') + '</span>';
  }
  if (lg.invalidReason === 'expired') {
    return '<span class="tag warn">Cookie 已失效</span><span class="dim">文件还在，但平台接口已经不认它了 —— 需要重新登录</span>';
  }
  if (lg.invalidReason === 'network') {
    // 「连不上接口」是**不知道**，不是「没登录」：已存的数据一点不受影响，备份照常能跑。
    // 真想确认的话，走下面「手动把 Cookie 贴进来」那条兜底路线。
    return '<span class="tag warn">暂时无法校验</span><span class="dim">连不上平台接口，没法确认 —— 这不是"未登录"，' +
      '已存的数据不受影响、备份照常能跑；想确认就点「刷新登录状态」，或用下面「手动把 Cookie 贴进来」。</span>';
  }
  if (lg.hasSavedCookie) {
    return '<span class="tag warn">有 Cookie 但没通过校验</span><span class="dim">点「重新登录」换一份新的</span>';
  }
  return '<span class="tag no">未登录</span>';
}

function renderLogin() {
  const live = STATE.sessions.filter((s) => !s.imported);
  if (!live.length) { $('#loginCards').innerHTML = '<div class="card">还没有可登录的会话，先去「3 选择会话」加一个。</div>'; return; }
  $('#loginCards').innerHTML = live.map((s) => {
    const lg = s.login || {};
    const btnTxt = lg.loggedIn ? '重新登录（清除旧登录态）' : '开始授权登录';
    return `
      <div class="card">
        <h3>${esc(s.label)} <span class="dim">${esc(s.platform)}</span></h3>
        <div class="kv" style="margin-bottom:10px">${loginStateText(lg)}</div>
        <div class="kv" style="margin-bottom:10px">Cookie 文件：<code>${esc(s.dir)}/cookie_header.txt</code></div>
        <button class="btn" data-login="${esc(s.key)}" data-force="${lg.loggedIn ? '1' : '0'}">${btnTxt}</button>
      </div>`;
  }).join('');
  $$('[data-login]').forEach((b) =>
    b.addEventListener('click', () => startLogin(b.dataset.login, b, b.dataset.force === '1')));
  // 手动 Cookie 面板的会话下拉（跟着可登录会话一起刷新）
  const sel = $('#mc_session');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = live.map((s) => `<option value="${esc(s.key)}">${esc(s.label)}（${esc(s.platform)}）</option>`).join('');
    if (live.some((s) => s.key === cur)) sel.value = cur;
  }
}

/* 手动 Cookie 兜底路线：专用浏览器窗口起不来、或本机连不上平台接口时用。
   存的位置和自动登录一模一样（同一个 cookie_header.txt），后面备份用法也一模一样。 */
$('#btnSaveCookie').onclick = async () => {
  const key = $('#mc_session').value;
  const cookie = $('#mc_cookie').value;
  const out = $('#mcResult');
  if (!key) return toast('先选一个会话', 'bad');
  if (!String(cookie || '').trim()) return toast('Cookie 是空的 —— 先按上面的步骤复制一整串', 'bad');
  out.textContent = '正在保存并校验…';
  try {
    await api('/api/login/cookie', { method: 'POST', json: { session: key, cookie } });
    await refreshState();
    const lg = (STATE.sessions.find((x) => x.key === key) || {}).login || {};
    if (lg.loggedIn) {
      out.innerHTML = '<span class="tag ok">已保存，校验通过</span>' + (lg.account ? ' 账号：' + esc(lg.account) : '');
      $('#mc_cookie').value = '';
      toast('Cookie 已保存，校验通过', 'ok');
    } else if (lg.invalidReason === 'network') {
      out.innerHTML = '<span class="tag warn">已保存，但这会儿连不上接口，没法确认</span>';
      toast('Cookie 已保存，稍后点「刷新登录状态」再确认', 'bad');
    } else {
      out.innerHTML = '<span class="tag no">已保存，但平台接口不认这串</span>';
      toast('这串 Cookie 平台不认 —— 确认复制的是登录后的完整 cookie', 'bad');
    }
  } catch (e) {
    out.textContent = '';
    toast('保存失败：' + e.message, 'bad');
  }
};

/**
 * ⚠ 以前这里点完按钮就 `showStep(4)` 跳到「选择范围并备份」——
 *   登录明明发生在第 2 步，跳走只会让人以为"没反应/跳错了"。
 *   现在**留在第 2 步**，把等待状态显示在按钮和提示位上。
 */
async function startLogin(key, btn, force) {
  if (force && !confirm('「重新登录」会清除本机保存的登录 Cookie，然后打开浏览器窗口让你重新登录一次。\n\n继续吗？')) return;
  btn.disabled = true;
  const oldTxt = btn.textContent;
  btn.textContent = force ? '正在清除旧登录态并打开登录窗口…' : '正在打开登录窗口…';
  const hint = $('#loginHint');
  try {
    const r = await api('/api/login', { method: 'POST', json: { session: key, force: !!force } });
    hint.hidden = false;
    hint.textContent = (force ? '已清除旧登录态：' : '') +
      '请在弹出的专用浏览器窗口里完成登录，登录成功后这里会自动更新。（实时日志在第 4 步底部）';
    toast(force ? '已清除旧登录态，请在浏览器窗口里重新登录' : '已打开专用浏览器窗口，请在窗口里完成登录');
    watchJob(r.job.id, (force ? '重新登录 · ' : '授权登录 · ') + key, async (status, code) => {
      btn.textContent = oldTxt;
      btn.disabled = false;
      if (hint) { hint.hidden = true; hint.textContent = ''; }
      // ⚠ 两个坑都必须避开，否则会把"刚登录成功"误报成"没登录"：
      //   1) 服务端登录态有 60 秒缓存 —— 登录期间的那几次轮询会把"未登录"写进缓存，
      //      任务刚结束就刷新会拿回旧结论。先 /api/login/refresh 把缓存掐掉。
      //   2) refreshState() 是异步的 —— 不 await 就读 STATE，读到的还是刷新前的旧值。
      try { await api('/api/login/refresh', { method: 'POST', json: {} }); } catch { /* 失败也照样刷新一次 */ }
      await refreshState();
      const lg = (STATE.sessions.find((x) => x.key === key) || {}).login || {};
      if (lg.loggedIn) {
        toast('登录成功' + (lg.account ? '（账号：' + lg.account + '）' : '') + '，可以开始备份了', 'ok');
      } else if (lg.invalidReason === 'network') {
        toast('Cookie 已保存，但这会儿连不上平台接口，没法确认 —— 稍后点「刷新登录状态」再试', 'bad');
      } else if (code === 0) {
        // 脚本自己认为成功了（Cookie 已存、页面已进业务页），只是接口这一轮没确认
        toast('Cookie 已保存，但平台接口这次没确认成功 —— 点「刷新登录状态」再试一次', 'bad');
      } else {
        toast('还没拿到有效登录态 —— 请看第 4 步底部的日志，里面会打印当前页面和 Cookie 的情况', 'bad');
      }
    });
  } catch (e) {
    toast('发起登录失败：' + e.message, 'bad');
    btn.textContent = oldTxt;
    btn.disabled = false;
  }
}
$('#btnRefreshLogin').onclick = async () => {
  try { await api('/api/login/refresh', { method: 'POST', json: {} }); } catch { /* 失败也照样刷新一次界面 */ }
  await refreshState();
  toast('已重新校验登录状态');
};

/* ---------------- 会话表 ---------------- */
function renderSessions() {
  const rows = STATE.sessions.map((s) => {
    const badge = s.imported
      ? '<span class="tag warn">导入只读</span>'
      : (s.peer.uid ? '<span class="tag ok">已配 uid</span>' : '<span class="tag no">缺 uid</span>');
    const data = s.hasData
      ? `${nfmt(s.counts.messages)} 条 · ${nfmt(s.counts.images)} 图`
      : '<span class="dim">还没有数据</span>';
    const range = s.range.first
      ? `${esc(String(s.range.first).slice(0, 10))} ~ ${esc(String(s.range.last).slice(0, 10))}`
      : '—';
    return `<tr>
      <td><b>${esc(s.label)}</b><br><span class="dim">${esc(s.key)}</span></td>
      <td>${esc(s.platform)}</td>
      <td>${badge}<br><span class="dim">${esc(s.peer.uid || '—')}</span></td>
      <td>${data}<br><span class="dim">${range}</span></td>
      <td><code>${esc(s.dir)}</code><br><span class="dim">${esc(s.human)} · ${nfmt(s.files)} 文件</span></td>
      <td>
        <button class="btn sm" data-edit="${esc(s.key)}">编辑</button>
        ${s.imported ? '' : `<button class="btn sm" data-del="${esc(s.key)}">移除</button>`}
      </td>
    </tr>`;
  }).join('');
  $('#sessTable').innerHTML = `
    <thead><tr><th>会话</th><th>平台</th><th>对方的 uid</th><th>数据</th><th>存放位置</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="dim">还没有任何会话</td></tr>'}</tbody>`;

  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => fillForm(b.dataset.edit)));
  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('从清单里移除会话「' + b.dataset.del + '」？\n（只删配置，数据目录不会被删掉）')) return;
    try {
      const r = await api('/api/session', { method: 'POST', json: { action: 'delete', key: b.dataset.del } });
      toast(r.note || '已移除', 'ok');
      refreshState();
    } catch (e) { toast(e.message, 'bad'); }
  }));
}

function fillForm(key) {
  const s = STATE.sessions.find((x) => x.key === key);
  if (!s) return;
  $('#f_key').value = s.key;
  $('#f_label').value = s.label;
  $('#f_platform').value = s.platform;
  $('#f_peeruid').value = s.peer.uid;
  $('#f_peername').value = s.peer.name;
  $('#f_dir').value = s.dir;
  $('.pane[data-pane="3"] details').open = true;
  toast('已把「' + s.key + '」填进下面的表单，改完点保存');
}
$('#btnClearSess').onclick = () => {
  ['f_key', 'f_label', 'f_peeruid', 'f_peername', 'f_dir'].forEach((i) => { $('#' + i).value = ''; });
};
$('#btnSaveSess').onclick = async () => {
  const body = {
    key: $('#f_key').value.trim(),
    label: $('#f_label').value.trim(),
    platform: $('#f_platform').value,
    peer: { uid: $('#f_peeruid').value.trim(), name: $('#f_peername').value.trim() },
    dir: $('#f_dir').value.trim(),
  };
  if (!body.key) return toast('会话 key 不能为空', 'bad');
  try {
    await api('/api/session', { method: 'POST', json: body });
    toast('已保存会话「' + body.key + '」', 'ok');
    refreshState();
  } catch (e) { toast(e.message, 'bad'); }
};

/* ---------------- 备份（抓取） ---------------- */

/* 一轮备份可能包含多个平台的任务（服务端把它们排成一个队列、串行执行）。
   这里按顺序"看"：第一个跑完自动接上第二个，日志接着往下写。
   ⚠ 旧实现只 watch 了 jobs[0]，所以勾了微博+B站也只跑微博 —— 
     修复在服务端（N 个任务都建出来入队），这里负责把日志一段段接起来。 */
let chainIds = [];                     // 本轮任务的全部 id（「停止」时要把排队的也一起取消）
function runJobChain(list) {
  chainIds = list.map((j) => j.id);
  let i = 0;
  const next = () => {
    i++;
    if (i >= list.length) { chainIds = []; return; }
    const nx = list[i];
    toast('接着跑：' + nx.title, 'ok');
    watchJob(nx.id, nx.title, next, { keepLog: true });
  };
  watchJob(list[0].id, list[0].title, next);
}

$('#btnFetch').onclick = async () => {
  const keys = $$('.pick').filter((c) => c.checked).map((c) => c.dataset.key);
  if (!keys.length) return toast('至少要勾一个平台', 'bad');
  const noImg = $('#f_noimg').checked;
  const body = {
    sessions: keys,
    mode: $('#f_mode').value,
    since: $('#f_since').value || null,
    until: $('#f_until').value || null,
    noImg,
    compress: $('#f_compress').checked,
    steps: noImg ? ['fetch', 'snapshot', 'doctor'] : ['fetch', 'faces', 'ocr', 'vlm', 'snapshot', 'doctor'],
  };
  try {
    const r = await api('/api/fetch', { method: 'POST', json: body });
    toast('已开始：' + r.queued.join('、') +
      (r.jobs.length > 1 ? '（串行执行，一个跑完自动接下一个）' : ''), 'ok');
    if (r.jobs.length) runJobChain(r.jobs);
  } catch (e) {
    toast(e.message, 'bad');
    // 服务端在起任务前就查过登录态；没登录会回 401 —— 那就把人带回该去的那一步，
    // 而不是让他对着一条错误日志发呆。
    if (e.status === 401) { showStep(2); toast('还没有有效的登录态 —— 请先在「2 授权登录」里登录', 'bad'); }
  }
};
$('#btnStop').onclick = async () => {
  if (!currentJob) return toast('当前没有在跑的任务');
  try {
    await api('/api/job/kill', { method: 'POST', json: { id: currentJob } });
    // 后面还排着的也一并取消 —— 否则杀了当前这个，队列里的下一个会自动开跑，
    // 用户看到的是"点了停止它又自己跑起来了"。
    const rest = chainIds.filter((id) => id !== currentJob);
    for (const id of rest) { try { await api('/api/job/kill', { method: 'POST', json: { id } }); } catch { /* 单个失败不挡其它 */ } }
    chainIds = [];
    toast(rest.length ? '已请求停止（后面排队的 ' + rest.length + ' 个也一起取消）' : '已请求停止');
  } catch (e) { toast(e.message, 'bad'); }
};

function logAppend(lines) {
  for (const l of lines) LOG_LINES.push(l);
  if (LOG_LINES.length > 4000) LOG_LINES = LOG_LINES.slice(-3000);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const pre = $('#log');
    pre.textContent = LOG_LINES.join('\n');
    pre.scrollTop = pre.scrollHeight;
  }, 150);
}

/**
 * 盯一个任务，直到它结束。
 * @param opts.keepLog  true = 不清空日志（一轮里跑第二个平台时用，把两段输出接在一起看）
 * ⚠ 状态里 `queued`（排队中）**不是结束**：勾了两个平台时，第二个任务建出来就是排队状态，
 *   若按"非 running 即结束"处理，第一个平台刚跑完就会把整轮当成结束。
 */
function watchJob(id, title, onEnd, opts = {}) {
  if (es) { es.close(); es = null; }
  let ended = false;
  const finish = (status, code) => {
    if (ended) return;               // 结束回调只能跑一次（正常结束和连接中断都可能触发）
    ended = true;
    // onEnd 可能是 async（里面要 await 刷新状态）——用 Promise 包一层，
    // 否则 async 函数抛出的异常会变成未处理的 rejection，也接不住。
    if (typeof onEnd === 'function') {
      Promise.resolve().then(() => onEnd(status, code)).catch(() => { /* 回调自己出错不该影响界面 */ });
    }
  };
  currentJob = id;
  if (!opts.keepLog) { LOG_LINES = []; $('#log').textContent = ''; }
  else if (LOG_LINES.length) logAppend(['', '════════ ' + title + ' ════════']);
  $('#logTitle').textContent = '运行日志 · ' + title;
  $('#logStat').textContent = '运行中…';

  const ENDED = (st) => st !== 'running' && st !== 'queued';
  es = new EventSource('/api/job/stream?id=' + encodeURIComponent(id));
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'line') logAppend([m.line]);
    else if (m.t === 'status') {
      $('#logStat').textContent = m.status === 'running'
        ? '运行中…（已输出 ' + nfmt(m.lines) + ' 行）'
        : (m.status === 'queued'
          ? '排队中…（等前面那个平台跑完就自动开始）'
          : ({ done: '完成', failed: '有失败（退出码 ' + m.code + '）', error: '启动失败', cancelled: '已取消' }[m.status] || m.status));
      if (ENDED(m.status)) {
        es.close(); es = null; currentJob = null;
        logAppend(['', '—— 任务结束：' + $('#logStat').textContent + ' ——']);
        if (m.status === 'failed') {
          const tip = {
            2: '没有登录凭据 —— 先在第 2 步点「授权登录」。',
            3: '登录态已失效 —— 重新点一次「授权登录」。',
            4: '配置没填 —— 回到第 3 步，把对方的 uid 填上。',
          }[m.code];
          if (tip) logAppend(['提示：' + tip]);
        }
        refreshState();
        finish(m.status, m.code);
      }
    }
  };
  es.onerror = () => {
    if (es) { es.close(); es = null; }
    $('#logStat').textContent = '连接中断（任务可能还在跑，可点「最近的任务」看结果）';
    finish('error', null);
  };
}
$('#btnRefresh').onclick = () => { refreshState(); toast('已重新检查'); };

/* ---------------- 加载他人备份 ---------------- */
function renderImported() {
  const rows = (STATE.imported || []).map((b) => `
    <tr>
      <td><b>${esc(b.batch)}</b><br><span class="dim">${esc(dt(b.importedAt))} · 来自 ${esc(b.from || '—')}</span></td>
      <td>${b.sessions.map((s) => `<span class="tag">${esc(s.label)}</span>`).join('')}</td>
      <td class="num">${nfmt(b.files)} 文件<br><span class="dim">${esc(b.human)}</span></td>
      <td>
        <a class="btn sm" href="/viewer" target="_blank" rel="noopener">查看</a>
        <button class="btn sm" data-impdel="${esc(b.batch)}">删除</button>
      </td>
    </tr>`).join('');
  $('#impTable').innerHTML = `
    <thead><tr><th>批次</th><th>包含会话</th><th>大小</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="dim">还没有导入过别人的备份</td></tr>'}</tbody>`;
  $$('[data-impdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('删除导入批次「' + b.dataset.impdel + '」？\n（只删这份导入的数据，你自己的备份不受影响）')) return;
    try {
      await api('/api/imported/delete', { method: 'POST', json: { batch: b.dataset.impdel } });
      toast('已删除', 'ok'); refreshState();
    } catch (e) { toast(e.message, 'bad'); }
  }));
}

async function doImportPath(p) {
  if (!p) return toast('先填一个路径', 'bad');
  toast('正在加载…');
  try {
    const r = await api('/api/import', { method: 'POST', json: { path: p } });
    toast('已导入 ' + r.sessions.length + ' 个会话（' + r.batch + '）', 'ok');
    refreshState();
  } catch (e) { toast('导入失败：' + e.message, 'bad'); }
}
$('#btnImportPath').onclick = () => doImportPath($('#f_importPath').value.trim());

async function uploadFile(file) {
  toast('正在上传并解包：' + file.name);
  try {
    const r = await fetch('/api/import/upload', {
      method: 'POST',
      headers: { 'X-DM-WebUI': '1', 'X-DM-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    toast('已导入 ' + j.sessions.length + ' 个会话（' + j.batch + '）', 'ok');
    refreshState();
  } catch (e) { toast('导入失败：' + e.message, 'bad'); }
}

const dz = $('#dropZone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.add('hot');
}));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.remove('hot');
}));
dz.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) uploadFile(f);
});

/* ---------------- 导出 ---------------- */
function exportOpts() {
  const sessions = $$('.expick').filter((c) => c.checked).map((c) => c.dataset.key);
  const kinds = $$('.expkind').filter((c) => c.checked).map((c) => c.dataset.kind);
  return {
    sessions,
    since: $('#e_since').value || null,
    until: $('#e_until').value || null,
    limit: $('#e_limit').value ? Number($('#e_limit').value) : null,
    kinds,
    mask: $('#e_mask').checked,
    images: $('#e_images').checked,
    ocr: $('#e_ocr').checked,
    vlm: $('#e_vlm').checked,
    format: $('#e_format').value,
  };
}

function renderExportForm() {
  const withData = STATE.sessions;
  $('#exportSessions').innerHTML = '<span class="dim" style="align-self:center">会话：</span>' +
    (withData.map((s) => `<label class="chk"><input type="checkbox" class="expick" data-key="${esc(s.key)}" ${withData.length === 1 ? 'checked' : ''}> ${esc(s.label)}${s.imported ? '（导入）' : ''}</label>`).join('')
      || '<span class="dim">还没有会话</span>');
  $('#exportKinds').innerHTML = '<span class="dim" style="align-self:center">只导：</span>' +
    STATE.kinds.map((k) => `<label class="chk"><input type="checkbox" class="expkind" data-kind="${esc(k.id)}" checked> ${esc(k.label)}</label>`).join('');
  $('#e_format').innerHTML = STATE.formats.map((f) => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join('');
}

function renderExports() {
  const rows = (STATE.exports || []).map((f) => `
    <tr>
      <td><b>${esc(f.name)}</b><br><span class="dim">${esc(dt(f.mtime))}</span></td>
      <td class="num">${esc(f.human)}</td>
      <td>
        <a class="btn sm" href="/api/download?path=${encodeURIComponent(f.rel)}">下载</a>
        <a class="btn sm ghost" href="/${encodeURIComponent(f.rel).replace(/%2F/g, '/')}" target="_blank" rel="noopener">在浏览器打开</a>
      </td>
    </tr>`).join('');
  $('#expTable').innerHTML = `
    <thead><tr><th>文件</th><th>大小</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="dim">还没有导出过</td></tr>'}</tbody>`;
}

$('#btnPreview').onclick = async () => {
  const o = exportOpts();
  const q = new URLSearchParams({
    sessions: o.sessions.length ? o.sessions.join(',') : 'all',
    limit: '20',
    mask: o.mask ? '1' : '0',
    images: o.images ? '1' : '0',
  });
  if (o.since) q.set('since', o.since);
  if (o.until) q.set('until', o.until);
  if (o.kinds.length) q.set('kinds', o.kinds.join(','));
  try {
    const r = await api('/api/preview?' + q.toString());
    const box = $('#previewList');
    box.innerHTML = '';
    let total = 0;
    for (const g of r.groups) {
      total += g.rows.length;
      box.insertAdjacentHTML('beforeend',
        `<div class="pv-day">${esc(g.label)} —— 该会话共 ${nfmt(g.total)} 条，下面预览最后 ${nfmt(g.shown)} 条（对方：${esc(g.peerName)}／我：${esc(g.selfName)}）</div>`);
      for (const row of g.rows) {
        const ex = [];
        if (row.ocr) ex.push('图内文字：' + row.ocr);
        if (row.vlm) ex.push('图片描述：' + row.vlm);
        if (row.card && row.card.title) ex.push('卡片：' + row.card.title);
        if (row.images) ex.push(row.images + ' 张图片');
        box.insertAdjacentHTML('beforeend', `
          <div class="pv ${row.from === 'me' ? 'me' : ''}">
            <div class="who">${esc(row.date || '')} ${esc(row.time || '')} · ${esc(row.sender || (row.from === 'me' ? '我' : '对方'))}${
              row.kind !== 'count' ? ' <span class="tag">' + esc(row.kind) + '</span>' : ''}</div>
            <div>${esc(row.text).replace(/\n/g, '<br>')}</div>
            ${ex.length ? `<div class="ex">${esc(ex.join('　'))}</div>` : ''}
          </div>`);
      }
    }
    if (!total) box.innerHTML = '<div class="dim">这些条件下一条都没有 —— 换个时间范围或把分类勾全试试。</div>';
    $('#previewStat').textContent = '共 ' + total + ' 条' + (r.warnings.length ? '（' + r.warnings.join('；') + '）' : '');
    $('#previewBox').hidden = false;
  } catch (e) { toast('预览失败：' + e.message, 'bad'); }
};

$('#btnExport').onclick = async () => {
  const o = exportOpts();
  const btn = $('#btnExport');
  btn.disabled = true;
  toast('正在导出…');
  try {
    const r = await api('/api/export', { method: 'POST', json: o });
    const f = r.files[0];
    toast('导出完成：' + f.name + '（' + f.human + '）', 'ok');
    $('#previewBox').hidden = true;
    refreshState();
  } catch (e) { toast('导出失败：' + e.message, 'bad'); }
  finally { btn.disabled = false; }
};

/* ---------------- 维护动作 ---------------- */
const RUN_STEPS = [
  ['fetch', '只抓取（不跑索引）', '把新消息拉下来，后面几步留给需要时再跑'],
  ['faces', '同步表情图', '把 [委屈] 这类文字表情换成官方图片'],
  ['ocr', '识别图内文字', '本地 OCR，图片不外传；需要先装 OCR 环境'],
  ['vlm', '生成图片描述', '只处理「没有文字的照片」，用免费模型；需要配 Key'],
  ['snapshot', '存索引快照', '给当前索引留一份，出问题能回退'],
  ['doctor', '一键体检', '查数据一致性、缺失图片等'],
];
function renderRunTable() {
  const live = STATE.sessions.filter((s) => !s.imported);
  const rows = [];
  for (const s of live) {
    for (const [step, label, desc] of RUN_STEPS) {
      rows.push(`<tr>
        <td><b>${esc(s.label)}</b></td>
        <td>${esc(label)}<br><span class="dim">${esc(desc)}</span></td>
        <td><button class="btn sm" data-run="${esc(s.key)}" data-step="${esc(step)}">运行</button></td>
      </tr>`);
    }
  }
  $('#runTable').innerHTML = `
    <thead><tr><th>会话</th><th>动作</th><th></th></tr></thead>
    <tbody>${rows.join('') || '<tr><td colspan="3" class="dim">还没有会话</td></tr>'}</tbody>`;
  $$('[data-run]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定要单独运行这一步吗？\n' + b.dataset.step + ' · ' + b.dataset.run)) return;
    try {
      const r = await api('/api/run', { method: 'POST', json: { session: b.dataset.run, step: b.dataset.step } });
      showStep(4);
      watchJob(r.job.id, b.dataset.step + ' · ' + b.dataset.run);
    } catch (e) {
      toast(e.message, 'bad');
      if (e.status === 401) { showStep(2); toast('这一步需要登录 —— 请先在「2 授权登录」里登录', 'bad'); }
    }
  }));
}

function renderJobs() {
  const rows = (STATE.jobs || []).map((j) => {
    const st = { running: '<span class="tag warn">运行中</span>', done: '<span class="tag ok">完成</span>', failed: '<span class="tag no">失败</span>', error: '<span class="tag no">启动失败</span>' }[j.status] || esc(j.status);
    return `<tr>
      <td>${st} <b>${esc(j.title)}</b></td>
      <td class="num">${nfmt(j.lines)} 行<br><span class="dim">${esc(dt(j.startedAt))}</span></td>
      <td><button class="btn sm" data-look="${esc(j.id)}" data-title="${esc(j.title)}">看日志</button></td>
    </tr>`;
  }).join('');
  $('#jobsTable').innerHTML = `
    <thead><tr><th>任务</th><th>输出</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="dim">本次会话还没有跑过任务</td></tr>'}</tbody>`;
  $('#jobsStat').textContent = (STATE.env.running ? '有任务正在跑' : '都空闲') +
    '（只记本次运行，重启后清空）';
  $$('[data-look]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api('/api/job?id=' + encodeURIComponent(b.dataset.look));
      showStep(4);
      LOG_LINES = r.lines.slice();
      $('#log').textContent = LOG_LINES.join('\n');
      $('#logTitle').textContent = '运行日志 · ' + b.dataset.title;
      $('#logStat').textContent = r.job.status === 'running' ? '运行中…' : ('已结束（' + (r.job.code == null ? '?' : '退出码 ' + r.job.code) + '）');
      const pre = $('#log'); pre.scrollTop = pre.scrollHeight;
      if (r.job.status === 'running') watchJob(r.job.id, b.dataset.title);
    } catch (e) { toast(e.message, 'bad'); }
  }));
}

/* ---------------- 启动 ---------------- */
refreshState();

// 兜底轮询：页面切到后台就不刷；有任务在跑时日志走 SSE，这里也不抢。
setInterval(() => {
  if (document.hidden) return;
  if (STATE && STATE.env && STATE.env.running) return;
  refreshState();
}, 20000);

// 出错别静默——控制台里能看到就够，别弹窗打扰。
window.addEventListener('unhandledrejection', (e) => {
  console.error('[dm-webui] 未处理的 Promise 异常：', e.reason);
});
