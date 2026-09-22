#!/usr/bin/env node
/**
 * B站私信备份 · 更新脚本
 * ---------------------------------------------------------------
 * 架构与微博版完全一致：专用浏览器实例（CDP 9333）**只用来取一次登录 Cookie**；
 * 之后所有接口请求与图片下载都由 Node 直接发起（快、稳、可重试）。
 *
 * 接口（均已核对 bilibili-API-collect 文档）：
 *   · 登录态   api.bilibili.com/x/web-interface/nav
 *   · 用户名片 api.vc.bilibili.com/account/v1/user/cards?uids=<mid>
 *   · 历史私信 api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs
 *       size 上限 2000；end_seqno = 往更早翻页，begin_seqno = 往更新翻页；
 *       返回 data.messages / has_more / min_seqno / max_seqno / e_infos(表情表)
 *
 * 用法：
 *   node bili_update.mjs             # 增量更新（默认）
 *   node bili_update.mjs --full      # 全量重拉
 *   node bili_update.mjs --no-img    # 只更新文字
 *   node bili_update.mjs --rebuild   # 忽略本地记录，按当前 normalize 规则全量重抓
 *   node bili_update.mjs --probe     # 只抓一页，输出「消息类型审计报告」（首次排错用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { CDP, sleep } from './cdp_lib.mjs';
import { pickCard, cardNameFace } from './bili_cards.mjs';
import { findSession, sessionFromArgs, peerUidOrExit } from './sessions.mjs';
import { dayStart, dayEnd } from './msg_kind.mjs';

// ---------------- 配置 ----------------
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.BILI_CDP_PORT || 9333);

const VC = 'https://api.vc.bilibili.com';
const WWW = 'https://api.bilibili.com';
const PAGE_SIZE = 500;                   // 接口上限 2000；500 更稳、便于断点
const MAX_PAGES = 2000;
const DL_CONCURRENCY = 8;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';

const ARGS = process.argv.slice(2);
/* 取形如 --x v 的值；后面跟着另一个 -- 就当没给 */
const argVal = (f) => {
  const i = ARGS.indexOf(f);
  const v = i >= 0 ? ARGS[i + 1] : null;
  return (v && !v.startsWith('--')) ? v : null;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
for (const k of ['--since', '--until']) {
  const v = argVal(k);
  if (v && !DATE_RE.test(v)) { console.error('[x] ' + k + ' 要写成 YYYY-MM-DD，收到的是「' + v + '」'); process.exit(2); }
}
/* 消息范围：换日按「当天 05:00 → 次日 05:00」，与查看页 / 索引库同一套口径 */
const SINCE_TS = argVal('--since') ? dayStart(argVal('--since')) : null;
const UNTIL_TS = argVal('--until') ? dayEnd(argVal('--until')) : null;
const FULL = ARGS.includes('--full');
const NO_IMG = ARGS.includes('--no-img');
const REBUILD = ARGS.includes('--rebuild');
const PROBE = ARGS.includes('--probe');
const AVATAR = { peer: '', me: '' };

// ---- 会话（多会话支持）：--session <key> 决定数据目录与导出的全局名 ----
// 清单在项目根 sessions.json，归一化逻辑在 scripts/sessions.mjs。
// 不传 --session 就是原来的行为（bili → bili/ → window.DM_DATA_B）。
const SESSION = findSession(sessionFromArgs(ARGS, 'bili'));
const BDIR = path.join(ROOT, SESSION.dir);
const IMG_DIR = path.join(BDIR, 'images');
const RAW_DIR = path.join(BDIR, 'raw');
const GLOBALS = SESSION.globals;

// ---- 聊天对象：从 sessions.json 读，脚本里不写死任何 mid 或昵称 ----
// 自己的 mid 由 nav 接口自动探测（见下），所以这里只需要「对方是谁」。
const PEER_MID = peerUidOrExit(SESSION);
const PEER_NAME_FALLBACK = SESSION.peer.name || '';

// ---------------- 工具 ----------------
fs.mkdirSync(IMG_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const log = (...a) => console.log(...a);
const H = (s) => { let h = 5381; s = String(s); for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
// B站图片地址可能带 http:// 或 // 前缀，统一成 https
const up = (u) => {
  u = String(u || '').trim();
  if (!u) return '';
  if (u.startsWith('//')) return 'https:' + u;
  return u.replace(/^http:\/\//, 'https://');
};

let COOKIE = '';
const HDR = () => ({
  Cookie: COOKIE,
  Referer: 'https://message.bilibili.com/',
  Origin: 'https://message.bilibili.com',
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
});

/**
 * B站把 64 位整数直接写在 JSON 里（如 msg_key 有 19 位），
 * JSON.parse 用双精度浮点会丢精度 → 先把关键大整数包成字符串再解析。
 * 只匹配「未转义」的键名，所以正文里出现的同名字符串不受影响。
 */
const BIGKEYS = 'msg_key|msg_seqno|biz_id2|biz_id1|gpt_session_id';
function parseBig(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  const patched = raw.replace(
    new RegExp('"(' + BIGKEYS + ')"(\\s*:\\s*)(\\d{15,})', 'g'),
    '"$1"$2"$3"');
  try { return JSON.parse(patched); } catch { /* 兜底走原样 */ }
  try { return JSON.parse(raw); } catch { return null; }
}

async function apiGet(url, { retries = 3, asJson = true } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: HDR(), signal: AbortSignal.timeout(40000) });
      const t = await r.text();
      if (r.status === 200) return asJson ? parseBig(t) : t;
      if (i === retries) return { code: -1, message: 'HTTP ' + r.status + ' ' + t.slice(0, 120) };
    } catch (e) {
      if (i === retries) return { code: -1, message: e.message };
    }
    await sleep(700 * (i + 1));
  }
}

async function pool(items, worker, n = DL_CONCURRENCY) {
  const queue = [...items];
  let done = 0;
  const runners = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await worker(item); } catch { /* ignore */ }
      if (++done % 100 === 0) log(`  ...已处理 ${done}/${items.length}`);
    }
  });
  await Promise.all(runners);
}

// ---------------- 1) 取 Cookie ----------------
log('[1/6] 获取登录凭据…');
let cdp = null;
const savedCookieFile = path.join(BDIR, 'cookie_header.txt');
if (exists(savedCookieFile)) COOKIE = fs.readFileSync(savedCookieFile, 'utf8').trim();

try {
  cdp = await CDP.attach(PORT, 'message.bilibili.com');
  try {
    await cdp.send('Page.enable');
    cdp.on('Page.javascriptDialogOpening', async () => {
      try { await cdp.send('Page.handleJavaScriptDialog', { accept: true }); } catch {}
    });
  } catch {}
  let ck;
  try { ck = (await cdp.send('Storage.getCookies', {})).cookies; }
  catch { ck = (await cdp.send('Network.getAllCookies', {})).cookies; }
  const jar = {};
  for (const c of ck) if (/bilibili/.test(c.domain)) if (!(c.name in jar)) jar[c.name] = c.value;
  const fresh = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  if (/SESSDATA=/.test(fresh)) {
    COOKIE = fresh;
    fs.writeFileSync(savedCookieFile, COOKIE, 'utf8');
    log('      已从浏览器刷新 Cookie（' + COOKIE.length + ' 字符）');
  } else if (COOKIE) {
    log('      浏览器未登录 B站，沿用本地 Cookie');
  }
} catch {
  log('      未连接浏览器，沿用本地 Cookie');
}
if (!COOKIE) {
  console.error('[×] 没有任何可用的 B站 Cookie。');
  console.error('    请运行「命令/备份与更新/更新B站备份.cmd」，在弹出的浏览器窗口里扫码登录 B站，然后重试。');
  process.exit(2);
}

// ---------------- 2) 校验登录态 ----------------
let selfMid = '', selfName = '', selfAvatar = '', peerName = PEER_NAME_FALLBACK, peerAvatar = '';
const nav = await apiGet(`${WWW}/x/web-interface/nav`);
if (!nav || nav.code !== 0 || !nav.data || !nav.data.isLogin) {
  console.error('\n[×] B站登录态已失效' + (nav && nav.message ? '（' + nav.message + '）' : '') + '。');
  console.error('    请打开专用浏览器窗口登录 B站（扫码），然后重新运行。');
  process.exit(3);
}
selfMid = String(nav.data.mid);
selfName = nav.data.uname || '我';
selfAvatar = nav.data.face || '';
log(`      登录账号：${selfName} (${selfMid})`);

try {
  const cards = await apiGet(`${VC}/account/v1/user/cards?uids=${PEER_MID}`);
  // 注意：该接口的 data 是「数组」([{mid,name,face,...}])，不是以 mid 为键的对象。
  // 旧代码写的是 cards.data[PEER_MID]，取到 undefined，导致对方昵称永远走兜底、头像永远为空。
  // 解析逻辑抽到 bili_cards.mjs，并有单测（scripts/_explore/verify_cards.mjs）。
  const card = pickCard(cards && cards.data, PEER_MID);
  if (card) {
    const nf = cardNameFace(card, peerName);
    peerName = nf.name;
    peerAvatar = nf.avatar;
  }
  log(`      聊天对象：${peerName} (${PEER_MID})` + (peerAvatar ? '，已取到头像' : '（未取到头像，用兜底）'));
} catch { /* ignore */ }
// 配置里 peer.name 留空、接口又没返回昵称时，退化成「对方」而不是空串
// （分享出去时使用者只填 mid 也能用）
if (!peerName) { peerName = '对方'; log(`      聊天对象：${PEER_MID}（接口没返回昵称，界面会显示「对方」）`); }

// ---------------- 3) 载入已有数据 ----------------
const MSG_JSON = path.join(BDIR, 'messages.json');
const META_JSON = path.join(BDIR, 'meta.json');
let messages = [];
let meta = {};
if (exists(MSG_JSON)) {
  try { messages = J(MSG_JSON); } catch { messages = []; }
  if (exists(META_JSON)) { try { meta = J(META_JSON); } catch {} }
  log('      已有 ' + messages.length + ' 条本地记录');
}
if (REBUILD) {
  try { fs.copyFileSync(MSG_JSON, path.join(RAW_DIR, 'messages.bak.json')); } catch {}
  log('      [重建] 忽略本地记录，按当前规则全量重抓（原数据已备份到 bili/raw/messages.bak.json）');
  messages = [];
}
const seen = new Set(messages.map(m => String(m.id)));

// ---------------- 4) 规范化 ----------------

// 分享消息（msg_type=7）的 source → 类型名
const SHARE_SRC = {
  1: '小视频', 2: '相簿', 3: '纯文字', 4: '直播', 5: '视频', 6: '专栏',
  7: '番剧', 8: '音乐', 9: '动画', 10: '图片', 11: '动态', 16: '番剧', 17: '番剧',
};
// msg_type → 展示用类型标签
const TYPE_OF = {
  1: 'text', 2: 'image', 5: 'recall', 6: 'emoji', 7: 'card', 9: 'card',
  10: 'card', 11: 'video', 12: 'card', 13: 'card', 14: 'card', 16: 'card',
  18: 'notice', 19: 'ai',
};

function shareUrl(c) {
  const s = Number(c.source), id = c.id;
  if (c.url) return c.url;
  if (s === 5) return 'https://www.bilibili.com/video/' + (c.bvid || ('av' + id));
  if (s === 6) return 'https://www.bilibili.com/read/cv' + id;
  if (s === 11) return 'https://t.bilibili.com/' + id;
  if (s === 2) return 'https://www.bilibili.com/album/' + id;
  if (s === 8) return 'https://www.bilibili.com/audio/au' + id;
  if (s === 16) return 'https://www.bilibili.com/bangumi/play/ep' + id;
  if (s === 7 || s === 17) return 'https://www.bilibili.com/bangumi/play/ss' + id;
  if (s === 9 || s === 1) return 'https://www.bilibili.com/video/av' + id;
  if (s === 10) return 'https://www.bilibili.com/read/cv' + id;
  return '';
}

/** 把一条原始私信转成查看页统一使用的结构 */
function normalize(m, emojiMap) {
  const senderUid = String(m.sender_uid);
  const from = senderUid === selfMid ? 'me' : (senderUid === PEER_MID ? 'peer' : 'sys');
  const mt = Number(m.msg_type);
  const c = parseBig(m.content) || {};
  const images = [], links = [];
  const pushImg = (o) => { if (o.url && !images.some(x => x.url === o.url)) images.push(o); };
  let card = null, text = '', recallKey = '';

  /* ---- 逐类型解析 ---- */
  if (mt === 1 || mt === 3) {
    // 1=文字；3 是历史遗留的「加密通话」文字，同样按文字处理
    text = typeof c.content === 'string' ? c.content : (c.content == null ? '' : String(c.content));
  } else if (mt === 2) {
    const url = up(c.url || c.uri);
    if (url) pushImg({ kind: 'photo', url, file: 'img_' + H(url), w: c.width, h: c.height });
    text = '分享图片';
  } else if (mt === 6) {
    const url = up(c.url || c.uri);
    if (url) pushImg({ kind: 'emoji', url, file: 'face_' + H(url), w: c.width, h: c.height });
    text = '自定义表情';
  } else if (mt === 5) {
    // 撤回通知：content 是被撤回那条消息的 msg_key
    recallKey = String(c.content == null ? '' : c.content).trim();
    text = from === 'me' ? '你撤回了一条消息' : '对方撤回了一条消息';
  } else if (mt === 7) {
    const srcName = SHARE_SRC[Number(c.source)] || '内容';
    const cover = up(c.thumb || c.cover || '');
    if (cover) pushImg({ kind: 'card', url: cover, file: 'card_' + H(cover) });
    card = {
      kind: 'bili', sub: '分享' + srcName, author: c.author || '',
      title: c.title || '', text: c.headline || '', url: shareUrl(c) || '',
      bvid: c.bvid || '', created: '',
    };
  } else if (mt === 9) {
    const cover = up(c.cover || c.avatar || '');
    if (cover) pushImg({ kind: 'card', url: cover, file: 'card_' + H(cover) });
    card = { kind: 'bili', sub: '小程序', author: c.name || '', title: c.title || '', text: '', url: c.jump_uri || c.url || '' };
  } else if (mt === 10) {
    // 通知消息（系统 / 官方推送）
    const bc = c.biz_content || {};
    const cover = up(bc.cover || bc.backup_cover || '');
    if (cover) pushImg({ kind: 'card', url: cover, file: 'card_' + H(cover) });
    const mods = (Array.isArray(c.modules) ? c.modules : []).map(x => `${x.title || ''}：${x.detail || ''}`).filter(s => s !== '：');
    const cfg = c.jump_uri_config || {};
    card = {
      kind: 'bili', sub: '通知',
      author: (c.notifier && c.notifier.nickname) || '',
      title: c.title || '', text: [c.text || '', ...mods].filter(Boolean).join('\n'),
      url: cfg.web_uri || cfg.all_uri || c.jump_uri || '',
    };
  } else if (mt === 11) {
    // 视频推送
    const cover = up(c.cover || '');
    if (cover) pushImg({ kind: 'card', url: cover, file: 'card_' + H(cover) });
    card = {
      kind: 'bili', sub: '视频', author: '',
      title: c.title || '', text: c.desc || '',
      url: c.bvid ? ('https://www.bilibili.com/video/' + c.bvid) : ('https://www.bilibili.com/video/av' + (c.rid || '')),
      bvid: c.bvid || '', created: c.pub_date ? new Date(c.pub_date * 1000).toISOString() : '',
      extra: [c.view != null ? '播放 ' + c.view : '', c.times ? '时长 ' + Math.round(c.times / 60) + ' 分' : ''].filter(Boolean).join(' · '),
    };
    if (c.attach_msg && c.attach_msg.content) text = 'UP主赠言：' + c.attach_msg.content;
  } else if (mt === 12) {
    // 专栏推送
    const cover = up((Array.isArray(c.image_urls) ? c.image_urls[0] : '') || '');
    if (cover) pushImg({ kind: 'card', url: cover, file: 'card_' + H(cover) });
    card = {
      kind: 'bili', sub: '专栏', author: c.author || '',
      title: c.title || '', text: c.summary || '',
      url: 'https://www.bilibili.com/read/cv' + (c.rid || ''),
      created: c.pub_date ? new Date(c.pub_date * 1000).toISOString() : '',
    };
    if (c.attach_msg && c.attach_msg.content) text = 'UP主赠言：' + c.attach_msg.content;
  } else if (mt === 13) {
    // 图片卡片（点击跳转）
    const pic = up(c.pic_url || '');
    if (pic) pushImg({ kind: 'card', url: pic, file: 'card_' + H(pic) });
    card = { kind: 'bili', sub: '卡片', author: '', title: c.title || '', text: '', url: c.jump_url || '' };
  } else if (mt === 14) {
    // 分享其他内容（常见于分享直播）
    const cover = up(c.cover || '');
    if (cover) pushImg({ kind: 'card', url: cover, file: 'card_' + H(cover) });
    card = {
      kind: 'bili', sub: '分享' + (c.source || '内容'), author: c.author || '',
      title: c.title || '', text: c.desc || '', url: c.url || '',
    };
  } else if (mt === 16) {
    // 被关注时的自动推送
    const subs = (Array.isArray(c.sub_cards) ? c.sub_cards : []);
    for (const s of subs.slice(0, 9)) {
      const cv = up(s.cover_url || '');
      if (cv) pushImg({ kind: 'card', url: cv, file: 'card_' + H(cv) });
    }
    card = {
      kind: 'bili', sub: '关注推送', author: '',
      title: c.main_title || '更多宝藏内容',
      text: c.reply_content || '',
      url: (subs[0] && subs[0].jump_url) || '',
    };
  } else if (mt === 18) {
    // 系统提示：content 是「序列化后的 JSON 数组」的字符串
    let arr = null;
    try { arr = JSON.parse(String(c.content || '')); } catch { arr = null; }
    if (Array.isArray(arr)) {
      text = arr.map(x => x && x.text).filter(Boolean).join('\n');
      arr.forEach(x => { if (x && x.jump_url) links.push({ short: '', long: x.jump_url, title: '' }); });
    } else {
      text = String(c.content || '');
    }
    card = null;
  } else if (mt === 19) {
    const paras = c.content && c.content.paragraphs;
    if (Array.isArray(paras)) {
      text = paras.map(p => typeof p === 'string' ? p : (p && (p.text || p.content)) || '').filter(Boolean).join('\n');
    }
    if (c.voice_url) links.push({ short: '', long: up(c.voice_url), title: '语音' });
  } else {
    // 未知类型：把能读到的文本尽量读出来，别丢内容
    text = String(c.content || c.title || c.text || '').trim();
  }

  // 正文里出现的表情记号 → 记到表情表（e_infos 是接口随消息返回的）
  if (emojiMap && text) {
    for (const m2 of text.matchAll(/\[([^\[\]\s]{1,20})\]/g)) {
      const tk = '[' + m2[1] + ']';
      if (!emojiMap[tk]) emojiMap[tk] = { pending: 1 };
    }
  }

  const ts = Number(m.timestamp) * 1000;
  return {
    id: String(m.msg_key),
    seqno: String(m.msg_seqno),
    ts: Number.isFinite(ts) ? ts : null,
    time: Number.isFinite(ts) ? new Date(ts).toISOString() : '',
    from,
    sender: from === 'me' ? selfName : (from === 'peer' ? peerName : '系统'),
    type: TYPE_OF[mt] || 'other',
    media_type: mt,
    msg_source: Number(m.msg_source || 0),
    recalled: Number(m.msg_status) === 1,
    recall_key: recallKey || '',
    text,
    images, links, card,
  };
}

// ---------------- 5) 翻页拉取 ----------------
log('[2/6] 拉取私信记录（' + (REBUILD ? '重建' : FULL ? '全量' : '增量') + '）…');
const emojiMap = exists(path.join(BDIR, 'emoji_map.json')) ? J(path.join(BDIR, 'emoji_map.json')) : {};
const audit = {};                        // (msg_type,msg_source) → 样本，用于首次排错
let end = '', page = 0, added = 0, reachEnd = false;
const startedAt = Date.now();

while (page < MAX_PAGES) {
  const q = new URLSearchParams({
    talker_id: PEER_MID, session_type: '1', size: String(PAGE_SIZE),
    sender_device_id: '1', build: '0', mobi_app: 'web',
  });
  if (end) q.set('end_seqno', end);
  const j = await apiGet(`${VC}/svr_sync/v1/svr_sync/fetch_session_msgs?${q}`);
  if (!j || j.code !== 0) {
    log('      拉取失败：' + ((j && (j.message || j.msg)) || '未知错误') + '，停止');
    break;
  }
  const d = j.data || {};
  if (Array.isArray(d.e_infos)) {
    for (const e of d.e_infos) {
      if (e && e.text) emojiMap[e.text] = { url: up(e.url || e.uri || ''), gif: up(e.gif_url || ''), size: e.size || 1 };
    }
  }
  const list = d.messages || [];
  if (!list.length) { reachEnd = true; break; }

  let fresh = 0;
  for (const m of list) {
    const key = m.msg_type + '/' + (m.msg_source || 0);
    if (!audit[key]) audit[key] = { msg_type: m.msg_type, msg_source: m.msg_source, n: 0, sample: null, keys: null };
    audit[key].n++;
    if (!audit[key].sample) {
      audit[key].sample = String(m.content || '').slice(0, 600);
      const pc = parseBig(m.content);
      audit[key].keys = pc && typeof pc === 'object' ? Object.keys(pc) : null;
    }
    const n = normalize(m, emojiMap);
    if (UNTIL_TS != null && (n.ts == null || n.ts > UNTIL_TS)) continue;   // --until：比这更晚的不要
    if (!seen.has(n.id)) { seen.add(n.id); messages.push(n); fresh++; }
  }
  added += fresh; page++;
  // --since：翻到比这个日期更早的一页就收工（这一页仍然纳入）
  if (SINCE_TS != null) {
    const oldest = list[list.length - 1];
    const ots = oldest && oldest.timestamp ? Number(oldest.timestamp) * 1000 : null;
    if (ots != null && ots < SINCE_TS) { log('      已到达 --since 指定的起始日期，停止翻页'); break; }
  }
  if (page % 5 === 0 || fresh === 0) {
    log(`      第 ${page} 页（累计 ${messages.length} 条）→ 最早 ${new Date(Number(list[list.length - 1].timestamp) * 1000).toLocaleString('zh-CN')}`);
  }
  if (PROBE) break;
  if (page % 20 === 0) {                  // 断点落盘
    messages.sort(cmpMsg);
    fs.writeFileSync(MSGS_PARTIAL(), JSON.stringify(messages), 'utf8');
    log(`      [断点] 已落盘 ${messages.length} 条`);
  }
  if (Number(d.has_more) !== 1) { reachEnd = true; break; }
  const next = String(d.min_seqno || '');
  if (!next) { reachEnd = true; break; }
  if (end && !(BigInt(next) < BigInt(end))) { log('      序号未前进，停止翻页'); reachEnd = true; break; }
  end = next;
  await sleep(250);
}
log(`      共翻 ${page} 页，新增 ${added} 条，累计 ${messages.length} 条（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);

function cmpMsg(a, b) { return (a.ts || 0) - (b.ts || 0) || String(a.seqno || a.id).localeCompare(String(b.seqno || b.id)); }
function MSGS_PARTIAL() { return path.join(RAW_DIR, 'partial.json'); }

// 把 type=5 的撤回通知落到被撤回的那条消息上（原文仍保留，只在展示时标注）
const byKey = new Map(messages.map(m => [m.id, m]));
for (const m of messages) {
  if (m.recall_key && byKey.has(m.recall_key)) byKey.get(m.recall_key).recalled = true;
}

fs.writeFileSync(path.join(BDIR, 'emoji_map.json'), JSON.stringify(emojiMap, null, 1), 'utf8');
fs.writeFileSync(path.join(RAW_DIR, 'schema_audit.json'), JSON.stringify(audit, null, 2), 'utf8');

if (PROBE) {
  log('');
  log('[审计] 抓到的消息类型分布（写得更详细：bili/raw/schema_audit.json）');
  log('  msg_type/msg_source  条数   content 顶层字段');
  for (const k of Object.keys(audit).sort()) {
    const a = audit[k];
    log(`  ${String(k).padEnd(20)} ${String(a.n).padStart(5)}   ${a.keys ? a.keys.join(', ') : '(非对象)'}`);
  }
  log('');
  log('  已抓 ' + messages.length + ' 条样本；前 3 条规范化结果：');
  for (const m of messages.slice(0, 3)) {
    log('   · ' + JSON.stringify({ type: m.type, from: m.from, text: (m.text || '').slice(0, 40), card: m.card ? m.card.sub : null, imgs: m.images.length }));
  }
  log('');
  log('[probe] 只抓了第一页，未写正式数据文件。去掉 --probe 即为正式更新。');
  if (cdp) cdp.close();
  process.exit(0);
}

// ---------------- 6) 下载图片 ----------------
if (!NO_IMG) {
  const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/avif': '.avif' };
  for (const [u, f] of [[peerAvatar, 'avatar_peer.jpg'], [selfAvatar, 'avatar_me.jpg']]) {
    if (!u) continue;
    const p = path.join(IMG_DIR, f);
    if (!exists(p)) { try { const r = await fetch(up(u), { headers: HDR(), signal: AbortSignal.timeout(30000) }); if (r.ok) fs.writeFileSync(p, Buffer.from(await r.arrayBuffer())); } catch {} }
    if (exists(p)) { if (f === 'avatar_peer.jpg') AVATAR.peer = 'bili/images/' + f; else AVATAR.me = 'bili/images/' + f; }
  }

  const jobs = [];
  for (const m of messages) for (const im of (m.images || [])) if (im.url) jobs.push(im);
  log('[3/6] 下载图片（共 ' + jobs.length + ' 项）…');
  let ok = 0, skip = 0, fail = 0;
  await pool(jobs, async (im) => {
    const base = path.join(IMG_DIR, im.file);
    for (const e of Object.values(EXT)) {
      if (exists(base + e)) { im.local = 'bili/images/' + im.file + e; skip++; return; }
    }
    try {
      const r = await fetch(im.url, { headers: HDR(), signal: AbortSignal.timeout(60000) });
      if (!r.ok) { fail++; return; }
      const ct = (r.headers.get('content-type') || '').split(';')[0];
      if (!/^image\//.test(ct)) { fail++; return; }
      const ext = EXT[ct] || '.jpg';
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100) { fail++; return; }
      fs.writeFileSync(base + ext, buf);
      im.local = 'bili/images/' + im.file + ext;
      im.bytes = buf.length;
      ok++;
    } catch { fail++; }
  });
  log(`      完成：新下载 ${ok}，已存在 ${skip}，失败 ${fail}`);
} else log('[3/6] 跳过图片下载');

// ---------------- 7) 输出 ----------------
messages.sort(cmpMsg);
const imgCount = messages.reduce((s, m) => s + (m.images || []).filter(i => i.local).length, 0);

// 统计用：按 msg_source / msg_type 的分布，供查看页展示口径
const bySource = {}, byType = {};
for (const m of messages) {
  bySource[m.msg_source] = (bySource[m.msg_source] || 0) + 1;
  byType[m.media_type] = (byType[m.media_type] || 0) + 1;
}
// 自动回复（msg_source 8~11 / 17）出现频次最高的原文，用于界面提示
const autoTally = {};
for (const m of messages) {
  if ((m.msg_source >= 8 && m.msg_source <= 11) || m.msg_source === 17) {
    const t = (m.text || '').trim();
    if (t) autoTally[t] = (autoTally[t] || 0) + 1;
  }
}
const autoTop = Object.entries(autoTally).sort((a, b) => b[1] - a[1])[0];

meta = {
  ...meta,
  source: 'bili',
  peer_uid: PEER_MID, peer_name: peerName, peer_avatar: up(peerAvatar),
  peer_avatar_local: AVATAR.peer || meta.peer_avatar_local || '',
  self_uid: selfMid, self_name: selfName, self_avatar: up(selfAvatar),
  self_avatar_local: AVATAR.me || meta.self_avatar_local || '',
  total: messages.length,
  images: imgCount,
  first_time: messages[0] ? messages[0].time : null,
  last_time: messages.length ? messages[messages.length - 1].time : null,
  oldest_seqno: reachEnd ? null : (messages[0] ? messages[0].seqno : null),
  newest_seqno: messages.length ? messages[messages.length - 1].seqno : null,
  auto_reply_top: autoTop ? { text: autoTop[0], n: autoTop[1] } : null,
  by_source: bySource, by_type: byType,
  updated_at: new Date().toISOString(),
};

log('[4/6] 写出数据…');
fs.writeFileSync(MSG_JSON, JSON.stringify(messages), 'utf8');
fs.writeFileSync(META_JSON, JSON.stringify(meta, null, 2), 'utf8');
fs.writeFileSync(path.join(BDIR, 'messages.js'),
  'window.' + GLOBALS.data + ' = ' + JSON.stringify({ meta, messages }).replace(/</g, '\\u003c') + ';\n', 'utf8');
if (SESSION.key !== 'bili') log('      会话：' + SESSION.key + '（' + SESSION.dir + '/，全局名 ' + GLOBALS.data + '）');

log('[5/6] 完成 ✅');
log('      消息总数：' + meta.total);
log('      图片总数：' + meta.images);
log('      时间范围：' + (meta.first_time || '?').slice(0, 10) + ' → ' + (meta.last_time || '?').slice(0, 10));
if (autoTop) log('      自动回复：' + JSON.stringify(autoTop[0]).slice(0, 40) + ' × ' + autoTop[1]);
if (cdp) cdp.close();
