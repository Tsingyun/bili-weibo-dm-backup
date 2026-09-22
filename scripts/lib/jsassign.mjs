/**
 * 「全局变量注入 JS」统一出口
 * ===============================================================
 * 项目里有一类文件永远长这样：`window.DM_XXX = <JSON>;`，
 * 由查看备份页用 <script src> 直接加载。
 *
 * ⚠ JSON 里只要有一条消息的文本含 `</script>`（对方完全可控），
 *   且生成时没把 `<` 转义掉，这段 HTML 就会在**下一台机器**的查看页上执行 ——
 *   这类问题历史上有 6 处写点，漏掉任意一处就是洞（2026-09 审计的 H3）。
 *
 * 所以规则是：**所有**这类写点都必须走这一个函数，不允许手写
 * `window.X = ${json}` 模板 —— `<` → `\u003c` 的转义只在这里发生一次。
 */

/**
 * 生成一行 `window.<global> = <json>;`（含换行）。
 * @param {string} g    全局变量名，如 `DM_DATA_WEIBO`（只允许字母数字下划线）
 * @param {string} json JSON.stringify 的产物（或其他已序列化文本）
 */
export function jsAssign(g, json) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(g))) {
    throw new Error('jsAssign: 全局变量名不合法：' + g);
  }
  return `window.${g} = ${String(json).replace(/</g, '\\u003c')};\n`;
}
