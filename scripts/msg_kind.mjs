/* ============================================================
   消息分类口径（命令行侧）—— 导出 JSONL / 建全文索引都用这一份
   ============================================================
   ⚠️ 这是「同一份业务逻辑的第二处实现」，第一处在 查看备份.html 的 msgKind()：
        查看备份.html  function msgKind(m){ ... }   // 页面渲染 + KPI 分桶用它
        scripts/msg_kind.mjs   msgKind()            // 命令行导出 / 索引用它
      改任意一边都必须同步另一边。另外 scripts/_explore/verify_bili.mjs 里还有
      第三份（isAuto/isSys/isGift），改分类口径时要一起看。

   为什么要抽出来：页面的 msgKind 依赖 SRC.key / AUTO_REPLY / RE_GIFT / RE_SYSTIP
   这些页内变量，命令行拿不到。这里改成「把 platform + autoReply 当参数传进来」，
   判定规则与页面逐条对齐。

   口径速记（2026-09-15 全量实测）：
     B站 msg_type（数据里字段名叫 media_type）实测只出现 1/2/5/6/7/10/14，
     13 / 16 / 18 / 301~306 是防御性保留（本会话永假）。
     auto ← msg_source 8~11 / 17，或 media_type 16
     sys  ← media_type 5（撤回）/ 10（官方通知：开播·视频上线·预约成功）/ 18
     gift ← media_type 13 / 301~306，或发送者既不是 me 也不是 peer
     其余（含分享卡片 7 / 14）→ count，算真实发言，与微博口径一致
   微博靠文案匹配：文本等于 autoReply → auto；助威/红包系统通知 → gift；
     「(你|对方)撤回了一条消息」→ sys；其余 → count
   ============================================================ */

/** 微博：助威/红包系统通知（与页面 RE_GIFT 逐字一致；不带 g 标志，避免 lastIndex 状态） */
export const RE_GIFT = /^感谢您的助威支持|助威权益还有\d+天|^发出红包消息/;
/** 微博：撤回提示（与页面 RE_SYSTIP 逐字一致） */
export const RE_SYSTIP = /^(?:你|对方)撤回了一条消息$/;

/**
 * 一条消息属于哪一类。
 * @param {object} m 消息对象
 * @param {{platform?:string, autoReply?:string}} [opt]
 *        platform: 'bili' 走结构化判定；其它（含缺省）走微博文案判定
 *        autoReply: 微博的自动回复固定文案（sessions.json 的 autoReply 字段）
 * @returns {'auto'|'sys'|'gift'|'count'} count = 算作真实发言
 */
export function msgKind(m, opt = {}) {
  if (!m || typeof m !== 'object') return 'count';
  const platform = opt.platform;
  const autoReply = opt.autoReply || '';

  if (platform === 'bili') {
    const s = m.msg_source | 0;
    const mt = m.media_type;
    if ((s >= 8 && s <= 11) || s === 17) return 'auto'; // 关注后 / 收到消息 / 关键词 / 大航海 / 互关
    if (mt === 16) return 'auto';                        // 关注后的自动推送
    if (mt === 5 || mt === 10 || mt === 18) return 'sys'; // 撤回提示 + 官方通知
    if (mt === 13) return 'gift';
    if (mt >= 301 && mt <= 306) return 'gift';            // 粉丝团 / 大航海提示
    if (m.from !== 'me' && m.from !== 'peer') return 'gift';
    return 'count';
  }

  const t = (m.text || '').trim();
  if (autoReply && t === autoReply) return 'auto';
  if (RE_GIFT.test(t)) return 'gift';
  if (RE_SYSTIP.test(t)) return 'sys';
  return 'count';
}

/* ------------------------------------------------------------
   敏感信息打码规则 —— 与 查看备份.html 的 MASK_RULES 逐条对应。
   页面那份用 var 写成对象数组，这里用同样的正则。
   注意正则带 g 标志，replace 前要用 new RegExp 或重置 lastIndex；
   这里统一做成「每次调用新建 RegExp」，避免跨条复用时 lastIndex 残留。
   ------------------------------------------------------------ */
export const MASK_RULES = [
  // 纯数字的三条必须带数字边界 (?<!\d) / (?!\d)，否则互相踩：
  //   \d{17}[\dXx] 会从 19 位银行卡里咬走 18 位；1[3-9]\d{9} 会从身份证中间咬走 11 位。
  { k: '手机号', src: '(?<!\\d)1[3-9]\\d{9}(?!\\d)', flags: 'g', to: '[手机号已打码]' },
  { k: '邮箱', src: '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}', flags: 'g', to: '[邮箱已打码]' },
  { k: '身份证', src: '(?<!\\d)\\d{17}[\\dXx](?!\\d)', flags: 'g', to: '[身份证已打码]' },
  // 银行卡取「16 位以上」而不是 16~19：位数上限卡死会让 20 位以上的长数字串
  // 一个规则都不命中（边界要求独立成串，超长串连 16 位都切不出来）→ 反而漏掉不打码。
  { k: '银行卡', src: '(?<!\\d)\\d{16,}(?!\\d)', flags: 'g', to: '[银行卡已打码]' },
  { k: '账号', src: '(?:QQ|qq|微信|vx|VX|Vx|v信|wechat|WeChat)\\s*[:：]?\\s*[A-Za-z0-9_\\-]{5,20}', flags: 'g', to: '[账号已打码]' },
  { k: '收货地址', src: '[\\u4e00-\\u9fa5]{2,8}(?:省|市)[\\u4e00-\\u9fa5]{1,8}(?:区|县|市)[\\u4e00-\\u9fa5]{1,12}(?:路|街|道|巷|小区|大厦|楼)[0-9A-Za-z\\-]{0,10}号?', flags: 'g', to: '[地址已打码]' },
];

/** 对一段文本打码；hits 传入对象则累计命中次数 */
export function maskText(s, hits) {
  let out = String(s == null ? '' : s);
  for (const r of MASK_RULES) {
    const re = new RegExp(r.src, r.flags);
    out = out.replace(re, () => {
      if (hits) hits[r.k] = (hits[r.k] || 0) + 1;
      return r.to;
    });
  }
  return out;
}

/** 换日时刻：凌晨 5 点 */
export const DAY_CUT_MS = 5 * 60 * 60 * 1000;
/** 逻辑日 YYYY-MM-DD → 该日真正开始的时刻（当天 05:00） */
export function dayStart(day) {
  const p = String(day).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2], 5, 0, 0, 0).getTime();
}
/** 逻辑日 YYYY-MM-DD → 该日的上界（次日 05:00 前的一毫秒） */
export function dayEnd(day) { return dayStart(day) + 24 * 3600 * 1000 - 1; }

/** 机器时区下的 YYYY-MM-DD。
 *  ⚠ 一天的分界是 **凌晨 05:00**，不是 00:00：先减 5 小时再取日期，
 *  所以 00:00~05:00 的消息会落到**前一天**。这个口径必须与查看页
 *  `查看备份.html` 的 `DAY_CUT` 以及 `build_fts.mjs` 的 `dayOf` 完全一致
 *  —— 三处任何一处漏改，都会出现「页面说 9/15、索引说 9/16」这种自相矛盾。
 *  （实测：微博 33.75% / B站 51.68% 的消息落在这一段，不改会把深夜聊天劈成两天。） */
export function localDay(ts) {
  const d = new Date(ts - DAY_CUT_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 机器时区下的 YYYY-MM-DD HH:MM:SS */
export function localTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
