#!/usr/bin/env node
/**
 * 授权登录（WebUI 的「授权登录」这一步）
 * ===============================================================
 * 这件事的本质：**我们不去碰账号密码**，只做两件本分事 ——
 *   1. 用项目自己的专用浏览器 profile（`.edge-profile/`）拉起一个带调试端口的
 *      Edge/Chrome 窗口，并把它开到该平台的登录/消息页；
 *   2. 用户在窗口里自行扫码 / 输密码登录后，通过 CDP 读回浏览器里的 Cookie，
 *      落盘成 `<数据目录>/cookie_header.txt`。
 *
 * 于是：Cookie 只存在本机、只存在这一个文件里；程序从不经过任何第三方服务器，
 * 也不需要用户把密码交给程序。
 *
 * 平台差异**不写死 session key**：要什么 Cookie 由会话的 `platform` 决定
 * （weibo → SUB，bili → SESSDATA），key 换成别的名字也照样能用。
 *
 * 用法：
 *   node scripts/login.mjs --session weibo
 *   node scripts/login.mjs --session bili --timeout 600
 *   node scripts/login.mjs --session weibo --status     # 只报告，不开浏览器
 *   node scripts/login.mjs --session weibo --force      # 「重新登录」：清掉旧登录态重来
 *
 * `--status` 的退出码：0 已登录 · 3 未登录/已失效 · 4 连不上平台接口，没法判定
 *   （4 不是"未登录"：断网时把人赶去重新扫码是误诊）
 *
 * ⚠ 登录态判定**必须真的打一次接口**（见下面的 VERIFY），不能只看本地有没有 Cookie 文件：
 *   过期的 Cookie 里照样有 SUB=，只看文件会把"已过期"显示成"已登录"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, findSession } from './sessions.mjs';
import { CDP, sleep } from './cdp_lib.mjs';

export const PORT = Number(process.env.DM_CDP_PORT || 9333);

/** 每个平台「登录成功」的标志性 Cookie；不是登录态判定的全部，但足够可靠 */
const REQUIRED_COOKIE = { weibo: /(^|;\s*)SUB=/, bili: /(^|;\s*)SESSDATA=/ };
/** Cookie 域名过滤（只留这个平台自己的，避免把无关域名的 cookie 拼进来） */
const DOMAIN_RE = { weibo: /weibo|sina/i, bili: /bilibili/i };
/** 登录页 */
const LOGIN_URL = {
  weibo: 'https://api.weibo.com/chat',
  bili: 'https://message.bilibili.com/',
};

/* ⚠ 登录态校验：必须真的去打一次接口，不能只看本地有没有 Cookie 文件。
 *   旧实现用正则匹配本地文件里的 `SUB=` / `SESSDATA=` 就判定「已登录」——
 *   但**过期**的 Cookie 里照样有 SUB=，于是界面显示"已登录"、真正抓取却报"登录态失效"，
 *   两套口径互相打架。这里改成用**抓取脚本自己用的那两个接口**去问一次，
 *   界面上看到的和抓取时遇到的才是同一件事。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
/* ⚠ 校验接口必须和**抓取脚本用的是同一套**，否则界面和抓取会说两套话。
 *   update.mjs 抓私信走的是 `https://api.weibo.com/webim/` —— 不是 `/chat/`。
 *   早年这里写成 `/chat/query_primary_info.json`：
 *     · 路径本身就和抓取不一致；
 *     · 更要命的是 `/chat/` 这条会被网络路径上的透明网关挡成 **502**
 *       （同一个 host 的 `/webim/` 却正常 200，B站接口也正常），
 *       于是"明明登录着"却被报成「连不上平台接口」。
 *   现在改成**多端点**：主端点用抓取同款 `webim/`，旧的 `chat/` 留作备用；
 *   只要有一个给出明确结论就采用，全都连不上/被挡才判 network（静默降级，不吓唬人）。 */
const VERIFY = {
  weibo: {
    urls: [
      'https://api.weibo.com/webim/query_primary_info.json?source=209678993',
      'https://api.weibo.com/chat/query_primary_info.json?source=209678993',
    ],
    ok: (j) => !!(j && j.profile && j.profile.id),
    account: (j) => j.profile.screen_name || String(j.profile.id),
    headers: () => ({
      Referer: 'https://api.weibo.com/chat',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
    }),
    // 只在**业务页自己**（api.weibo.com）里发；连到别的域就返回 SKIP，交给直连那条路，
    // 免得在错误页面上请求出个 404 还被当成"登录失效"。
    hostCheck: 'api.weibo.com',
  },
  bili: {
    urls: ['https://api.bilibili.com/x/web-interface/nav'],
    ok: (j) => !!(j && j.code === 0 && j.data && j.data.isLogin),
    account: (j) => j.data.uname || String(j.data.mid || ''),
    headers: () => ({ Referer: 'https://message.bilibili.com/' }),
    hostCheck: '',
  },
};

/** 页面里 fetch 的表达式（改端点时不用再手抄一遍 URL） */
function pageFetchExpr(url, hostCheck) {
  const call = `fetch(${JSON.stringify(url)},{credentials:'include',headers:{'X-Requested-With':'XMLHttpRequest','Accept':'application/json, text/plain, */*'}})` +
    `.then(r=>r.text().then(t=>r.status+'\\n'+t)).then(s=>String(s).slice(0,1500)).catch(e=>'ERR:'+e.message)`;
  return hostCheck
    ? `location.host.indexOf(${JSON.stringify(hostCheck)})>=0 ? (${call}) : 'SKIP'`
    : call;
}

/** 网关 / WAF / 风控页：返回的是 HTML 而不是平台 JSON —— 这是"被挡了"，不是"没登录" */
function isGatewayHtml(t) {
  return /^\s*<(!doctype|html|!--)/i.test(String(t || ''));
}
/** 响应体是不是平台自己的 JSON（不是的话别拿它下"失效"的结论） */
function isPlatformJson(t) {
  try { JSON.parse(String(t || '')); return true; } catch { return false; }
}

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

export function cookieFileFor(session) {
  return path.join(ROOT, session.dir, 'cookie_header.txt');
}

/** 手动粘贴 Cookie 时给用户的提示：这串里必须有哪一段 */
export const COOKIE_HINT = {
  weibo: 'SUB=',
  bili: 'SESSDATA=',
};

/**
 * 手动通道：把用户粘进来的一串 Cookie 写进本地 Cookie 文件。
 *
 * 为什么要有这条路：自动登录依赖「专用浏览器窗口 + 本机网络能连上平台接口」。
 * 万一这两样都不顺（浏览器起不来、公司网络把接口挡了），至少还能让用户
 * 自己在浏览器里登录、把 Cookie 复制出来贴进来 —— 备份照样能跑。
 *
 * ⚠ 只做形状检查 + 落盘；能不能用由调用方再校验一次（不要用「长得像」冒充「能用」）。
 */
export function saveCookie(session, cookie) {
  const c = String(cookie || '').trim().replace(/^"|"$/g, '');
  if (!c) return { ok: false, error: 'Cookie 是空的' };
  const need = REQUIRED_COOKIE[session.platform] || /./;
  if (!need.test(c)) {
    return { ok: false, error: '这串 Cookie 里没有 ' + (COOKIE_HINT[session.platform] || '登录必需的那一段') +
      ' —— 多半是复制漏了，或者复制成了别的网站/别的账号的 Cookie' };
  }
  const f = cookieFileFor(session);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, c.replace(/\s*\n\s*/g, ' ').trim() + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: '写不进 ' + path.relative(ROOT, f).replace(/\\/g, '/') + '：' + e.message };
  }
  return { ok: true, file: path.relative(ROOT, f).replace(/\\/g, '/'), length: c.length };
}

export async function isPortOpen(port = PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

/**
 * 连浏览器时的候选顺序：**业务页 → 同域任意页 → 第一个标签页**。
 * ⚠ 只按域名匹配会踩坑：登录完成后浏览器里常常同时开着 passport（登录中心）
 *   和业务页两个标签，如果连到的恰好是登录中心那张，页面状态就会一直显示
 *   "还在登录页"，而实际上早就登进去了。
 */
const TARGET_MATCH = {
  weibo: ['api.weibo.com/chat', 'weibo.com', null],
  bili: ['message.bilibili.com', 'bilibili.com', null],
};
async function attachFor(port, platform) {
  for (const m of (TARGET_MATCH[platform] || [null])) {
    try { return await CDP.attach(port, m); }
    catch { /* 换下一个候选 */ }
  }
  return null;
}

/** 从浏览器里读回该平台的 Cookie（带 domain，便于判断"是不是该域的 Cookie"） */
export async function readCookieEntries(port, platform) {
  let cdp;
  try {
    cdp = await attachFor(port, platform);
    if (!cdp) return null;
    let ck;
    // ⚠ 顺序不能反：`Network.getAllCookies` 给的是**整个浏览器**的 Cookie，
    //   而 `Storage.getCookies` 只给"当前这个页面所属的存储分区"——
    //   万一连到的标签页不是这个平台的（比如停在 about:blank），就会一个都读不到，
    //   于是"浏览器里明明登录了"却判定成没登录。
    try { ck = (await cdp.send('Network.getAllCookies', {})).cookies; }
    catch { ck = (await cdp.send('Storage.getCookies', {})).cookies; }
    const re = DOMAIN_RE[platform] || /./;
    return (ck || []).filter((c) => re.test(c.domain || ''))
      .map((c) => ({ name: c.name, domain: c.domain || '', value: String(c.value || '') }));
  } catch {
    return null;
  } finally {
    if (cdp) cdp.close();
  }
}

/** 从浏览器里读回该平台的 Cookie 串（拿不到就返回 null） */
export async function readCookies(port, platform) {
  const list = await readCookieEntries(port, platform);
  if (!list) return null;
  const jar = {};
  for (const c of list) if (!(c.name in jar)) jar[c.name] = c.value;
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

/* ------------------------------------------------------------------ 页面信号
 * 只靠 Cookie 判断"登录成功没"是不够的：cookie 有了但接口不认时，
 * 你得知道页面**现在停在哪** —— 是还在登录页、被验证码/风控拦了、
 * 还是已经进到聊天页了。下面这套就是干这个的。 */
export function classifyPage(o) {
  const u = String(o.href || '');
  const t = String(o.title || '') + ' ' + String(o.text || '');
  // 风控 / 验证码 / 安全校验：优先级最高（风控页的 URL 里也常带 passport）
  if (o.hasCaptcha) return 'challenge';
  if (/captcha|verify|security|protection|risk|验证码|安全校验|身份验证|短信验证|滑动|请完成|异常|风控/i.test(u + ' ' + t)) return 'challenge';
  // 还在登录页（只认 URL 和有登录表单 —— 正文里出现"登录"二字不算，聊天页也常出现）
  if (/passport\.|\/login|signin|\/passport/i.test(u) || o.hasLoginForm) return 'login-page';
  return 'unknown';
}

/** 读当前标签页的状态：URL / 标题 / 加载状态 / 有没有登录表单 / 有没有验证码 */
export async function pageState(port, platform) {
  let cdp = null;
  try {
    cdp = await attachFor(port, platform);
    if (!cdp) return null;
    const r = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        href: location.href,
        title: document.title,
        ready: document.readyState,
        hasLoginForm: !!document.querySelector('input[name="username"],input[name="loginname"],#loginname,.login-box,.WB_login,.login-wrap'),
        hasCaptcha: !!document.querySelector('#captcha,.captcha,[id*="captcha"],[class*="captcha"],img[src*="captcha"]'),
        text: (document.body ? String(document.body.innerText || '').slice(0, 600) : '')
      })`,
      returnByValue: true,
      awaitPromise: false,
    }, 5000);
    const v = r && r.result ? r.result.value : null;
    if (!v) return null;
    const o = JSON.parse(v);
    return Object.assign({}, o, { hint: classifyPage(o) });
  } catch {
    return null;
  } finally {
    if (cdp) cdp.close();
  }
}

const HINT_TEXT = {
  challenge: '页面像是停在验证码 / 安全校验 / 风控页',
  'login-page': '页面还在登录页（还没登录成功）',
  unknown: '页面看起来不是登录页（可能已登录，或根本没打开过这个平台）',
};

/**
 * Cookie 摘要 —— **只列名字和长度，绝不打值**。
 * 排查时够用了（"有没有 SUB"、"SUB 是不是空的"），但就算日志被别人看到也不泄凭据。
 */
export function cookieSummary(s) {
  if (!s) return '（一个都没有）';
  // 传 Cookie 条目数组时连 domain 一起列 —— 排查"主站/移动端域名不一致"靠的就是它
  if (Array.isArray(s)) {
    if (!s.length) return '（一个都没有）';
    return s.map((c) => c.name + '(' + String(c.value || '').length + '字符' +
      (c.domain ? '@' + c.domain : '') + ')').join(', ');
  }
  return s.split(';').map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.indexOf('=');
    const n = i < 0 ? x : x.slice(0, i);
    const v = i < 0 ? '' : x.slice(i + 1);
    return n + '(' + v.length + '字符)';
  }).join(', ');
}

/**
 * 在**浏览器页面里**发一次校验请求。
 *
 * 为什么需要这条路：本机装了 Clash 这类 TUN/系统代理时，Node 直接 fetch 平台接口
 * 会被网关挡成 `502 Bad Gateway`（实测：微博全挂、B站能通），
 * 但同一个浏览器里页面明明是已登录状态。拿 502 去判"登录失效"就是误诊。
 * 在页面上下文里 fetch 走的是浏览器自己的网络栈，结论和用户在窗口里看到的完全一致。
 *
 * 返回 null = 这条路不可用（浏览器没开 / 连不上 / 页面不对），交给直连那条路。
 */
export async function verifyInBrowser(port, platform) {
  const cfg = VERIFY[platform];
  if (!cfg || !cfg.urls || !cfg.urls.length) return null;
  let cdp = null;
  try {
    cdp = await attachFor(port, platform);
    if (!cdp) return null;
    const r = await cdp.send('Runtime.evaluate', {
      expression: cfg.expr || pageFetchExpr(cfg.urls[0], cfg.hostCheck),
      returnByValue: true,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true,
    }, 15000);
    const raw = r && r.result ? r.result.value : null;
    if (typeof raw !== 'string' || !raw) return null;
    if (raw === 'SKIP' || raw.startsWith('ERR:')) return null;   // 页面不对 / 请求发不出去 → 这条路不可用
    const nl = raw.indexOf('\n');
    if (nl < 0) return null;
    const status = Number(raw.slice(0, nl));
    const body = raw.slice(nl + 1);
    let j = null;
    try { j = JSON.parse(body); } catch { /* 可能是 HTML */ }
    if (j && cfg.ok(j)) return { ok: true, reason: 'ok', account: cfg.account(j) || '', via: 'browser' };
    // 5xx，或返回的是网关/WAF 的 HTML 页（403 也常见）→ 被挡了，不是没登录
    if (!Number.isFinite(status) || status >= 500 || isGatewayHtml(body)) {
      return { ok: false, reason: 'network', detail: '浏览器里请求也被挡了（HTTP ' + status + '）', via: 'browser' };
    }
    return { ok: false, reason: 'expired', detail: '浏览器里请求接口没拿到登录信息（HTTP ' + status + '）', via: 'browser' };
  } catch {
    return null;
  } finally {
    if (cdp) cdp.close();
  }
}

/**
 * 拿 Cookie 真的去问一次平台接口：有效返回 {ok:true, account}，
 * 失效返回 {ok:false, reason:'expired'}，连不上/被网关挡返回 {ok:false, reason:'network'}。
 *
 * ⚠ 三种结果必须分开，混在一起就是误诊：
 *   · expired —— 接口明确说"不认这个 Cookie"（HTTP 200 但没有登录信息、401/403、跳登录页）；
 *   · network —— 连不上、超时、或 5xx/网关错误（**502 不是登录失效**，别把人赶去重新扫码）；
 *   · no-cookie —— 压根没有 Cookie。
 */
/** 拿 Cookie 去问**一个**接口：只返回结论，不抛异常。
 *  ⚠ 分类是这门功夫的全部：5xx / 网关 HTML / 非平台 JSON 都只能算 network，
 *    只有"平台自己明确说没登录"才是 expired。 */
async function verifyOne(session, cookie, url) {
  const cfg = VERIFY[session.platform];
  try {
    const r = await fetch(url, {
      headers: Object.assign({ Cookie: cookie, 'User-Agent': UA }, cfg.headers()),
      signal: AbortSignal.timeout(10000),
      redirect: 'manual',
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch { /* 网关/登录页会返回 HTML */ }
    if (cfg.ok(j)) return { ok: true, reason: 'ok', account: cfg.account(j) || '', via: 'direct', url };

    // 5xx，或者干脆返回了一个 HTML 页面（网关 502 / WAF 拦截页 / 风控页）→ 网络问题
    if (r.status >= 500 || isGatewayHtml(t)) {
      return { ok: false, reason: 'network', detail: '接口返回 HTTP ' + r.status + '（网关/服务端问题，不是登录失效）', via: 'direct', url };
    }
    // 401/403：只有**平台自己的 JSON** 说不行才算失效；
    // 要是返回的是 WAF 的 HTML（实测 B站不带正确 Referer 时会 403 HTML），那是被挡，不是没登录。
    if (r.status === 401 || r.status === 403) {
      if (!isPlatformJson(t)) {
        return { ok: false, reason: 'network', detail: '接口返回 HTTP ' + r.status + ' 但不是平台 JSON（多半被 WAF 拦），无法判定', via: 'direct', url };
      }
      return { ok: false, reason: 'expired', detail: '接口明确拒绝（HTTP ' + r.status + '）—— 登录态失效', via: 'direct', url };
    }
    if (r.status >= 300 && r.status < 400) {
      return { ok: false, reason: 'expired', detail: '接口把请求重定向走了（多半跳登录页）—— 登录态失效', via: 'direct', url };
    }
    return { ok: false, reason: 'expired', detail: '接口返回里没有登录信息（HTTP ' + r.status + '）', via: 'direct', url };
  } catch (e) {
    return { ok: false, reason: 'network', detail: '连不上平台接口：' + e.message, via: 'direct', url };
  }
}

export async function verifyCookie(session, cookie, opts = {}) {
  const cfg = VERIFY[session.platform];
  if (!cfg) return { ok: false, reason: 'unknown-platform', detail: '这个平台没配登录校验接口' };
  if (!cookie) return { ok: false, reason: 'no-cookie', detail: '还没有 Cookie' };

  /* 1) 浏览器开着就优先用它 —— 结论和窗口里看到的完全一致 */
  if (opts.allowBrowser !== false && await isPortOpen(opts.port || PORT)) {
    const via = await verifyInBrowser(opts.port || PORT, session.platform);
    if (via && via.reason !== 'network') return via;      // 明确结论（ok / expired）直接采用
    // 浏览器那条路也被挡 → 不急着判死，继续试直连的其它端点
  }

  /* 2) Node 直连：候选端点依次试，只有一个给出**明确结论**就采用 */
  const tried = [];
  for (const url of cfg.urls) {
    const r = await verifyOne(session, cookie, url);
    tried.push(r);
    if (r.reason === 'ok' || r.reason === 'expired') return r;
  }

  /* 3) 全都没法判定 —— 这是"不知道"，不是"没登录"（调用方据此静默降级） */
  const short = (u) => String(u).replace(/^https?:\/\/[^/]+\//, '/').replace(/\?.*$/, '');
  const last = tried[tried.length - 1];
  return {
    ok: false,
    reason: 'network',
    detail: `试了 ${tried.length} 个校验接口都没拿到结论（${tried.map((x) => short(x.url)).join('、')}）：${last ? last.detail : ''}`,
    via: 'direct',
    tried: tried.map((x) => short(x.url)),
  };
}

/** 把浏览器里这个平台的登录 Cookie 全删掉 —— 「重新登录」要真的回到未登录，而不是沿用旧态 */
export async function clearSiteCookies(port, platform) {
  const re = DOMAIN_RE[platform] || /./;
  let cdp = null;
  let n = 0;
  try {
    cdp = await CDP.attach(port, null);
    let ck = [];
    try { ck = (await cdp.send('Network.getAllCookies', {})).cookies || []; }
    catch { try { ck = (await cdp.send('Storage.getCookies', {})).cookies || []; } catch { /* */ } }
    for (const c of ck) {
      if (!re.test(c.domain || '')) continue;
      try {
        await cdp.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path || '/' });
        n++;
      } catch { /* 个别删不掉不影响大局 */ }
    }
  } catch {
    return -1;                       // -1 = 连不上浏览器（浏览器没开）
  } finally {
    if (cdp) cdp.close();
  }
  return n;
}

/** 把浏览器当前页面导航到登录页（浏览器已经在跑时用，否则 launchBrowser 自带 URL） */
export async function navigateTo(port, url) {
  let cdp = null;
  try {
    cdp = await CDP.attach(port, null);
    try { await cdp.send('Page.enable'); } catch { /* */ }
    await cdp.send('Page.navigate', { url });
    return true;
  } catch {
    return false;
  } finally {
    if (cdp) cdp.close();
  }
}

/**
 * 会话的登录状态。
 *
 * 判定口径（**以在线校验为准**）：
 *   1. Cookie 从哪来：浏览器开着优先用浏览器的（更新鲜），否则用本地文件；
 *   2. 形状对不对：`SUB=` / `SESSDATA=` 在不在（这只说明"像"，不说明"能用"）；
 *   3. **能不能用**：拿它去打一次平台接口 —— 只有这一步通过，`loggedIn` 才是 true。
 */
export async function statusFor(session, opts = {}) {
  const verify = opts.verify !== false;
  const platform = session.platform;
  const need = REQUIRED_COOKIE[platform] || /./;
  const file = cookieFileFor(session);
  let saved = '';
  if (fs.existsSync(file)) saved = fs.readFileSync(file, 'utf8').trim();
  const browserUp = await isPortOpen();
  let fresh = null;
  if (browserUp) fresh = await readCookies(PORT, platform);
  const freshOk = !!(fresh && need.test(fresh));
  const savedOk = need.test(saved);

  const used = freshOk ? fresh : (savedOk ? saved : '');
  const source = !used ? 'none' : (used === fresh ? 'browser' : 'file');

  let verified = null;
  let reason = used ? '' : 'no-cookie';
  let detail = '';
  let account = '';
  let via = '';
  if (used && verify) {
    // port 传进去：浏览器开着时会在**页面里**校验，绕开本机代理把直连挡成 502 的情况
    const v = await verifyCookie(session, used, { port: PORT });
    verified = !!v.ok;
    reason = v.reason;
    detail = v.detail || '';
    account = v.account || '';
    via = v.via || '';
  }

  return {
    session: session.key,
    platform,
    browserUp,
    cookieFile: path.relative(ROOT, file).replace(/\\/g, '/'),
    hasSavedCookie: !!saved,
    savedLooksValid: savedOk,        // 仅"形状像已登录"，**不代表还能用**
    freshLooksValid: freshOk,
    verified,                        // true / false / null(没校验)
    invalidReason: reason,           // '' / no-cookie / expired / network / unknown-platform
    invalidDetail: detail,
    via,                             // 校验走的哪条路：browser（页面里）/ direct（Node 直连）
    account,                         // 校验通过时能拿到登录账号名
    // 真校验过就以校验结果为准；没校验（调用方显式关掉）才退回"形状像"
    loggedIn: verify ? verified === true : !!used,
    source,
  };
}

/** 拉起带调试端口的专用浏览器。返回 {launched:boolean, reason} */
export async function launchBrowser(session) {
  if (await isPortOpen()) return { launched: false, reason: 'already-running' };
  const exe = findBrowser();
  if (!exe) return { launched: false, reason: 'no-browser' };
  const profile = path.join(ROOT, '.edge-profile');
  fs.mkdirSync(profile, { recursive: true });
  const url = LOGIN_URL[session.platform] || LOGIN_URL.weibo;
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    // ⚠ 已知取舍（风险：中）：这个开关等于「任何来源的 CDP 连接都接受」。
    //   调试端口本身只监听 127.0.0.1，所以外网打不进来，但**本机任意网页/进程**
    //   理论上都能连上来读 Cookie、驱动这个浏览器。收紧的办法是把它换成
    //   `--remote-allow-origins=http://127.0.0.1:*` 并在 cdp_lib 的 WebSocket 握手里
    //   带上 Origin 头 —— 但那要改 CDP 客户端，且一改错登录就整条链路失效，
    //   所以这里保留现状并显式说明，等有真实浏览器可做回归时再收紧。
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];
  const p = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  // ⚠ 启动失败（路径存在但起不来 / 被策略拦下）会在这里抛 'error'；不接住的话
  //   它就是一个未处理的事件，整个进程直接崩掉，连一句人话都没有。
  p.on('error', (e) => { console.error('  [!] 浏览器启动失败：' + e.message); });
  p.unref();
  return { launched: true, exe, url, reason: 'launched' };
}

/* ------------------------------------------------------------------ CLI */
async function main() {
  const ARGS = process.argv.slice(2);
  const val = (f, d = null) => { const i = ARGS.indexOf(f); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d; };
  const key = val('--session', 'weibo');
  const timeout = Number(val('--timeout', '300')) || 300;
  const statusOnly = ARGS.includes('--status');
  // --force = 「重新登录」：不管现在看起来是不是已登录，都把旧登录态清掉重来。
  // 没有它的话，只要本地 cookie 文件还在（哪怕是过期的），都会走到下面的短路分支直接 return 0，
  // 浏览器窗口根本不会弹出来 —— 用户点了「重新登录」却什么都没发生。
  const force = ARGS.includes('--force');

  const say = (m) => console.log(m);

  let session;
  try { session = findSession(key); }
  catch (e) { console.error('[×] ' + e.message); return 4; }

  if (statusOnly) {
    const st = await statusFor(session);
    say(JSON.stringify(st));
    // 0=已登录 · 3=未登录或已失效 · 4=连不上平台接口，没法判定（别把断网当成未登录）
    if (st.loggedIn) return 0;
    return st.invalidReason === 'network' ? 4 : 3;
  }

  const platform = session.platform;
  const need = REQUIRED_COOKIE[platform] || /./;
  const file = cookieFileFor(session);
  const relFile = path.relative(ROOT, file).replace(/\\/g, '/');

  say('==========================================');
  say('  授权登录 · ' + session.label + '（' + platform + '）' + (force ? ' · 强制重新登录' : ''));
  say('==========================================');
  say('');

  /* ---------- 强制重新登录：先把旧登录态清干净，再走完整流程 ---------- */
  let oldCookie = '';
  if (force) {
    say('[0/2] 强制重新登录：清除旧登录态');
    if (fs.existsSync(file)) {
      oldCookie = fs.readFileSync(file, 'utf8').trim();
      try {
        fs.rmSync(file, { force: true });
        say('      已删除本地 Cookie 文件：' + relFile);
      } catch (e) {
        say('      [!] 本地 Cookie 文件删不掉：' + e.message);
        say('          （可以手动删掉后再点一次「重新登录」）');
      }
    } else {
      say('      本地没有 Cookie 文件，不用删。');
    }
    if (await isPortOpen()) {
      const n = await clearSiteCookies(PORT, platform);
      say(n >= 0 ? '      已清除浏览器里的 ' + n + ' 个 ' + platform + ' 登录 Cookie（需要重新登录一次）'
                 : '      [!] 浏览器窗口没开，没能清掉浏览器里的 Cookie');
      const ok = await navigateTo(PORT, LOGIN_URL[platform] || LOGIN_URL.weibo);
      if (ok) say('      已把浏览器窗口切到登录页。');
    }
    say('');
  }

  if (!force) {
    const st = await statusFor(session);
    if (st.loggedIn) {
      say('[✓] 已经是登录状态了（' + (st.source === 'browser' ? '浏览器' : '本地 Cookie 文件') +
          (st.account ? '，账号：' + st.account : '') + '）');
      say('      （这个结论是**真去打了一次平台接口**确认的，不是只看文件里有没有 Cookie）');
      if (st.source === 'browser') {
        const fresh = await readCookies(PORT, platform);
        if (fresh && need.test(fresh)) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, fresh, 'utf8');
          say('[✓] 已把最新 Cookie 同步到 ' + relFile + '（' + fresh.length + ' 字符）');
        }
      }
      say('[完成] 可以直接抓取了。');
      say('      如果实际抓取还是报「未登录」，点「重新登录」强制清掉重来。');
      return 0;
    }
    if (st.invalidReason === 'expired') {
      say('[!] 本地 Cookie 文件还在（' + relFile + '），但平台接口已经不认它了 —— 多半是过期。');
      say('    下面会打开登录窗口，登录成功后旧文件会被新的覆盖。');
    } else if (st.invalidReason === 'network') {
      say('[!] 连不上平台接口（' + st.invalidDetail + '）');
      say('    没法确认现有 Cookie 是否还有效，下面照常走登录流程；登录成功即好。');
    }
    say('');
  }

  const lr = await launchBrowser(session);
  if (lr.reason === 'no-browser') {
    say('[×] 这台机器上没找到 Edge / Chrome，无法完成登录。');
    if (force && oldCookie) {
      say('    ⚠ 注意：旧的 Cookie 文件已经删掉了，现在是「未登录」状态 ——');
      say('      装上 Edge/Chrome 后再重新登录一次即可恢复。');
    }
    return 1;
  }
  if (lr.launched) {
    say('[1/2] 已打开专用浏览器窗口 → ' + lr.url);
    say('      请在这个窗口里登录（扫码或账号密码都行）。');
    say('      ⚠ 这个窗口用的是项目自己的 profile（.edge-profile/），');
    say('        登录状态只留在本机，不会传给任何第三方。');
  } else {
    say('[1/2] 专用浏览器已在运行，直接用它登录即可。');
  }
  say('');
  say('[2/2] 正在等待登录完成…（最多等 ' + timeout + ' 秒，登录成功后会自动继续）');

  const t0 = Date.now();
  let lastTip = 0;
  let sameAsOld = 0;
  let lastCookie = '';
  let lastCookieList = null;
  let lastVerify = null;
  let lastPs = null;
  let readyWaits = 0;                 // 页面还没加载完时先别急着下结论

  while ((Date.now() - t0) / 1000 < timeout) {
    await sleep(2000);
    const el = Math.floor((Date.now() - t0) / 1000);
    const fresh = await readCookies(PORT, platform);
    const cookieOk = !!(fresh && need.test(fresh));

    /* --- 还没有登录 Cookie：等，并把"页面现在停在哪"打出来 --- */
    if (!cookieOk) {
      if (el - lastTip >= 20) {
        lastTip = el;
        const ps = await pageState(PORT, platform);
        say('      …等待中（' + el + 's）' + (ps ? '：当前页面 ' + ps.href : '：（读不到页面）'));
        if (ps) say('        ' + (HINT_TEXT[ps.hint] || ps.hint));
      }
      continue;
    }

    /* --- 强制重登：读到的还是旧串 = 浏览器里没真的退出登录 --- */
    if (force && oldCookie && fresh === oldCookie && sameAsOld < 3) {
      sameAsOld++;
      say('      [!] 浏览器里还是**之前那个登录态**（第 ' + sameAsOld + ' 次）');
      say('          请在浏览器窗口里退出登录后重新登录，或者关掉窗口后再点一次「重新登录」。');
      continue;
    }

    /* --- Cookie 有了：先确认页面加载完了再下结论 ---
       登录跳转的瞬间 cookie 往往已经写入，但页面还在 loading，
       这时去校验容易拿到"接口还没放行"的假象 —— 先等 readyState 变成 complete。 */
    lastCookie = fresh;
    lastCookieList = await readCookieEntries(PORT, platform);
    const psNow = await pageState(PORT, platform);
    if (psNow && psNow.ready && psNow.ready !== 'complete' && readyWaits < 5) {
      readyWaits++;
      say('      …页面还在加载（' + psNow.ready + '），稍等再判定（第 ' + readyWaits + ' 次）');
      continue;
    }
    lastPs = psNow || lastPs;

    /* --- 真校验一次（界面结论和实际抓取必须是同一件事） ---
       传 port：浏览器开着就在**页面里**问，避免直连被网关挡成 502 后误判成"没登录" */
    const v = await verifyCookie(session, fresh, { port: PORT });
    lastVerify = v;

    if (v.ok) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fresh, 'utf8');
      say('');
      say('[✓] 登录成功 —— 平台接口确认有效' + (v.account ? '（账号：' + v.account + '）' : ''));
      say('[✓] 已保存 Cookie（' + fresh.length + ' 字符）→ ' + relFile);
      say('[完成] 关掉浏览器窗口也可以，Cookie 已经在本机了。');
      return 0;
    }

    /* --- Cookie 有了但接口不认：分情况 --- */
    if (lastPs && lastPs.hint === 'challenge') {
      if (el - lastTip >= 15) {
        lastTip = el;
        say('      [!] 页面像是被验证码 / 安全校验 / 风控拦住了（' + (lastPs.href || '') + '）');
        say('          Cookie 已经有了，但平台还不放行 —— 请在浏览器窗口里把验证做完，程序会继续等。');
      }
      continue;
    }
    if (v.reason === 'network') {
      // 连不上接口 ≠ 没登录：Cookie 照存，别把人卡在这儿
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fresh, 'utf8');
      say('');
      say('[✓] Cookie 已保存（' + fresh.length + ' 字符）→ ' + relFile);
      say('[!] 但这会儿连不上平台接口（' + v.detail + '），没法当场确认；稍后会自动再确认一次。');
      return 0;
    }
    /* 兜底：Cookie 有了、页面也已经进到业务页（聊天页/私信页）、页面上没有登录表单 ——
       那基本就是登录成功了，只是接口这一次没确认（刚同步、风控短暂拦截都会这样）。
       这时候如果还死等，用户看到的就是"明明登录了却说没登录"。先按成功处理并说清楚。 */
    const bizRe = platform === 'bili' ? /message\.bilibili\.com/ : /api\.weibo\.com\/chat/;
    // ⚠ 别只认 URL：#/chat 这类 hash 路由下 CDP 给的 target.url 可能不带 hash，
    //   更稳的判据是"页面上没有登录表单、也不像登录页/风控页"。
    const onBiz = bizRe.test(lastPs.href || '');
    if (lastPs && !lastPs.hasLoginForm &&
        lastPs.hint !== 'login-page' && lastPs.hint !== 'challenge' && el >= 6) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fresh, 'utf8');
      say('');
      say('[✓] 已登录（' + (onBiz ? '页面已经进到' + (platform === 'bili' ? '私信页' : '聊天页') : '页面上看不到登录表单') +
          '：' + lastPs.href + '）');
      say('[!] 但这一轮接口校验没通过（' + v.detail + '）—— 常见于刚登录还没同步、或被短暂风控。');
      say('    Cookie 已保存（' + fresh.length + ' 字符）→ ' + relFile + '，稍后会自动再确认一次。');
      say('    如果点「备份」仍被拦，就再点一次「刷新登录状态」。');
      return 0;
    }

    if (el - lastTip >= 20) {
      lastTip = el;
      say('      …已拿到 Cookie，但接口还没放行（' + el + 's）');
      say('        Cookie：' + cookieSummary(lastCookieList || fresh));
      if (lastPs) say('        当前页面：' + lastPs.href + '（' + (HINT_TEXT[lastPs.hint] || lastPs.hint) + '）');
      say('        可能：刚登录还没同步 / 需要短信或安全验证。');
    }
  }

  /* ---------------- 超时：把现场信息一次性打全 ---------------- */
  say('');
  say('[×] 等待超时（' + timeout + ' 秒）。下面是自查用的现场信息 ——');
  say('    （Cookie 只列名字和长度，不打内容，日志给别人看也没关系）');
  const ps = lastPs || await pageState(PORT, platform);
  say('    当前页面    ：' + (ps ? ps.href : '（读不到 —— 浏览器窗口没开？）'));
  say('    页面标题    ：' + (ps ? ps.title : '—'));
  say('    加载状态    ：' + (ps ? ps.ready : '—'));
  say('    页面判断    ：' + (ps ? (HINT_TEXT[ps.hint] || ps.hint) : '—') +
      (ps && ps.hasLoginForm ? '（页面上还有登录表单）' : '') +
      (ps && ps.hasCaptcha ? '（页面上有验证码）' : ''));
  say('    Cookie      ：' + cookieSummary(lastCookieList || lastCookie ||
      await readCookieEntries(PORT, platform)));
  say('    必需 Cookie ：' + ((lastCookie && need.test(lastCookie)) ? '有' : '没有 —— 浏览器里没写入登录 Cookie'));
  say('    接口校验    ：' + (lastVerify ? (lastVerify.detail || lastVerify.reason) : '（还没到这一步）'));
  say('');
  say('    怎么接着查：');
  if (ps && ps.hint === 'challenge') {
    say('      ① 页面停在了验证码 / 安全校验 —— 在浏览器窗口里把它做完，程序本来还会继续等；');
  } else if (ps && ps.hint === 'login-page') {
    say('      ① 页面还在登录页 —— 确认登录的是**这个专用窗口**（不是你平时用的浏览器）；');
  } else if (!(lastCookie && need.test(lastCookie))) {
    say('      ① 浏览器里根本没有登录 Cookie —— 多半是在别的浏览器/无痕窗口里登录的；');
    say('         本程序只认它自己拉起来的那个专用窗口（用的是 .edge-profile/ 这个 profile）。');
  } else {
    say('      ① Cookie 有了但接口不认 —— 可能刚登录还没同步，或账号需要短信/安全验证；');
  }
  say('      ② 确认无误后重新点一次「授权登录」（已登录过就点「重新登录」）。');
  return 3;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(await main());
