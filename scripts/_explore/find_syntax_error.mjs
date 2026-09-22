#!/usr/bin/env node
/**
 * 从查看备份.html 里抽出所有内联 <script>，逐个做语法检查。
 * 定位「Uncaught SyntaxError: Invalid or unexpected token」到底在哪一行。
 *
 * 用法：node scripts/_explore/find_syntax_error.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FILE = path.join(ROOT, '查看备份.html');
const html = fs.readFileSync(FILE, 'utf8');
const lines = html.split('\n');

// 找出每个非 src 的 <script>...</script>
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m, n = 0, bad = 0;
const codes = [];
while ((m = re.exec(html))) {
  const attrs = m[1] || '';
  if (/\bsrc\s*=/i.test(attrs)) continue;
  n++;
  const code = m[2];
  codes.push(code);
  const startLine = html.slice(0, m.index).split('\n').length;   // 代码首行在 HTML 里的行号
  try {
    new vm.Script(code, { filename: 'block' + n });
    console.log(`内联脚本 #${n}（HTML 第 ${startLine + 1} 行起，${code.split('\n').length} 行）语法 OK`);
  } catch (e) {
    bad++;
    console.log(`\n❌ 内联脚本 #${n}（HTML 第 ${startLine + 1} 行起）语法错误：`);
    console.log('   ' + e.message);
    // e.stack 里会带 :行号
    const lm = /block\d+:(\d+)/.exec(e.stack || '');
    if (lm) {
      const ln = Number(lm[1]);                 // 相对该脚本块的行号
      const htmlLn = startLine + ln;
      console.log(`   → HTML 第 ${htmlLn} 行：`);
      for (let i = Math.max(1, htmlLn - 4); i <= Math.min(lines.length, htmlLn + 4); i++) {
        console.log(`   ${i === htmlLn ? '>>' : '  '} ${i}: ${lines[i - 1]}`);
      }
    }
  }
}
// 根因检查：如果某个脚本块里（含注释/字符串）出现了完整的结束标签，
// HTML 解析器会提前切断它 —— 表现就是「开标签数 > 能完整解析出的块数」。
// 这里把每个开标签的位置打印出来，方便一眼看出多出来/少掉的是哪一个。
const openRe = /<script\b(?![^>]*\bsrc\s*=)/gi;
const opens = [];
let om;
while ((om = openRe.exec(html))) {
  opens.push({
    line: html.slice(0, om.index).split('\n').length,
    text: html.slice(om.index, om.index + 56).replace(/\s+/g, ' '),
  });
}
// 已提取出来的脚本内容里出现的 <script 字样（注释里常见）不算真标签，
// 否则会误报「多出标签」—— 浏览器看到的脚本元素里不会再嵌脚本元素。
let inner = 0;
for (const c of codes) inner += (c.match(/<script\b/gi) || []).length;
const real = opens.length - inner;
console.log(`\n带内容的 script 开标签 ${opens.length} 个（其中 ${inner} 个只是脚本注释里的字样），` +
            `真实脚本元素 ${real} 个，完整解析出 ${n} 块`);
for (const o of opens) console.log(`   第 ${o.line} 行：${o.text}`);
if (real !== n) {
  bad++;
  console.log('❌ 有脚本块被提前截断：里面（含注释）出现了完整的结束标签，拆开写。');
}
console.log(`共 ${n} 个内联脚本，语法错误 ${bad} 个`);
process.exit(bad ? 1 : 0);
