/* 一次性小工具：把 使用说明.md 里要写的统计数字现算出来（改口径后必须重算）。
   口径与查看页完全一致：换日 = 每天 05:00；排除 auto/gift/sys；只数 me/peer。
   用法：node scripts/_explore/_calc_doc_numbers.mjs */
import fs from 'node:fs';
import { msgKind, localDay, dayStart } from '../msg_kind.mjs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const WEIBO_AUTO = (() => { try { const s = JSON.parse(fs.readFileSync(R + '/sessions.json', 'utf8')); return ((s.sessions || []).find(x => x.key === 'weibo') || {}).autoReply || ''; } catch { return ''; } })(); // 自动回复文案取自 sessions.json（属个人内容，不写进代码）

for (const [key, file, autoReply, platform] of [
  ['weibo', 'data/messages.json', WEIBO_AUTO, 'weibo'],
  ['bili', 'bili/messages.json', '', 'bili'],
]) {
  const M = JSON.parse(fs.readFileSync(R + '/' + file, 'utf8'));
  const withTs = M.filter((m) => m.ts);
  const day = {};
  const excl = { auto: 0, autoMe: 0, autoPeer: 0, gift: 0, giftMe: 0, giftPeer: 0, sys: 0, sysMe: 0, sysPeer: 0 };
  let me = 0, peer = 0, pre5 = 0, peak = 0, peakDay = '';
  for (const m of withTs) {
    if (new Date(m.ts).getHours() < 5) pre5++;
    const k = msgKind(m, { platform, autoReply });
    if (k !== 'count') {
      excl[k]++;
      if (k === 'auto') { if (m.from === 'me') excl.autoMe++; else excl.autoPeer++; }
      if (k === 'gift') { if (m.from === 'me') excl.giftMe++; else excl.giftPeer++; }
      if (k === 'sys') { if (m.from === 'me') excl.sysMe++; else excl.sysPeer++; }
      continue;
    }
    if (m.from !== 'me' && m.from !== 'peer') continue;
    const d = localDay(m.ts);
    if (!day[d]) day[d] = { me: 0, peer: 0 };
    day[d][m.from]++;
    if (m.from === 'me') { me++; if (day[d].me > peak) { peak = day[d].me; peakDay = d; } } else peer++;
  }
  const lo = Math.min.apply(null, withTs.map((m) => m.ts));
  const hi = Math.max.apply(null, withTs.map((m) => m.ts));
  let span = 0, both = 0, zero = 0;
  for (let t = dayStart(localDay(lo)); t <= dayStart(localDay(hi)); t += 86400000) {
    span++;
    const v = day[localDay(t)] || { me: 0, peer: 0 };
    if (v.me && v.peer) both++;
    if (!v.me && !v.peer) zero++;
  }
  console.log('== ' + key + ' ==');
  console.log('  总 ' + M.length + ' 条 / 有 ts ' + withTs.length);
  console.log('  我 ' + me + '  对方 ' + peer +
    '   日均我 ' + (me / span).toFixed(1) + ' / 对方 ' + (peer / span).toFixed(1));
  console.log('  有来有回 ' + both + ' / ' + span + ' 天   无消息 ' + zero + ' 天   单日峰值(我) ' + peak + ' 条 @ ' + peakDay);
  console.log('  05:00 分界影响 ' + pre5 + ' 条，占全部 ' + (pre5 / withTs.length * 100).toFixed(1) + '%');
  console.log('  排除：auto ' + excl.auto + '(对方' + excl.autoPeer + '/我' + excl.autoMe + ')  gift ' +
    excl.gift + '(对方' + excl.giftPeer + '/我' + excl.giftMe + ')  sys ' + excl.sys + '(我' + excl.sysMe + '/对方' + excl.sysPeer + ')');
  console.log('  区间 ' + localDay(lo) + ' ~ ' + localDay(hi));
}
