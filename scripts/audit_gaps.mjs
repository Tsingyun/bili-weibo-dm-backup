#!/usr/bin/env node
/**
 * 漏抓对账（P1-6）
 * ===============================================================
 * 增量抓取的策略是「从新往回翻，遇到整页都是已有消息就停」。
 * 它有个盲区：**如果某次跑到一半断了（网络 / 限流 / 关机），中间可能留下一个洞**，
 * 而之后的每次增量都会从洞口之前就判定「已存在」而提前收工 —— 洞永远不会被发现。
 *
 * 这个脚本就是对账用的（**只读，不写任何数据**）：
 *   1) B站：seqno 是递增序号 → 本地排序后找「跳号」的区间（疑似洞）；
 *      再拉接口最新一页，看有没有本地没有的消息（新增未抓 / 真的漏了）。
 *   2) 微博：id 是 19 位数字、本来就不连续，没法看跳号；
 *      只能拉接口最新一页比对「本地缺哪些 id」。
 *
 * 三条硬规矩：
 *   · **默认不自动跑**（不进定时任务）—— 多发的请求可能触发平台限流；
 *   · 只读：一个字节都不写进数据目录；
 *   · 结论一律带「疑似」：对方删过消息、撤回、系统消息都会造成序号不连续。
 *
 * 用法：
 *   node scripts/audit_gaps.mjs                     # 两套都对账
 *   node scripts/audit_gaps.mjs --session bili
 *   node scripts/audit_gaps.mjs --offline           # 只做本地检查，完全不联网
 *   node scripts/audit_gaps.mjs --deep              # 多翻两页抽样（请求更多，慢一点）
 *   node scripts/audit_gaps.mjs --json              # 机器可读
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadSessions } from './sessions.mjs';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, d = '') => {
  const i = ARGS.indexOf(f);
  return (i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--')) ? ARGS[i + 1] : d;
};
const AS_JSON = has('--json');
const OFFLINE = has('--offline');
const DEEP = has('--deep');
const sessionArg = val('--session', 'all');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function fmtTs(ts) { return ts == null ? '?' : new Date(ts).toLocaleString('zh-CN'); }

async function get(url, cookie, referer) {
  try {
    const r = await fetch(url, {
      headers: { Cookie: cookie, Referer: referer, Origin: referer.replace(/\/$/, ''), 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(40000),
    });
    const t = await r.text();
    if (r.status !== 200) return { _err: 'HTTP ' + r.status };
    // 大整数保护：与 bili_update.mjs 同一套处理（msg_key/msg_seqno 有 19 位）
    const patched = t.replace(/"(msg_key|msg_seqno|biz_id2|biz_id1|gpt_session_id)"(\s*:\s*)(\d{15,})/g, '"$1"$2"$3"');
    try { return JSON.parse(patched); } catch { try { return JSON.parse(t); } catch { return { _err: '解析失败' }; } }
  } catch (e) { return { _err: e.message }; }
}

/**
 * B站：本地 seqno 的跳号区间（纯本地，不联网）
 *
 * ⚠ 这个**不能**单独当"漏抓"的证据：B站的 seqno 不是连续整数，
 *   里面带位段（实测相邻两条常常正好差 4096 上下），跳号是常态。
 *   所以它的定位只是「信息」，不计入 problems，也不自动给补抓建议 ——
 *   真正能下结论的是联网那部分（线上最新一页里本地到底缺不缺）。
 */
export function localSeqnoGaps(messages, { minGap = 2, maxGap = 5000, limit = 8 } = {}) {
  const nums = [];
  for (const m of messages) {
    const n = Number(m && m.seqno);
    if (Number.isFinite(n) && n > 0) nums.push(n);
  }
  if (nums.length < 2) return [];
  nums.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < nums.length; i++) {
    const d = nums[i] - nums[i - 1];
    // d === 1 连续；d <= 1 是重复；超大间隔多半是对方清过记录或会话重建，不报
    if (d >= minGap && d <= maxGap) gaps.push({ from: nums[i - 1], to: nums[i], missing: d - 1 });
  }
  gaps.sort((a, b) => b.missing - a.missing);
  return gaps.slice(0, limit);
}

/**
 * 对一个会话做对账。
 * @returns {{key,label,dir,gaps:Array,remoteMissing:Array,remoteNewest:*,localNewest:*,note?:string,online:boolean}}
 */
export async function auditSession(s, opts = {}) {
  const out = { key: s.key, label: s.label, dir: s.dir, online: false, gaps: [], remoteMissing: [], advice: [] };
  const dirAbs = path.join(ROOT, s.dir);
  const messages = readJson(path.join(dirAbs, 'messages.json'), null);
  if (!Array.isArray(messages) || !messages.length) {
    out.note = `${s.dir}/messages.json 还没有数据`;
    return out;
  }
  out.local = messages.length;

  if (s.platform === 'bili') {
    // 只提示、不算问题：见 localSeqnoGaps 的注释（seqno 带位段，跳号是常态）
    out.jumps = localSeqnoGaps(messages);
  }

  if (opts.offline) { out.note = out.note || '（--offline：未联网核对）'; return out; }

  const cookieFile = path.join(dirAbs, 'cookie_header.txt');
  if (!exists(cookieFile)) { out.note = '没有 Cookie 文件，跳过联网核对（先跑一次备份登录）'; return out; }
  const cookie = fs.readFileSync(cookieFile, 'utf8').trim();
  if (!cookie) { out.note = 'Cookie 是空的，跳过联网核对'; return out; }

  const peerUid = s.peer && s.peer.uid;
  if (!peerUid) { out.note = 'sessions.json 里没配 peer.uid，跳过联网核对'; return out; }

  out.online = true;
  if (s.platform === 'bili') {
    const q = new URLSearchParams({
      talker_id: peerUid, session_type: '1', size: '50',
      sender_device_id: '1', build: '0', mobi_app: 'web',
    });
    const j = await get(`https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?${q}`,
                        cookie, 'https://message.bilibili.com/');
    if (j._err || j.code !== 0) {
      out.note = '接口没打通：' + ((j && (j.message || j._err)) || '未知错误') + '（可能是登录态过期）';
      return out;
    }
    const list = (j.data && j.data.messages) || [];
    const have = new Set(messages.map((m) => String(m.id)));
    const seqs = messages.map((m) => Number(m.seqno)).filter((n) => Number.isFinite(n));
    out.localNewest = seqs.length ? Math.max(...seqs) : null;
    out.remoteNewest = Number(j.data && j.data.max_seqno) || null;
    out.remoteMissing = list.filter((m) => !have.has(String(m.msg_key)))
      .map((m) => ({ id: String(m.msg_key), seqno: String(m.msg_seqno), ts: Number(m.timestamp) * 1000 }));
    if (out.localNewest && out.remoteNewest && out.remoteNewest > out.localNewest) {
      out.advice.push(`线上最新序号 ${out.remoteNewest} 比本地 ${out.localNewest} 大 —— 有新消息没抓，跑一次增量即可`);
    }
    if (opts.deep) {
      // 抽样：从最新一页的最早一条再往回翻一页，看那一页本地是否齐全
      const oldest = list.length ? String(list[list.length - 1].msg_seqno) : '';
      if (oldest) {
        await sleep(700);
        const q2 = new URLSearchParams({ talker_id: peerUid, session_type: '1', size: '50', sender_device_id: '1', build: '0', mobi_app: 'web', end_seqno: oldest });
        const j2 = await get(`https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?${q2}`,
                             cookie, 'https://message.bilibili.com/');
        const l2 = (j2 && j2.data && j2.data.messages) || [];
        const miss2 = l2.filter((m) => !have.has(String(m.msg_key))).length;
        out.deep = { checked: l2.length, missing: miss2 };
        if (miss2) out.advice.push(`往回抽样的一页里还有 ${miss2} 条本地没有 —— 中途断过的可能性较大，建议跑一次全量`);
      }
    }
  } else {
    const url = `https://api.weibo.com/webim/2/direct_messages/conversation.json?convert_emoji=1&count=50&max_id=0&uid=${peerUid}&is_include_group=0&from_contacts=1&source=209678993`;
    const j = await get(url, cookie, 'https://api.weibo.com/chat');
    if (j._err || !Array.isArray(j.direct_messages)) {
      out.note = '接口没打通：' + ((j && (j.message || j._err)) || '返回不是消息列表') + '（可能是登录态过期）';
      return out;
    }
    const list = j.direct_messages || [];
    const have = new Set(messages.map((m) => String(m.id)));
    out.remoteMissing = list
      .map((m) => ({ id: String(m.idstr || m.mid || m.id), ts: Date.parse(m.created_at) }))
      .filter((x) => !have.has(x.id));
    if (out.remoteMissing.length) {
      out.advice.push(`线上最新 ${list.length} 条里有 ${out.remoteMissing.length} 条本地没有 → 跑一次增量：` +
                      ` node scripts/update.mjs --session ${s.key}`);
    }
  }
  return out;
}

async function main() {
  let sessions;
  try { sessions = loadSessions(); } catch (e) { console.error('[×] sessions.json 有问题：' + e.message); return 2; }
  sessions = sessions.filter((s) => !s.imported);
  if (sessionArg !== 'all') {
    sessions = sessions.filter((s) => s.key === sessionArg);
    if (!sessions.length) { console.error(`[×] 不认识会话「${sessionArg}」`); return 2; }
  }

  const reports = [];
  for (const s of sessions) {
    reports.push(await auditSession(s, { offline: OFFLINE, deep: DEEP }));
    await sleep(400);                       // 会话之间留口气，别连着打接口
  }

  // 只有「线上有、本地没有」才算问题；本地跳号（jumps）仅供参考，不计入
  const problems = reports.reduce((n, r) =>
    n + (r.remoteMissing || []).length + ((r.deep && r.deep.missing) || 0), 0);

  if (AS_JSON) {
    console.log(JSON.stringify({ audited: reports, summary: { problems } }, null, 2));
    return problems ? 1 : 0;
  }

  console.log('私信备份 · 漏抓对账' + (OFFLINE ? '（离线：只看本地序号）' : '（联网：会打接口，已限速）'));
  console.log('  项目  ' + ROOT);
  console.log('');
  for (const r of reports) {
    console.log('─'.repeat(62));
    console.log(`【${r.label}】${r.dir}/　本地 ${r.local ?? '-'} 条`);
    if (r.note) console.log('  ⚠ ' + r.note);
    if ((r.jumps || []).length) {
      console.log(`  ⚠ 本地序号跳号 ${r.jumps.length} 处（B站 seqno 带位段，跳号本身是正常的，**仅参考**）：`);
      for (const g of r.jumps.slice(0, 3)) console.log(`      · ${g.from} → ${g.to}（差 ${g.missing + 1}）`);
    }
    if ((r.remoteMissing || []).length) {
      console.log(`  ❌ 线上最新一页里有 ${r.remoteMissing.length} 条本地没有：`);
      for (const m of r.remoteMissing.slice(0, 5)) console.log(`      · ${m.id}（${fmtTs(m.ts)}）`);
    }
    if (r.deep && r.deep.missing) console.log(`  ⚠ 往回抽样 ${r.deep.checked} 条，其中 ${r.deep.missing} 条本地没有`);
    for (const a of (r.advice || [])) console.log('  → ' + a);
    if (!(r.remoteMissing || []).length && !(r.deep && r.deep.missing) && !r.note) console.log('  ✅ 没发现缺口');
  }
  console.log('─'.repeat(62));
  console.log(problems ? '❌ 发现疑似缺口：按上面的命令补一次（增量够就用增量，跳号多就用全量）'
                       : '✅ 没发现缺口');
  return problems ? 1 : 0;
}

/* ⚠ 必须有这层判断：doctor.mjs 会 import 本模块来跑 --audit，
 *   没有它的话，被 import 的瞬间 main() 就会自己执行一遍、打印一遍、
 *   最后 process.exit 把 doctor 一起带走（真的踩过）。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
