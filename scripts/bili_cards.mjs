#!/usr/bin/env node
/**
 * B站用户名片解析 · 纯函数（便于单测）
 * ---------------------------------------------------------------
 * 背景（2026-09-15 真实 bug）：
 *   接口 https://api.vc.bilibili.com/account/v1/user/cards?uids=<mid>
 *   返回的 data 是 **数组**：
 *     {"code":0,"data":[{"mid":1234567,"name":"对方昵称","face":"https://..."}]}
 *   而 bili_update.mjs 早期写法是 cards.data[PEER_MID]（按对象取键），
 *   数组上取数字键必然 undefined → 对方昵称永远走兜底、头像永远为空，
 *   而且日志里仍会打出兜底名字，把问题藏住了，很难发现。
 *   历史上还存在过「以 mid 为键的对象」这种返回形态，两种都要兼容。
 */

/**
 * 从 cards 接口的 data 字段里挑出目标 mid 的名片。
 * @param {any} data  cards.data（可能是数组、对象、null）
 * @param {string|number} mid 目标用户 mid
 * @returns {{mid:any,name?:string,face?:string,avatar?:string,sign?:string}|null}
 */
export function pickCard(data, mid) {
  if (!data) return null;
  const key = String(mid);
  if (Array.isArray(data)) {
    return data.find((x) => x && String(x.mid) === key) || null;
  }
  if (typeof data === 'object') {
    const hit = data[mid] || data[key];
    if (hit) return hit;
    // 兜底：对象包数组 / 对象里塞了其它键
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) {
        const f = v.find((x) => x && String(x.mid) === key);
        if (f) return f;
      }
    }
  }
  return null;
}

/** 把名片里的昵称/头像取出来（头像字段历史上叫 face，也见过 avatar）。 */
export function cardNameFace(card, fallbackName) {
  return {
    name: (card && card.name) || fallbackName || '',
    avatar: (card && (card.face || card.avatar)) || '',
  };
}
