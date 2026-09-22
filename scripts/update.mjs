#!/usr/bin/env node
/**
 * 微博私信备份 · 更新脚本
 * ---------------------------------------------------------------
 * 架构：专用浏览器实例（CDP 9333）**只用来取一次登录 Cookie**；
 *       之后所有接口请求与图片下载都由 Node 直接发起（快、稳、可重试）。
 *       若浏览器不在，则回退使用本地已保存的 Cookie。
 *
 * 用法：
 *   node update.mjs            # 增量更新（默认）
 *   node update.mjs --full     # 全量重拉
 *   node update.mjs --no-img   # 只更新文字
 */
import fs from 'node:fs';
import path from 'node:path';
import { CDP, sleep } from './cdp_lib.mjs';
import { findSession, sessionFromArgs, peerUidOrExit } from './sessions.mjs';
import { dayStart, dayEnd } from './msg_kind.mjs';
import { jsAssign } from './lib/jsassign.mjs';

// ---------------- 配置 ----------------
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.WEIBO_CDP_PORT || 9333);

const PAGE_COUNT = 50;
const MAX_PAGES = 4000;
const MAX_IMG_DIM = 9999;
const DL_CONCURRENCY = 8;
const API_BASE = 'https://api.weibo.com/webim/';
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
// --rebuild：忽略本地记录，按当前 normalize 规则全量重新抓取一遍（改了 normalize 逻辑后用）
const REBUILD = ARGS.includes('--rebuild');

// ---- 会话（多会话支持）：--session <key> 决定数据目录与导出的全局名 ----
// 清单在项目根 sessions.json，归一化逻辑在 scripts/sessions.mjs。
// 不传 --session 就是原来的行为（weibo → data/ → window.DM_DATA）。
const SESSION = findSession(sessionFromArgs(ARGS, 'weibo'));
const DATA_DIR = path.join(ROOT, SESSION.dir);
const IMG_DIR = path.join(DATA_DIR, 'images');
const GLOBALS = SESSION.globals;
const AVATAR = { peer: '', me: '' };

// ---- 聊天对象 / 自己：全部从 sessions.json 读，脚本里不写死任何 uid 或昵称 ----
// 「要备份谁的私信」是使用者自己的事，分享出去的版本必须由他们自己填（见 sessions.mjs）。
const PEER_UID = peerUidOrExit(SESSION);
const PEER_NAME = SESSION.peer.name || '';   // 留空则从接口取，取不到时退化为「对方」
const SELF_UID = SESSION.self.uid;           // 留空则从接口探测（下面 profile 那段）
const SELF_NAME = SESSION.self.name || '';   // 留空则从接口取

// ---------------- 工具 ----------------
fs.mkdirSync(IMG_DIR, { recursive: true });
// raw/ 只放过程留档（rebuild 备份、断点续抓），内容可随时清空；
// 但目录必须自己建：重建模式下要往 raw/rebuild_partial.json 落盘，目录不在会中断（对齐 bili_update.mjs）。
fs.mkdirSync(path.join(DATA_DIR, 'raw'), { recursive: true });
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const log = (...a) => console.log(...a);
const H = (s) => { let h = 5381; s = String(s); for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };

let COOKIE = '';
const HDR = () => ({
  Cookie: COOKIE,
  Referer: 'https://api.weibo.com/chat',
  'User-Agent': UA,
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/plain, */*',
});

async function apiGet(pathname, { retries = 3 } = {}) {
  const url = pathname.startsWith('http') ? pathname : API_BASE + pathname;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: HDR(), signal: AbortSignal.timeout(30000) });
      const t = await r.text();
      if (r.status === 200) return t;
      if (i === retries) return 'ERR:HTTP ' + r.status + ' ' + t.slice(0, 120);
    } catch (e) {
      if (i === retries) return 'ERR:' + e.message;
    }
    await sleep(600 * (i + 1));
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
const savedCookieFile = path.join(DATA_DIR, 'cookie_header.txt');
if (exists(savedCookieFile)) COOKIE = fs.readFileSync(savedCookieFile, 'utf8').trim();

try {
  cdp = await CDP.attach(PORT, 'api.weibo.com/chat');
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
  for (const c of ck) if (/weibo|sina/.test(c.domain)) if (!(c.name in jar)) jar[c.name] = c.value;
  const fresh = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  if (/SUB=/.test(fresh)) {
    COOKIE = fresh;
    fs.writeFileSync(savedCookieFile, COOKIE, 'utf8');
    log('      已从浏览器刷新 Cookie（' + COOKIE.length + ' 字符）');
  } else if (COOKIE) {
    log('      浏览器未登录，沿用本地 Cookie');
  }
} catch {
  log('      未连接浏览器，沿用本地 Cookie');
}
if (!COOKIE) { console.error('[×] 没有任何可用 Cookie，请先运行「命令/备份与更新/更新备份.cmd」。'); process.exit(2); }

// ---------------- 2) 校验登录态 ----------------
let selfUid = SELF_UID, selfName = SELF_NAME, selfAvatar = '', peerAvatar = '';
let peerName = PEER_NAME;   // 配置里留空也没关系：下面从接口取，取不到再退化为「对方」
const primary = await apiGet('query_primary_info.json?source=209678993');
try {
  const pi = JSON.parse(primary);
  if (!pi || !pi.profile) throw new Error('no profile');
  selfUid = String(pi.profile.id);
  selfName = pi.profile.screen_name;
  selfAvatar = pi.profile.avatar_large || pi.profile.profileImageUrl || '';
  log('      登录账号：' + selfName + ' (' + selfUid + ')');
} catch {
  console.error('\n[×] 登录态已失效（Cookie 过期）。');
  console.error('    请打开专用浏览器窗口登录微博，然后重新运行。');
  process.exit(3);
}

try {
  const uc = JSON.parse(await apiGet(`2/users/show.json?uid=${PEER_UID}&source=209678993`));
  const u = uc.user || uc;
  if (u && u.avatar_large) peerAvatar = u.avatar_large;
  // 昵称也顺手取一份：sessions.json 里 peer.name 留空时靠它补全（不写死任何名字）
  if (u && u.screen_name) peerName = u.screen_name;
} catch { /* ignore */ }
if (peerName) log('      聊天对象：' + peerName + ' (' + PEER_UID + ')');
else log('      聊天对象：' + PEER_UID + '（接口没返回昵称，界面会显示「对方」）');

// ---------------- 3) 载入已有数据 ----------------
const MSG_JSON = path.join(DATA_DIR, 'messages.json');
const META_JSON = path.join(DATA_DIR, 'meta.json');
let messages = [];
let meta = {};
if (exists(MSG_JSON)) {
  try { messages = J(MSG_JSON); } catch { messages = []; }
  if (exists(META_JSON)) { try { meta = J(META_JSON); } catch {} }
  log('      已有 ' + messages.length + ' 条本地记录');
}
if (REBUILD) {
  const bak = path.join(DATA_DIR, 'raw', 'messages.bak.json');
  try {
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(MSG_JSON, bak);
  } catch (e) {
    // 备份失败就中止 —— 绝不能「没备份成还宣告成功」，然后清空全量历史
    throw new Error('重建前备份失败，已中止以免丢数据：' + e.message);
  }
  log('      [重建] 忽略本地记录，按当前规则全量重抓（原数据已备份到 data/raw/messages.bak.json）');
  messages = [];
}
const seen = new Set(messages.map(m => m.id));

// ---------------- 4) 规范化 ----------------
function normalize(m) {
  const isMe = String(m.sender_id) === String(selfUid);
  const mediaType = m.media_type;
  const recalled = m.recall_status === 1;
  const images = [];
  const push = (o) => { if (!images.some(x => x.file === o.file)) images.push(o); };

  if (Array.isArray(m.pic_infos)) {
    for (const p of m.pic_infos) {
      const u = String(p.original_pic || p.bmiddle_pic || p.thumbnail_pic || '').replace(/^http:/, 'https:');
      if (!u) continue;
      push({ kind: 'photo', url: u, file: 'pic_' + H(p.pid || u) });
    }
  }
  // 注意：media_type=10(视频) / 4(语音) 的 att_ids 是视频/音频文件本身，不是图片，
  // 拿去做 msget_thumbnail 必然失败；它们的画面应从 ext_text.video_pic_fid 取封面。
  if (Array.isArray(m.att_ids) && mediaType !== 10 && mediaType !== 4) {
    for (const fid of new Set(m.att_ids)) push({ kind: 'photo', fid: String(fid), file: 'photo_' + fid });
  }
  for (const o of (m.url_objects || [])) {
    const long = (o.info && o.info.url_long) || '';
    const mm = long.match(/compic_id\/(\d+):([0-9A-Za-z]+)/);
    if (mm) {
      const tail = mm[2];
      push({
        kind: 'emoji', pid: tail, short: o.url_ori || '', file: 'emoji_' + tail,
        cands: [...new Set([tail, tail.slice(-35), tail.slice(-34)])],
      });
    }
  }

  const links = [];
  for (const o of (m.url_objects || [])) {
    const info = o.info || {};
    if (info.url_long && !/compic_id/.test(info.url_long)) {
      links.push({ short: o.url_ori || '', long: info.url_long, title: info.title || '' });
    }
  }

  let card = null;
  for (const o of (m.url_objects || [])) {
    if (o.status) {
      const st = o.status;
      for (const pid of (st.pic_ids || []).slice(0, 9)) {
        push({
          kind: 'photo', file: 'card_' + H(pid),
          url: 'https://wx1.sinaimg.cn/large/' + pid + '.jpg',
          alt: [2, 3, 4].map(n => 'https://wx' + n + '.sinaimg.cn/large/' + pid + '.jpg'),
        });
      }
      card = {
        kind: 'weibo',
        author: (st.user && st.user.screen_name) || '',
        text: st.text || '',
        url: st.user ? ('https://weibo.com/' + st.user.id + '/' + (st.mid_str || st.mid || '')) : '',
        created: st.created_at || '',
      };
      break;
    }
    const obj = o.object && o.object.object;
    if (obj && (obj.display_name || obj.summary)) {
      let desc = obj.summary || '';
      try { const ap = JSON.parse((obj.applets_content && obj.applets_content.params) || '{}'); if (ap.message) desc = ap.message; } catch {}
      card = { kind: 'wbox', author: obj.display_name || '', text: desc, url: obj.target_url || obj.url || '' };
      break;
    }
  }

  // 视频封面：video_pic_fid 在 ext_text **顶层**（不是 push_proc_ext 里），两处都兜一下
  const ET = (m.ext_text && typeof m.ext_text === 'object') ? m.ext_text : {};
  const PP = (ET.push_proc_ext && typeof ET.push_proc_ext === 'object') ? ET.push_proc_ext : {};
  const videoCover = PP.video_pic_fid || ET.video_pic_fid || '';
  if (videoCover) push({ kind: 'cover', fid: String(videoCover), file: 'vcover_' + videoCover });
  const gifVideo = PP.gif_video || '';

  // type 描述「内容是什么」，撤回只是标记（recalled 字段），不覆盖 type
  let type = 'text';
  if (mediaType === 10) type = 'video';
  else if (mediaType === 4) type = 'voice';
  else if (mediaType === 9) type = 'emoji';
  else if (mediaType === 11) type = 'link';
  else if (mediaType === 13 || mediaType === 14) type = card ? 'card' : 'link';
  else if (mediaType === 1 || mediaType === 15) type = 'image';
  else if (images.some(i => i.kind === 'photo' || i.kind === 'cover')) type = 'image';
  else if (mediaType !== 0 && mediaType != null) type = 'other';

  const t = new Date(m.created_at);
  return {
    id: String(m.idstr || m.mid || m.id),
    ts: isNaN(t.getTime()) ? null : t.getTime(),
    time: isNaN(t.getTime()) ? String(m.created_at || '') : t.toISOString(),
    from: isMe ? 'me' : 'peer',
    sender: m.sender_screen_name || '',
    type, media_type: mediaType, recalled,
    text: typeof m.text === 'string' ? m.text : '',
    images, links, card,
    gif_video: gifVideo || '',
  };
}

// ---------------- 5) 翻页拉取 ----------------
log('[2/6] 拉取私信记录（' + (REBUILD ? '重建' : FULL ? '全量' : '增量') + '）…');
let cursor = '0', page = 0, added = 0, reachEnd = false;
const startedAt = Date.now();
while (page < MAX_PAGES) {
  const raw = await apiGet(`2/direct_messages/conversation.json?convert_emoji=1&count=${PAGE_COUNT}&max_id=${cursor}&uid=${PEER_UID}&is_include_group=0&from_contacts=1&source=209678993`);
  let j;
  try { j = JSON.parse(raw); } catch { log('      解析失败，停止：' + String(raw).slice(0, 160)); break; }
  const list = j.direct_messages || [];
  if (!list.length) { reachEnd = true; break; }
  let fresh = 0;
  for (const m of list) {
    const n = normalize(m);
    if (UNTIL_TS != null && (n.ts == null || n.ts > UNTIL_TS)) continue;   // --until：比这更晚的不要
    if (!seen.has(n.id)) { seen.add(n.id); messages.push(n); fresh++; }
  }
  added += fresh; page++;
  // --since：翻到比这个日期更早的一页就收工（这一页仍然纳入）
  if (SINCE_TS != null) {
    const oldest = list[list.length - 1];
    const ots = oldest && oldest.created_at ? Date.parse(oldest.created_at) : null;
    if (ots != null && ots < SINCE_TS) { log('      已到达 --since 指定的起始日期，停止翻页'); break; }
  }
  if (page % 20 === 0 || fresh === 0) {
    log(`      第 ${page} 页（累计 ${messages.length} 条）→ 最早 ${new Date(list[list.length - 1].created_at).toLocaleString('zh-CN')}`);
  }
  if (page % 50 === 0) {
    messages.sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id)));
    const bp = REBUILD ? path.join(DATA_DIR, 'raw', 'rebuild_partial.json') : MSG_JSON;
    fs.writeFileSync(bp, JSON.stringify(messages), 'utf8');
    log(`      [断点] 已落盘 ${messages.length} 条 → ${path.basename(bp)}`);
  }
  if (list.length < PAGE_COUNT) { reachEnd = true; break; }
  if (fresh === 0 && !FULL) { log('      已追平上次进度，停止翻页'); break; }
  cursor = String(list[list.length - 1].idstr);
  await sleep(150);
}
log(`      共翻 ${page} 页，新增 ${added} 条，累计 ${messages.length} 条（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);

// ---------------- 6) 表情图地址 ----------------
let emojiMap = exists(path.join(DATA_DIR, 'emoji_map.json')) ? J(path.join(DATA_DIR, 'emoji_map.json')) : {};
if (!NO_IMG) {
  const allPids = [...new Set(
    messages.flatMap(m => (m.images || []).filter(i => i.kind === 'emoji').flatMap(i => i.cands || [i.pid]))
  )];
  if (allPids.length) {
    log('[3/6] 解析表情图片（' + allPids.length + ' 个 pid）…');
    for (let i = 0; i < allPids.length; i += 10) {
      const t = await apiGet('pic_infos.json?pids=' + allPids.slice(i, i + 10).join(',') + '&source=209678993');
      try { const o = JSON.parse(t); for (const [k, v] of Object.entries(o)) if (v) emojiMap[k] = v; } catch {}
      await sleep(120);
    }
    fs.writeFileSync(path.join(DATA_DIR, 'emoji_map.json'), JSON.stringify(emojiMap, null, 1), 'utf8');
    log('      解析到 ' + Object.keys(emojiMap).length + ' 个表情地址');
  }
} else log('[3/6] 跳过表情解析');

// ---------------- 7) 下载图片 ----------------
if (!NO_IMG) {
  const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };

  for (const [u, f] of [[peerAvatar, 'avatar_peer.jpg'], [selfAvatar, 'avatar_me.jpg']]) {
    if (!u) continue;
    const p = path.join(IMG_DIR, f);
    if (!exists(p)) { try { const r = await fetch(u, { headers: HDR(), signal: AbortSignal.timeout(30000) }); if (r.ok) fs.writeFileSync(p, Buffer.from(await r.arrayBuffer())); } catch {} }
    if (exists(p)) { if (f === 'avatar_peer.jpg') AVATAR.peer = 'data/images/' + f; else AVATAR.me = 'data/images/' + f; }
  }

  const jobs = [];
  for (const m of messages) {
    for (const im of (m.images || [])) {
      let url = '', extra = [];
      if (im.kind === 'emoji') {
        // pic_infos.json 对表情返回的是丢扩展名的模板地址，如
        //   http://ss6.sinaimg.cn/bmiddle/<pid>&690   ← 404
        // 真图应为 https://ss6.sinaimg.cn/bmiddle/<pid>.gif，这里补全候选并优选。
        const pids = im.cands || [im.pid];
        const raw = [];
        for (const k of pids) { const v = emojiMap[k]; if (v) raw.push(v); }
        if (!raw.length) continue;
        const good = (s) => (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(s) ? 1 : 0);
        const got = new Set();
        const add = (u) => {
          if (!u) return;
          u = u.replace(/^http:\/\//, 'https://');
          if (got.has(u)) return;
          got.add(u); extra.push(u);
        };
        for (const v0 of raw) {
          const v = v0.replace(/^http:\/\//, 'https://');
          add(v);                                                       // 原样
          const m = v.match(/^(https:\/\/[^/]+\/[^/]+\/)(.+?)(?:&690)?$/);
          if (m) for (const ext of ['.gif', '.jpg', '.png']) add(m[1] + m[2] + ext);
        }
        for (const k of pids) add('https://ss6.sinaimg.cn/bmiddle/' + k + '.gif');
        extra.sort((a, b) => good(b) - good(a));
        url = extra.shift();
      } else if (im.url) {
        url = im.url;
      } else if (im.fid) {
        url = `https://upload.api.weibo.com/2/mss/msget_thumbnail?fid=${im.fid}&high=${MAX_IMG_DIM}&width=${MAX_IMG_DIM}&size=${MAX_IMG_DIM},${MAX_IMG_DIM}&source=209678993&imageType=origin`;
      }
      if (!url) continue;
      im.url = url;
      if (!im.file) im.file = 'img_' + H(url);
      jobs.push({ im, url, alt: [...(im.alt || []), ...extra] });
    }
  }

  log('[4/6] 下载图片（共 ' + jobs.length + ' 项）…');
  let ok = 0, skip = 0, fail = 0;
  const inflight = new Map();
  await pool(jobs, async ({ im, url, alt }) => {
    const base = path.join(IMG_DIR, im.file);
    for (const e of Object.values(EXT)) {
      if (exists(base + e)) { im.local = 'data/images/' + im.file + e; skip++; return; }
    }
    void inflight;
    for (const u of [url].concat(alt || [])) {
      try {
        const r = await fetch(u, { headers: HDR(), signal: AbortSignal.timeout(60000) });
        if (!r.ok) continue;
        const ct = (r.headers.get('content-type') || '').split(';')[0];
        if (!/^image\//.test(ct)) continue;
        const ext = EXT[ct] || '.jpg';
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 100) continue;
        fs.writeFileSync(base + ext, buf);
        im.local = 'data/images/' + im.file + ext;
        im.bytes = buf.length;
        ok++; return;
      } catch { /* 试下一个 */ }
    }
    fail++;
  });
  log(`      完成：新下载 ${ok}，已存在 ${skip}，失败 ${fail}`);
} else log('[4/6] 跳过图片下载');

// ---------------- 8) 输出 ----------------
messages.sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id)));
const imgCount = messages.reduce((s, m) => s + (m.images || []).filter(i => i.local).length, 0);
meta = {
  ...meta,
  peer_uid: PEER_UID, peer_name: peerName, peer_avatar: peerAvatar,
  peer_avatar_local: AVATAR.peer || meta.peer_avatar_local || '',
  self_uid: selfUid, self_name: selfName, self_avatar: selfAvatar,
  self_avatar_local: AVATAR.me || meta.self_avatar_local || '',
  total: messages.length,
  images: imgCount,
  first_time: messages[0] ? messages[0].time : null,
  last_time: messages.length ? messages[messages.length - 1].time : null,
  oldest_id: reachEnd ? null : (messages[0] ? messages[0].id : null),
  newest_id: messages.length ? messages[messages.length - 1].id : null,
  updated_at: new Date().toISOString(),
};

log('[5/6] 写出数据…');
fs.writeFileSync(MSG_JSON, JSON.stringify(messages), 'utf8');
fs.writeFileSync(META_JSON, JSON.stringify(meta, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'messages.js'),
  jsAssign(GLOBALS.data, JSON.stringify({ meta, messages })), 'utf8');
if (SESSION.key !== 'weibo') log('      会话：' + SESSION.key + '（' + SESSION.dir + '/，全局名 ' + GLOBALS.data + '）');

log('[6/6] 完成 ✅');
log('      消息总数：' + meta.total);
log('      图片总数：' + meta.images);
log('      时间范围：' + (meta.first_time || '?').slice(0, 10) + ' → ' + (meta.last_time || '?').slice(0, 10));
if (cdp) cdp.close();
