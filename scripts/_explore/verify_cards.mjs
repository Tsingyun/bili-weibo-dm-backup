/**
 * B站用户名片解析 · 回归测试（纯函数级，不联网）
 * ===========================================================================
 * 背景（2026-09-15 真实 bug）：
 *   接口 api.vc.bilibili.com/account/v1/user/cards?uids=<mid> 的 data 是 **数组**：
 *     {"code":0,"data":[{"mid":1234567,"name":"示例UP主","face":"https://...jpg"}]}
 *   而 bili_update.mjs 早期写的是 cards.data[PEER_MID]（按对象取键），
 *   数组上取数字键必然 undefined → 聊天对象昵称永远走兜底 '示例UP主'、
 *   头像永远为空（meta.json 里 peer_avatar / peer_avatar_local 都是 ""）。
 *   因为兜底名字正好也是「示例UP主」，日志里看不出异常，这个 bug 藏了很久。
 *
 * 本脚本用**真实抓到的返回体**锁死解析逻辑：
 *   1. 真实数组形态必须解析出来（这是原来失败的那条）
 *   2. 兼容「以 mid 为键的对象」历史形态
 *   3. 兼容 mid 为数字 / 字符串
 *   4. 多用户数组里挑对目标
 *   5. 空 / 异常输入不抛错、返回 null
 *   6. 头像字段 face 与 avatar 都能取
 *
 * 跑法： node scripts/_explore/verify_cards.mjs
 * 退出码 0 = 全过，1 = 有失败
 */
import { pickCard, cardNameFace } from '../bili_cards.mjs';

const pass = [], fail = [];
const chk = (ok, label, extra) => {
  (ok ? pass : fail).push(label + (extra ? '  → ' + extra : ''));
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (extra ? '  → ' + extra : ''));
};

const MID = '1234567';
const FACE = 'https://i0.hdslb.com/bfs/face/1c12188cc2d29df877d162efd0cfe5589341f320.jpg';

// —— 1) 线上真实返回体（原文照抄，2026-09-15 实测） ——
const REAL = { code: 0, message: 'OK', ttl: 1, data: [{ mid: 1234567, name: '示例UP主', face: FACE, sign: '示例签名', rank: 10000, level: 6, silence: 0 }] };
console.log('\n[1] 线上真实返回体（数组形态）');
{
  const c = pickCard(REAL.data, MID);
  chk(!!c, '能解析出名片（旧代码在这里返回 undefined）');
  const nf = cardNameFace(c, '兜底名');
  chk(nf.name === '示例UP主', '昵称 = 示例UP主', nf.name);
  chk(nf.avatar === FACE, '头像 = 真实 face 地址', nf.avatar ? '已取到' : '空');
  // 旧写法复现：确认这条断言真的能抓到 bug
  chk(REAL.data[MID] === undefined, '对照：旧写法 data[mid] 确实是 undefined（证明测试有效）');
}

// —— 2) 历史对象形态 ——
console.log('\n[2] 兼容历史「以 mid 为键的对象」形态');
{
  const objShape = { [MID]: { mid: MID, name: '示例UP主', face: FACE } };
  const c = pickCard(objShape, MID);
  chk(!!c && cardNameFace(c, '').name === '示例UP主', '对象形态可解析');
  const numericKey = { [Number(MID)]: { mid: Number(MID), name: '示例UP主' } };
  chk(!!pickCard(numericKey, MID), '数字键对象也可解析');
}

// —— 3) mid 数字 / 字符串双向兼容 ——
console.log('\n[3] mid 数字 / 字符串双向兼容');
{
  chk(!!pickCard(REAL.data, 1234567), '传数字 mid 能找到');
  chk(!!pickCard(REAL.data, MID), '传字符串 mid 能找到');
}

// —— 4) 多用户数组里挑对目标 ——
console.log('\n[4] 多用户数组挑对目标');
{
  const many = { data: [{ mid: 1, name: '路人甲', face: 'x' }, { mid: 1234567, name: '示例UP主', face: FACE }, { mid: 2, name: '路人乙' }] };
  const c = pickCard(many.data, MID);
  chk(!!c && c.name === '示例UP主', '挑出正确的那一个', c && c.name);
  chk(pickCard(many.data, 999) === null, '目标不在列表里 → null');
}

// —— 5) 空 / 异常输入不抛错 ——
console.log('\n[5] 空 / 异常输入');
{
  const cases = [[null, 'null'], [undefined, 'undefined'], [[], '空数组'], [{}, '空对象'], ['abc', '字符串'], [0, '0'], [{ data: null }, '嵌套 null']];
  let ok = true, detail = '';
  for (const [v, label] of cases) {
    try { const r = pickCard(v, MID); if (r !== null) { ok = false; detail = label + ' 返回了非 null'; } }
    catch (e) { ok = false; detail = label + ' 抛错：' + e.message; }
  }
  chk(ok, '7 种异常输入都返回 null 且不抛错', detail);
}

// —— 6) 头像字段名兼容 ——
console.log('\n[6] 头像字段 face / avatar 兼容');
{
  chk(cardNameFace({ name: 'A', face: 'F' }, '兜底').avatar === 'F', 'face 字段');
  chk(cardNameFace({ name: 'A', avatar: 'AV' }, '兜底').avatar === 'AV', 'avatar 字段');
  chk(cardNameFace({ face: 'F' }, '兜底').name === '兜底', '无 name 时用兜底');
  chk(cardNameFace(null, '兜底').name === '兜底' && cardNameFace(null, '兜底').avatar === '', 'null 名片安全');
}

// —— 7) 对象里包数组（防御性） ——
console.log('\n[7] 对象里包数组的意外形态');
{
  const weird = { list: [{ mid: 1234567, name: '示例UP主', face: FACE }] };
  const c = pickCard(weird, MID);
  chk(!!c && c.name === '示例UP主', '能兜住 arr/list 包装');
}

console.log('\n' + '─'.repeat(60));
console.log(`  通过 ${pass.length} · 失败 ${fail.length}`);
if (fail.length) { console.log('\n失败项：'); fail.forEach(f => console.log('  · ' + f)); }
process.exit(fail.length ? 1 : 0);
