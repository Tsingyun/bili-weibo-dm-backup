/**
 * 验证「高清截图.cmd」背后那条链路：server.mjs --open /viewer
 * ------------------------------------------------------------------
 * 启动器是 .cmd（沙箱里跑不了），所以把它的核心拆出来单独证明：
 *   ① --open /viewer 会被解析成 http://127.0.0.1:<port>/viewer（读真实 stdout）
 *   ② 该地址真能取到查看页（200 + 页面里确实有截图导出的入口）
 *   ③ 查看页要用的数据与图片也走同一条静态出口（否则页面打开也是残的）
 *   ④ 敏感文件仍然被挡住（cookie_header.txt 取不到）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const PORT = 18891;

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (e ? '  → ' + e : '')); } };

const child = spawn(NODE, [path.join(ROOT, 'scripts', 'server.mjs'), '--port', String(PORT), '--open', '/viewer'],
  { cwd: ROOT, env: { ...process.env, DM_WEBUI_PORT: String(PORT) } });
let out = '';
child.stdout.on('data', d => { out += d.toString('utf8'); });
child.stderr.on('data', d => { out += d.toString('utf8'); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 等服务真正起来（最多 15s）
let up = false;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(1200) });
    if (r.ok) { up = true; break; }
  } catch {}
}
ok('服务起来了', up);
console.log('  （服务端输出：' + out.replace(/\s+/g, ' ').trim().slice(0, 200) + '）');

const expectUrl = `http://127.0.0.1:${PORT}/viewer`;
ok('--open /viewer 被解析成 ' + expectUrl, out.includes(expectUrl), out.replace(/\s+/g, ' ').slice(0, 300));

const r1 = await fetch(expectUrl, { signal: AbortSignal.timeout(8000) });
const html = await r1.text();
ok('/viewer 返回 200', r1.status === 200, String(r1.status));
ok('/viewer 拿到的确实是查看页', /查看备份|DM_DATA|截图导出/.test(html) && html.length > 50000, html.length + ' 字节');
ok('查看页里有「截图导出」入口', /id="shotBtn"/.test(html));
ok('查看页里有高清截图的面板', /id="shotworks"|id="shotwrap"/.test(html));

// 静态出口：查看页要用的数据与图片
const r2 = await fetch(`http://127.0.0.1:${PORT}/data/messages.js`, { signal: AbortSignal.timeout(8000) });
ok('data/messages.js 能取到（页面有数据可看）', r2.status === 200, String(r2.status));
const img = fs.readdirSync(path.join(ROOT, 'data', 'images'))[0];
const r3 = await fetch(`http://127.0.0.1:${PORT}/data/images/${encodeURIComponent(img)}`, { signal: AbortSignal.timeout(8000) });
ok('data/images 能取到（画布才能合成图片）', r3.status === 200, String(r3.status));

// 敏感文件必须仍然被挡
for (const p of ['/data/cookie_header.txt', '/data/glm_key.txt', '/sessions.json']) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(8000) });
  ok('敏感文件被挡住：' + p, r.status === 403 || r.status === 404, String(r.status));
}

child.kill();
await sleep(300);
console.log('\n启动器链路：通过 ' + pass + ' · 失败 ' + fail + ' · 合计 ' + (pass + fail));
process.exit(fail ? 1 : 0);
