/* 开发 / 测试脚本的依赖解析（playwright、jsdom 等）
   ------------------------------------------------------------
   本仓库**不把 node_modules 提交进版本库**，所以 scripts/_explore/ 下的
   这些脚本需要自己找依赖。这里按顺序尝试三个来源：

     1) 环境变量 PW_HOME（单个目录）/ NODE_PATH（按 path.delimiter 分隔）
     2) 本地指针文件 scripts/_explore/.pw-home —— 一行路径。
        不进版本库（见 .gitignore），只在你自己机器上生效
     3) 常规 node 解析 —— 在项目根执行 `npm i -D playwright jsdom` 即可

   这样脚本在开发机上可以零配置运行，别人 clone 之后也有标准做法，
   而不用假设任何特定 AI 宿主 / 运行时的安装位置。
*/
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const HERE = import.meta.dirname;

function candidateDirs() {
  const out = [];
  if (process.env.PW_HOME) out.push(process.env.PW_HOME);
  if (process.env.NODE_PATH) out.push(...process.env.NODE_PATH.split(path.delimiter));
  try {
    const v = fs.readFileSync(path.join(HERE, '.pw-home'), 'utf8').trim();
    if (v) out.push(v);
  } catch {}
  return [...new Set(out.filter(Boolean))];
}

/** 加载一个依赖；找不到时给出可照做的提示，而不是一句 MODULE_NOT_FOUND */
export function loadDep(name) {
  const tried = [];
  for (const dir of candidateDirs()) {
    // dir 可能是 node_modules 本身（NODE_PATH 的历史语义），也可能是它的父目录 → 两种都试
    for (const base of [dir, path.dirname(dir)]) {
      try {
        return createRequire(path.join(base, 'noop.js'))(name);
      } catch (e) {
        tried.push(`${base} → ${e.code || e.message}`);
      }
    }
  }
  try {
    return createRequire(import.meta.url)(name);
  } catch (e) {
    tried.push(`常规解析 → ${e.code || e.message}`);
  }
  throw new Error(
    `找不到依赖 "${name}"。三种办法任选其一：\n` +
    `  1) 在项目根目录执行：npm i -D ${name}\n` +
    `  2) 设环境变量 PW_HOME=<已装好 ${name} 的 node_modules 目录>\n` +
    `  3) 把该目录路径写进 scripts/_explore/.pw-home（一行，本地文件，不进版本库）\n` +
    (tried.length ? `\n已尝试：\n  - ${tried.join('\n  - ')}\n` : '')
  );
}
