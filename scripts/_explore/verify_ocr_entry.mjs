#!/usr/bin/env node
/**
 * 验证：独立的「识别图片文字」入口 + 定期 OCR 脚本
 * ==============================================================
 * 两条硬约束，这个套件就是来钉住它们的：
 *   ① 新入口必须**真能用**（真起服务、真发 HTTP、真跑完一个 job）；
 *   ② 现有「开始备份 / 增量 / 全量」链路**一个字都不许改**。
 *
 * ② 不能只靠"我没改"这种口头承诺：静态断言把前端那条 steps 数组
 * 原样读回来对一遍，再让 git diff 只有 + 行成为可复核的事实。
 *
 * 跑法：node scripts/_explore/verify_ocr_entry.mjs
 * ⚠ 会真的启动一次 `--steps ocr`（当前没新图时秒退，不抓消息、不联网）。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSessions } from '../sessions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const S = (n) => path.join(ROOT, 'scripts', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + String(extra).slice(0, 180) : '')); }
};
const head = (t) => console.log('\n' + t);

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

let BASE = '';
async function req(method, p, json, extraHeaders = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'X-DM-WebUI': '1', 'Content-Type': 'application/json', ...extraHeaders },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}
async function waitJob(id, maxMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await req('GET', '/api/job?id=' + encodeURIComponent(id));
    const j = r.json && r.json.job;
    if (j && j.status !== 'running' && j.status !== 'queued') return j;
    await sleep(200);
  }
  return null;
}

let child = null;
try {
  head('§1 现有流程没被改动（静态对账）');
  const appJs = fs.readFileSync(path.join(ROOT, 'webui', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'webui', 'index.html'), 'utf8');
  const line = (appJs.match(/steps:\s*noImg\s*\?[^\n]+/) || [''])[0];
  ok('「开始备份」仍传 fetch/faces/ocr/vlm/snapshot/doctor 全链路',
    /\['fetch', 'faces', 'ocr', 'vlm', 'snapshot', 'doctor'\]/.test(line), line);
  ok('「只抓文字」仍传 fetch/snapshot/doctor',
    /\['fetch', 'snapshot', 'doctor'\]/.test(line), line);
  ok('新按钮在 HTML 里且文案明确写 OCR', /id="btnOcrRun"[^>]*>[^<]*识别图片文字/.test(html));
  ok('新按钮有前端 handler', /\$\('#btnOcrRun'\)\.onclick/.test(appJs));
  ok('定期 OCR 脚本存在且带 BOM（Windows PowerShell 5.1 读中文不乱）',
    fs.existsSync(S('ocr_scheduled.ps1')) &&
    fs.readFileSync(S('ocr_scheduled.ps1'))[0] === 0xEF);
  ok('两个启动器存在且纯 ASCII',
    ['定期识别图片文字.cmd', '取消定期识别.cmd'].every((f) => {
      const p = path.join(ROOT, '命令', '图片与OCR', f);
      return fs.existsSync(p) && ![...fs.readFileSync(p)].some((b) => b > 127);
    }));
  /* OCR 写的是 ocr.json / ocr.js；「搜索备份」读的却是 search/dm_search.db。
     两条入口都必须顺手重建 FTS，否则界面上那句"能搜到新文字"就是空话。 */
  const serverJs = fs.readFileSync(S('server.mjs'), 'utf8');
  const sched = fs.readFileSync(S('ocr_scheduled.ps1'), 'utf8');
  ok('手动入口会在 OCR 之后排队重建搜索索引',
    /\['--disable-warning=ExperimentalWarning', S\('build_fts\.mjs'\)\]/.test(serverJs) &&
    /tag: 'ocr:fts'/.test(serverJs));
  ok('定期脚本也会重建搜索索引（且找不到 node 时只警告）',
    /build_fts\.mjs/.test(sched) && /\[warn\] 没找到 node\.exe/.test(sched));
  ok('卡片文案没有夸大：明确写了会自动重建索引',
    /识别完会自动重建搜索索引/.test(html));

  head('§2 起服务，真发 HTTP');
  const PORT = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  child = spawn(process.execPath, [S('server.mjs'), '--port', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { up = (await fetch(BASE + '/api/state')).ok; } catch { await sleep(200); }
  }
  ok('服务端起来了', up);
  if (!up) throw new Error('服务端没起来，后面的 HTTP 断言跳过');

  const list = loadSessions();
  const live = list.filter((s) => !s.imported);
  const imported = list.find((s) => s.imported);

  head('§3 GET /api/ocr/status（只读）');
  const st = await req('GET', '/api/ocr/status');
  ok('返回 200', st.status === 200, st.status);
  ok('结构含 ready / sessions / totalPending', !!st.json &&
    typeof st.json.ready === 'boolean' && Array.isArray(st.json.sessions) &&
    Number.isFinite(st.json.totalPending));
  ok('不含导入的只读会话', !!st.json &&
    st.json.sessions.every((s) => !s.key.includes('imported')) &&
    (!imported || !st.json.sessions.some((s) => s.key === imported.key)));
  ok('每个会话的数字自洽（images = done + pending）', !!st.json &&
    st.json.sessions.every((s) => s.images === s.done + s.pending));
  ok('totalPending == 各会话之各', !!st.json &&
    st.json.totalPending === st.json.sessions.reduce((n, s) => n + s.pending, 0));
  ok('本地 OCR 环境已就绪（上一轮装好了）', !!st.json && st.json.ready === true);

  head('§4 POST /api/ocr/run 的守卫');
  const noHdr = await fetch(BASE + '/api/ocr/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions: [live[0].key] }),
  });
  ok('不带 X-DM-WebUI 写请求仍被 CSRF 守卫挡掉（403）', noHdr.status === 403, noHdr.status);
  const badKey = await req('POST', '/api/ocr/run', { sessions: ['zz_not_a_session'] });
  ok('不认识的会话 → 400', badKey.status === 400, badKey.status);
  if (imported) {
    const ro = await req('POST', '/api/ocr/run', { sessions: [imported.key] });
    ok('导入的只读备份 → 400（OCR 不许写它）', ro.status === 400 &&
      /只读/.test((ro.json && ro.json.error) || ro.text), ro.status);
  } else {
    ok('（本机没有导入会话，跳过只读断言）', true);
  }

  head('§5 真跑一次：只跑 OCR + 重建索引，不抓取');
  const run = await req('POST', '/api/ocr/run', { sessions: [live[0].key] });
  ok('返回 200 且建了 2 个任务（1 识别 + 1 索引）',
    run.status === 200 && run.json && run.json.jobs.length === 2,
    run.status + ' ' + run.text.slice(0, 120));
  if (run.json && run.json.jobs.length === 2) {
    ok('链尾那个任务是搜索索引、且排在串行队列里',
      /重建搜索索引/.test(run.json.jobs[1].title) && run.json.jobs[1].queue === 'serial',
      JSON.stringify(run.json.jobs[1]));
    const j1 = await waitJob(run.json.jobs[0].id);
    ok('OCR 任务跑到终态且退出码 0', !!j1 && j1.status === 'done' && j1.code === 0,
      j1 && JSON.stringify({ status: j1.status, code: j1.code,
        tail: (j1.tail || []).slice(-8).join(' / ').slice(0, 400) }));
    const j2 = await waitJob(run.json.jobs[1].id);
    ok('索引重建任务也跑到终态且退出码 0', !!j2 && j2.status === 'done' && j2.code === 0,
      j2 && JSON.stringify({ status: j2.status, code: j2.code,
        tail: (j2.tail || []).slice(-8).join(' / ').slice(0, 400) }));
    const after = await req('GET', '/api/ocr/status');
    ok('跑完状态口径没变、待识别数归零或持平', after.status === 200 &&
      after.json.sessions.find((s) => s.key === live[0].key).pending === 0);
  }

  head('§6 现有 /api/fetch 仍在（未被新路由挤掉）');
  const state = await req('GET', '/api/state');
  ok('/api/state 正常', state.status === 200 && !!state.json);
  ok('server.mjs 里 /api/fetch 路由还在',
    /p === '\/api\/fetch'/.test(fs.readFileSync(S('server.mjs'), 'utf8')));
} catch (e) {
  fail++;
  console.log('  ❌ 未捕获异常 → ' + ((e && e.stack) || e));
} finally {
  if (child) { try { child.kill(); } catch {} }
}

console.log('\n=== 结果 ===');
console.log('  通过 ' + pass + ' / 失败 ' + fail + '（合计 ' + (pass + fail) + '）');
process.exit(fail ? 1 : 0);
