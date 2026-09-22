/**
 * B站视图 · 仿真验证（不需要登录 B站、不需要真实数据）
 * ===========================================================================
 * 做法：用 jsdom 的 beforeParse 钩子，在页面脚本执行前把 window.DM_DATA_B /
 *       DM_FACES_B 注入进去（bili/messages.js 文件缺失时不会覆盖注入值），
 *       于是可以完整驱动「顶部切换按钮 → B站视图」这条链路。
 *
 * 验证项：
 *   A. 顶部切换条存在、两个按钮、B站按钮带条数徽章
 *   B. 点 B站能真的切换过去（CUR_SRC / 渲染出的消息数）
 *   C. B站卡片（分享视频 / 视频推送 / 通知 / 专栏 / 关注推送）渲染成 .wcard.bc
 *   D. B站统计口径按 msg_source / msg_type 结构化判定（与微博文案匹配逻辑不同）
 *   E. 统计面板文案是 B站版，且数字与独立重算一致
 *   F. B站表情（字典键不带方括号）能渲染成图
 *   G. 切回微博后数据完全恢复，且反复切换不会泄漏监听器 / 堆叠徽章
 */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom');

/* ---------------------------------------------------------------------------
   构造页面 HTML 时，把 B站 那几个数据文件的 <script> 标签剔掉。
   原因：本脚本靠 beforeParse 注入假数据，而页面里的
   <script src="bili/messages.js"> 会**紧跟着**覆盖掉注入值。
   早先 bili/messages.js 不存在，所以注入侥幸生效；
   2026-09-15 首次真实备份落地后，真文件把假数据冲掉，7 项断言集体失败
   （真实 2912 条 vs 仿真 206 条）。

   试过 jsdom 的 resources.interceptors 拦截 —— 但 file:// 的脚本不走 undici，
   拦截器根本不生效；所以直接改 HTML 最稳，且与本机是否已有真实备份彻底解耦。
   只剔 B站 那 4 个文件，微博数据（data/*.js）照常从磁盘加载。
   --------------------------------------------------------------------------- */
const STUB_RE = /<script src="bili\/(?:messages|faces|ocr|vlm)\.js"[^>]*>\s*<\/script>/g;

const DIR = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass = [], fail = [];
const chk = (ok, label, extra) => {
  (ok ? pass : fail).push(label + (extra ? '  → ' + extra : ''));
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  → ' + extra : ''));
};

/* ============================ 构造仿真 B站数据 ============================ */
const PEER = '示例UP主', ME = '我';
const PEER_MID = '1234567', MY_MID = '1098765432';
const msgs = [];
let n = 0;
function add(ts, from, patch) {
  n++;
  const mt = patch && patch.media_type != null ? patch.media_type : 1;
  const typ = { 1: 'text', 2: 'image', 5: 'recall', 6: 'emoji', 7: 'card', 9: 'card', 10: 'card', 11: 'video', 12: 'card', 13: 'card', 14: 'card', 16: 'card', 18: 'notice', 19: 'ai' }[mt] || 'other';
  msgs.push(Object.assign({
    id: 'key' + n, seqno: String(1000000 + n), ts,
    time: new Date(ts).toISOString(),
    from, sender: from === 'me' ? ME : (from === 'peer' ? PEER : '系统'),
    type: typ, media_type: mt, msg_source: 0, recalled: false, recall_key: '',
    text: '', images: [], links: [], card: null,
  }, patch || {}));
}
const DAY = 86400000;
const BASE = Date.UTC(2026, 6, 1, 4, 0, 0);   // 2026-07-01 12:00 北京时间
for (let d = 0; d < 62; d++) {
  const t0 = BASE + d * DAY;
  add(t0, 'peer', { text: '感谢关注喵～', msg_source: 8 });          // 自动回复
  add(t0 + 1800000, d % 2 ? 'me' : 'peer', { text: '第' + (d + 1) + '天的日常 [tv_doge]' });
  add(t0 + 5400000, 'peer', { text: '收到啦～' });
  if (d % 17 === 3) add(t0 + 7000000, 'me', { media_type: 2, text: '分享图片', images: [{ kind: 'photo', url: 'https://i0.hdslb.com/x.jpg', file: 'img_a', local: 'bili/images/img_a.jpg' }] });
  if (d % 19 === 5) add(t0 + 7400000, 'peer', { media_type: 6, text: '自定义表情', images: [{ kind: 'emoji', url: 'https://i0.hdslb.com/e.gif', file: 'face_b', local: 'bili/images/face_b.gif' }] });
  if (d % 23 === 7) add(t0 + 7800000, 'peer', {
    media_type: 7, text: '',
    card: { kind: 'bili', sub: '分享视频', author: '某UP主', title: '【翻唱】夜に駆ける', text: '', url: 'https://www.bilibili.com/video/BV1xx411c7mD', bvid: 'BV1xx411c7mD', created: '' },
    images: [{ kind: 'card', url: 'https://i0.hdslb.com/c.jpg', file: 'card_c', local: 'bili/images/card_c.jpg' }],
  });
  if (d % 29 === 11) add(t0 + 8200000, 'peer', {
    media_type: 11, text: '',
    card: { kind: 'bili', sub: '视频', author: '', title: '新投稿来啦', text: '简介文本', url: 'https://www.bilibili.com/video/BV1yy411c7mE', bvid: 'BV1yy411c7mE', created: '', extra: '播放 12345 · 时长 3 分' },
  });
  if (d % 31 === 13) add(t0 + 8600000, 'sys', { media_type: 10, text: '直播开始提醒', card: { kind: 'bili', sub: '通知', author: '示例UP主', title: '开播啦', text: '快来直播间', url: 'https://live.bilibili.com/25788785' } });
  if (d % 37 === 17) add(t0 + 9000000, 'sys', { media_type: 18, text: '你与对方已成为好友' });
}
// 几条特殊消息
add(BASE + 61 * DAY + 9500000, 'me', { media_type: 5, text: '你撤回了一条消息', recall_key: 'key1', recalled: false });
add(BASE + 61 * DAY + 9700000, 'peer', { media_type: 16, text: '', card: { kind: 'bili', sub: '关注推送', author: '', title: '更多宝藏内容', text: '回复「你好」领取', url: 'https://www.bilibili.com/read/cv123' } });
add(BASE + 61 * DAY + 9900000, 'peer', { media_type: 19, text: '今天也要开心哦' });
add(BASE + 61 * DAY + 9950000, 'peer', { media_type: 13, text: '', card: { kind: 'bili', sub: '卡片', author: '', title: '活动卡片', text: '', url: 'https://www.bilibili.com/blackboard/x.html' } });
msgs.sort((a, b) => a.ts - b.ts);

const FAKE = {
  meta: {
    source: 'bili', peer_uid: PEER_MID, peer_name: PEER, peer_avatar: '',
    peer_avatar_local: '', self_uid: MY_MID, self_name: ME, self_avatar: '',
    self_avatar_local: '', total: msgs.length,
    images: msgs.reduce((s, m) => s + (m.images || []).filter(i => i.local).length, 0),
    first_time: msgs[0].time, last_time: msgs[msgs.length - 1].time,
    oldest_seqno: null, newest_seqno: msgs[msgs.length - 1].seqno,
    auto_reply_top: { text: '感谢关注喵～', n: msgs.filter(m => m.msg_source === 8).length },
    by_source: {}, by_type: {}, updated_at: new Date().toISOString(),
  },
  messages: msgs,
};
const FAKE_FACES = { phrase: { tv_doge: 'bili/faces/tv_doge.png' }, ee: {}, updated_at: new Date().toISOString() };

/* 期望值：按页面的 msgKind 口径独立重算
   （与 查看备份.html 的 msgKind('bili') 分支一一对应，改那边务必同步改这里） */
const isAuto = m => {
  const s = m.msg_source | 0, mt = m.media_type;
  return (s >= 8 && s <= 11) || s === 17 || mt === 16;
};
// 撤回提示（5）与官方通知（10：开播 / 视频上线 / 预约成功）都归「系统通知与撤回提示」
const isSys = m => [5, 10, 18].includes(m.media_type);
const isGift = m => {
  if (isAuto(m) || isSys(m)) return false;
  const mt = m.media_type;
  if (mt === 13) return true;
  if (mt >= 301 && mt <= 306) return true;
  if (m.from !== 'me' && m.from !== 'peer') return true;
  return false;
};
const expAuto = msgs.filter(isAuto).length;
const expSys = msgs.filter(isSys).length;
const expGift = msgs.filter(isGift).length;
const expMe = msgs.filter(m => m.from === 'me' && !isAuto(m) && !isSys(m) && !isGift(m)).length;
const expPeer = msgs.filter(m => m.from === 'peer' && !isAuto(m) && !isSys(m) && !isGift(m)).length;
const expMonths = new Set(msgs.map(m => {
  // ⚠ 换日口径（2026-09-18 起）：一天 = 当天 05:00 → 次日 05:00，月份按逻辑月分组
  const d = new Date(m.ts - 5 * 3600 * 1000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
})).size;

console.log('仿真数据：' + msgs.length + ' 条（' + expMonths + ' 个月）');
console.log('  期望 → 我 ' + expMe + ' / 对方 ' + expPeer + '；排除 auto ' + expAuto +
  ' / 系统通知+撤回 ' + expSys + ' / 其它非双方 ' + expGift);

/* ============================ 载入页面 ============================ */
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { const m = e.message || ''; if (!/Not implemented|Could not load/.test(m)) errors.push(m); });
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 200)));

const rawHtml = fs.readFileSync(DIR + '/查看备份.html', 'utf8');
const pageHtml = rawHtml.replace(STUB_RE, '');
const stubbedN = (rawHtml.match(STUB_RE) || []).length;

const dom = new JSDOM(pageHtml, {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  url: 'file:///' + DIR + '/查看备份.html',
  virtualConsole: vc,
  beforeParse(win) {
    win.DM_DATA_B = FAKE;
    win.DM_FACES_B = FAKE_FACES;
    win.DM_OCR_B = { _meta: { count: 0 } };
    win.DM_VLM_B = { _meta: { count: 0 } };
  },
});
const W = dom.window, doc = W.document;
await new Promise(res => { W.addEventListener('load', res); setTimeout(res, 10000); });
await sleep(900);

const q = s => doc.querySelectorAll(s).length;
const swBtn = k => doc.querySelector('#srcSw button[data-src="' + k + '"]');

console.log('\n=== A. 顶部切换条 ===');
// 守卫：一旦页面改了 script 写法导致上面正则匹配不到，本脚本会悄悄退回真实数据，
// 断言又会集体飘红 —— 先在这里明确失败，提示去改 STUB_RE。
chk(stubbedN === 4, '已剔掉 4 个 B站真实数据 script 标签（本脚本跑仿真数据）', '实际 ' + stubbedN + ' 个');
chk(errors.length === 0, '页面无 JS 报错', errors.slice(0, 2).join(' | ') || '无');
chk(!!doc.getElementById('srcSw'), '存在顶部切换容器 #srcSw');
chk(q('#srcSw button[data-src]') === 2, '有微博 / B站 两个按钮', q('#srcSw button[data-src]') + ' 个');
chk(!!swBtn('weibo') && !!swBtn('bili'), '两个按钮都带 data-src 标识');
chk(!!W.SOURCES && !!W.SOURCES.bili.data, 'B站数据已被页面识别',
  'SOURCES.bili.data.messages = ' + (W.SOURCES.bili.data ? W.SOURCES.bili.data.messages.length : 'null'));
chk(!swBtn('bili').hasAttribute('data-empty'), 'B站按钮不是「空数据」状态');
const badge = swBtn('bili').querySelector('.n');
chk(!!badge && badge.textContent === msgs.length.toLocaleString(), 'B站按钮显示条数徽章',
  badge ? badge.textContent + ' vs ' + msgs.length.toLocaleString() : '无徽章');
chk(!swBtn('bili').hasAttribute('disabled'), 'B站按钮可点（不是灰的）');

console.log('\n=== B. 默认视图 + 切到 B站 ===');
chk(W.CUR_SRC === 'weibo', '默认显示微博', 'CUR_SRC=' + W.CUR_SRC);
const weiboMsgs = W.DM_DATA.messages.length;
chk(q('.msg') > 0, '微博视图已渲染', q('.msg') + ' 条');
chk(swBtn('weibo').getAttribute('aria-pressed') === 'true', '微博按钮为选中态');

swBtn('bili').click();
await sleep(1200);
chk(W.CUR_SRC === 'bili', '点击后切到 B站', 'CUR_SRC=' + W.CUR_SRC);
chk(swBtn('bili').getAttribute('aria-pressed') === 'true' && swBtn('weibo').getAttribute('aria-pressed') === 'false',
  '选中态已移到 B站按钮');
chk(q('.msg') > 0, 'B站视图渲染出消息', q('.msg') + ' 条');
chk(q('#months .mo[data-m]') === expMonths, 'B站时间轴月份数正确',
  q('#months .mo[data-m]') + ' vs ' + expMonths);
const bMsgs = W.SOURCES.bili.data.messages.length;
chk(bMsgs === msgs.length, '渲染用的是 B站数据集而非微博', bMsgs + ' vs ' + msgs.length);

console.log('\n=== C. B站卡片渲染 ===');
{
  const cards = [...doc.querySelectorAll('.wcard')];
  const bCards = [...doc.querySelectorAll('.wcard.bc')];
  chk(cards.length > 0, 'B站视图里有卡片', cards.length + ' 张');
  chk(bCards.length === cards.length && cards.length > 0,
    '卡片全部带 B站专属样式 .bc', bCards.length + '/' + cards.length);
  // 找一条分享视频卡片，检查标题与链接
  const qEl = doc.getElementById('q');
  qEl.value = '翻唱';
  qEl.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(1500);
  const hitCard = [...doc.querySelectorAll('.wcard.bc')].find(c => /夜に駆ける/.test(c.textContent));
  chk(!!hitCard, '搜索能命中 B站分享卡片', hitCard ? '已渲染' : '未找到');
  if (hitCard) {
    const hasBvLink = /BV1xx411c7mD/.test(hitCard.parentNode.innerHTML);
    chk(hasBvLink, '卡片链接指向 BV 号', hasBvLink ? 'BV1xx411c7mD' : '未找到');
    const btn = hitCard.querySelector('.wcard-btn') || hitCard.closest('.bubble').querySelector('.wcard-btn');
    chk(!!btn, 'B站卡片同样有「展开详情」按钮', btn ? btn.textContent : '无');
    if (btn) {
      const before = q('.bubble.has-card.open');
      btn.click(); await sleep(300);
      chk(q('.bubble.has-card.open') > before, 'B站卡片可展开', '展开 ' + q('.bubble.has-card.open') + ' 个');
      const btn2 = hitCard.querySelector('.wcard-btn') || hitCard.closest('.bubble').querySelector('.wcard-btn');
      btn2.click(); await sleep(200);
    }
  }
  doc.getElementById('qclr').click();
  await sleep(800);
}

console.log('\n=== D. B站自动回复：按 msg_source 结构化判定 ===');
{
  const chip = doc.getElementById('autoChip');
  chk(!!chip, '存在「自动回复」按钮', chip.textContent);
  chip.click();
  await sleep(1000);
  const found = doc.getElementById('found').textContent;
  chk(/已隐藏/.test(chip.textContent), '按钮状态已切换', chip.textContent);
  chk(new RegExp(expAuto.toLocaleString() + '\\s*条').test(found) || found.includes(String(expAuto)),
    '隐藏条数与 msg_source 口径一致', '期望 ' + expAuto + ' 条 → 界面「' + found.slice(0, 60) + '」');
  chip.click();
  await sleep(1000);
}

console.log('\n=== E. 统计面板：B站口径 ===');
{
  doc.getElementById('statBtn').click();
  await sleep(900);
  chk(doc.getElementById('stat').classList.contains('on'), '统计面板已打开');
  const txt = doc.getElementById('stat').textContent;
  chk(/bili\/messages\.js/.test(txt), '口径说明指向 B站数据文件',
    (/bili\/messages\.js|data\/messages\.js/.exec(txt) || [''])[0]);
  chk(/msg_source/.test(txt), '口径说明用的是 B站结构化字段 msg_source');
  // 用「标签 → 条数」精确取值：早先写成 txt.includes(n)，几个桶数字相同时会互相顶替着
  // 通过（实测 expGift / expSys 都曾是 3），等于没验证。
  const flat = txt.replace(/\s+/g, ' ');
  const grab = (label) => {
    const m = new RegExp(label + '[^0-9]{0,12}?([\\d,]+)\\s*条').exec(flat);
    return m ? Number(m[1].replace(/,/g, '')) : -1;
  };
  chk(/自动回复 \/ 自动消息/.test(flat) && /系统通知与撤回提示/.test(flat), '排除项 B站文案齐全');
  const gAuto = grab('自动回复 / 自动消息'), gSys = grab('系统通知与撤回提示'), gGift = grab('其它非双方消息');
  chk(gAuto === expAuto, '面板自动回复条数 = 独立重算', gAuto + ' / ' + expAuto);
  chk(gSys === expSys, '面板系统通知+撤回条数 = 独立重算', gSys + ' / ' + expSys);
  chk(expGift === 0 ? gGift === -1 : gGift === expGift,
    '面板「其它非双方消息」条数 = 独立重算（0 条时不渲染该行）', gGift + ' / ' + expGift);
  // KPI 独立重算
  const kpi = txt.replace(/\s+/g, ' ');
  chk(kpi.includes(expMe.toLocaleString()), '「我发出」KPI 与重算一致', '期望 ' + expMe);
  chk(kpi.includes(expPeer.toLocaleString()), '「对方回复」KPI 与重算一致', '期望 ' + expPeer);
  doc.getElementById('statClose').click();
  await sleep(500);
}

console.log('\n=== F. B站表情（字典键不带括号）===');
{
  const qEl = doc.getElementById('q');
  qEl.value = 'tv_doge';
  qEl.dispatchEvent(new W.Event('input', { bubbles: true }));
  await sleep(1500);
  const faces = [...doc.querySelectorAll('img.face')].map(i => i.getAttribute('src'));
  chk(faces.length > 0, 'B站表情渲染成图片', faces.length + ' 个');
  chk(faces.every(s => s.startsWith('bili/faces/')), '图片路径指向 bili/faces/', faces[0] || '无');
  doc.getElementById('qclr').click();
  await sleep(800);
}

console.log('\n=== G. 切回微博 + 反复切换无副作用 ===');
{
  swBtn('weibo').click();
  await sleep(1200);
  chk(W.CUR_SRC === 'weibo', '切回微博', 'CUR_SRC=' + W.CUR_SRC);
  chk(W.DM_DATA.messages.length === weiboMsgs, '微博数据未被污染',
    W.DM_DATA.messages.length + ' vs ' + weiboMsgs);
  chk([...doc.querySelectorAll('#chat .day')].length > 0, '聊天区重新渲染');

  // 来回切 5 轮
  let boundFirst = null;
  for (let i = 0; i < 5; i++) {
    swBtn('bili').click(); await sleep(700);
    if (boundFirst === null) boundFirst = W.boot._bound.length;
    swBtn('weibo').click(); await sleep(700);
  }
  chk(W.CUR_SRC === 'weibo', '5 轮切换后停留在微博', 'CUR_SRC=' + W.CUR_SRC);
  chk(W.boot._bound.length === boundFirst, '全局监听数量不随切换增长',
    '首轮 ' + boundFirst + ' → 现在 ' + W.boot._bound.length);
  chk(q('#chat') === 1 && q('.layout') === 1, 'DOM 没有被重复插入', '#chat=' + q('#chat') + ' .layout=' + q('.layout'));
  const badges = [...doc.querySelectorAll('#srcSw button .n')];
  chk(badges.length <= 2, '切换条上的条数徽章没有堆叠', badges.length + ' 个（最多 2）');
  chk(badges.length === 2, '两个按钮各有且只有 1 个徽章',
    JSON.stringify(badges.map(b => b.textContent)));

  // 切换后统计面板仍能正确打开
  doc.getElementById('statBtn').click();
  await sleep(800);
  chk(doc.getElementById('stat').classList.contains('on'), '反复切换后统计面板仍可用');
  doc.getElementById('statClose').click();
}

console.log('\n========================================');
console.log('通过 ' + pass.length + ' 项，失败 ' + fail.length + ' 项');
if (fail.length) { console.log('失败项:'); fail.forEach(f => console.log('  - ' + f)); }
try { dom.window.close(); } catch {}
process.exit(fail.length ? 1 : 0);
