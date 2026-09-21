/**
 * 后台任务管理器（WebUI 的"长任务"全靠它）
 * ===============================================================
 * 抓取一次可能跑十几分钟、输出几万行。WebUI 这边必须做到三件事：
 *   1. 不阻塞 HTTP 响应 —— 起子进程，立刻返回 jobId，前端轮询 / SSE 追进度；
 *   2. 不丢字 —— 中文在多字节边界被切断是常见事故，所以用 StringDecoder
 *      而不是 `chunk.toString()`（后者会把一个汉字拆成两个乱码字符）；
 *   3. 不炸内存 —— 输出进环形缓冲（默认留最后 4000 行），只保留最近 30 个任务。
 *
 * 队列（queue）
 * ---------------------------------------------------------------
 * `startJob(spec, { queue: 'serial' })` 建出来的任务是**排队**的：
 * 同一个队列里永远只有一个在跑，前一个结束了自动起下一个。
 *
 * 为什么需要它：勾选「微博 + B站」同时备份时，两平台的抓取会抢同一个浏览器调试端口
 * （后起的那个连不上 CDP 直接失败）、抢同一块写盘，日志也全糊在一起。
 * 旧实现是"只起第一个，注释说前端会接着发起下一个"—— 而前端根本没实现接力，
 * 于是**第二个平台永远不会跑**（用户得手动取消微博、单独再选 B站）。
 * 现在服务端一次性把 N 个任务排好队，前端只管顺序看日志。
 *
 * 有意不做的事：任务状态不落盘。重启 WebUI 后历史任务清空 ——
 * 真正的运行记录在 logs/auto_*.log（定时任务那边）与各脚本自己的输出里，
 * 这里只是一块"看进度的玻璃"，不做第二份真相。
 */
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { ROOT } from './paths.mjs';

const MAX_LINES = 4000;
const MAX_JOBS = 30;
let seq = 0;

/** id -> Job */
const jobs = new Map();
/** 插入顺序（用于淘汰旧任务） */
const order = [];
/** 队列名 -> [jobId]（同队列串行；只装还没结束的） */
const queues = new Map();

/** 「占着位置」的任务：在跑的 + 排队的。淘汰旧任务时要避开它们 */
const busy = (j) => !!j && (j.status === 'running' || j.status === 'queued');

export class Job {
  constructor({ title, exe, args, cwd, env, tag }) {
    this.id = 'j' + (++seq) + '-' + Date.now().toString(36);
    this.title = title;
    this.exe = exe;
    this.args = args || [];
    this.cwd = cwd || ROOT;
    this.env = env || null;         // 额外环境变量（launch 时才拼进 process.env）
    this.tag = tag || '';
    this.status = 'queued';         // queued | running | done | failed | error | cancelled
    this.code = null;
    this.queue = '';                // 所属队列名（'' = 不在队列，立即跑）
    this.queuedAt = Date.now();     // 入队时间
    this.startedAt = null;          // 真正起跑时间（排队时是 null）
    this.endedAt = null;
    this.lines = [];
    this.dropped = 0;               // 因环形缓冲被挤掉的早期行数
    this.listeners = new Set();
    this.proc = null;
    this.error = null;
  }

  push(line) {
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LINES);
      this.dropped++;
    }
    for (const fn of this.listeners) {
      try { fn(line); } catch { /* 单个订阅者坏了不影响任务 */ }
    }
  }

  get cmdline() {
    return [this.exe, ...this.args].join(' ');
  }

  /** 给前端的摘要（不含全部输出，输出走 /api/job/stream 或 /api/job?id=） */
  summary() {
    return {
      id: this.id, title: this.title, tag: this.tag, status: this.status,
      code: this.code, error: this.error, queue: this.queue,
      queuedAt: this.queuedAt,
      startedAt: this.startedAt, endedAt: this.endedAt,
      lines: this.lines.length, dropped: this.dropped,
      cmdline: this.cmdline,
      tail: this.lines.slice(-12),
    };
  }
}

function decodeStream(stream, job) {
  const dec = new StringDecoder('utf8');
  let buf = '';
  stream.on('data', (chunk) => {
    buf += dec.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) job.push(line);
    }
    // 单行过长（比如 JSON 打一行）也要吐出来，别把内存撑爆
    if (buf.length > 200000) { job.push(buf); buf = ''; }
  });
  stream.on('end', () => {
    buf += dec.end();
    if (buf.trim()) job.push(buf.replace(/\r$/, ''));
  });
  stream.on('error', () => {});
}

/**
 * 连同子进程树一起终止。
 * ⚠ 为什么不能只 `proc.kill()`：这里 spawn 的是 run_pipeline.mjs，它**自己还会再 spawn**
 *   真正的抓取脚本。Windows 上 kill 只作用于直接子进程，于是父进程死了、孙子还活着 ——
 *   用户点了「停止」看到任务结束，后台那个进程却还在继续往数据目录里写。
 */
function killTree(proc) {
  if (process.platform === 'win32' && proc && proc.pid) {
    try {
      const r = spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
      if (r.status === 0) return true;
    } catch { /* taskkill 不在 PATH 上就退回下面的普通 kill */ }
  }
  try { proc.kill('SIGTERM'); return true; } catch { return false; }
}

/**
 * 淘汰旧任务。
 * ⚠ 旧写法是「最老的在跑 → 放回队尾 → break」，结果是**这一轮一次都不淘汰**，
 *   order 和 jobs 只增不减：只要一直有一个长任务挂着，任务对象（每个最多 4000 行输出）
 *   就会无限堆积。改成：先挑最老的**已结束**任务淘汰；实在全是运行中，才动最老的那个。
 *  ⚠ 排队中的任务不能删 —— 队列里还留着它的 id，删了 pump 就找不到、后面全卡死。
 */
function evictIfNeeded() {
  while (order.length > MAX_JOBS) {
    const at = order.findIndex((id) => !busy(jobs.get(id)));
    if (at < 0) break;                       // 全在跑/全在排队：这一轮不淘汰
    jobs.delete(order[at]);
    order.splice(at, 1);
  }
  if (jobs.size > MAX_JOBS * 2) {            // 硬上限兜底：宁可让一个老任务消失，也不让内存涨上去
    const at = order.findIndex((id) => !busy(jobs.get(id)));
    if (at >= 0) { jobs.delete(order[at]); order.splice(at, 1); }
  }
}

/** 真正起子进程。排队任务轮到它时也走这里 */
function launch(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  job.push('$ ' + job.cmdline);
  try {
    job.proc = spawn(job.exe, job.args, {
      cwd: job.cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        ...(job.env || {}),
      },
      windowsHide: true,
    });
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.endedAt = Date.now();
    job.push('[启动失败] ' + e.message);
    if (job.queue) pump(job.queue);
    return job;
  }

  decodeStream(job.proc.stdout, job);
  decodeStream(job.proc.stderr, job);

  job.proc.on('error', (e) => {
    job.status = 'error';
    job.error = e.message;
    job.endedAt = Date.now();
    job.push('[进程错误] ' + e.message);
    if (job.queue) pump(job.queue);          // 起不来也要放行队列，别让后面永远等着
  });

  job.proc.on('close', (code, signal) => {
    job.code = code;
    if (job.status === 'running') job.status = (code === 0 ? 'done' : 'failed');
    job.endedAt = Date.now();
    job.push(`[退出] code=${code}${signal ? ' signal=' + signal : ''}  ` +
             `耗时 ${((job.endedAt - job.startedAt) / 1000).toFixed(1)}s`);
    if (job.queue) pump(job.queue);          // 前一个结束 → 起下一个
  });

  return job;
}

/** 看看这个队列能不能起下一个：只有「一个在跑的都没有」时才起队首 */
function pump(queueName) {
  const alive = (queues.get(queueName) || [])
    .map((id) => jobs.get(id))
    .filter((j) => j && (j.status === 'queued' || j.status === 'running'));
  if (alive.length) queues.set(queueName, alive.map((j) => j.id));
  else queues.delete(queueName);
  if (!alive.length) return;
  if (alive.some((j) => j.status === 'running')) return;   // 前面那个还在跑
  launch(alive[0]);
}

/**
 * 起一个任务。
 * @param spec  {title, exe, args, cwd, env, tag}
 * @param opts  {queue} 队列名 —— 传了就排队执行（同队列串行），不传立即跑
 */
export function startJob({ title, exe, args = [], cwd, env, tag = '' }, opts = {}) {
  const job = new Job({ title, exe, args, cwd, env, tag });
  job.queue = opts.queue || '';
  jobs.set(job.id, job);
  order.push(job.id);
  evictIfNeeded();

  if (job.queue) {
    job.push('[排队] 等前面的任务跑完就自动开始');
    const q = queues.get(job.queue) || [];
    q.push(job.id);
    queues.set(job.queue, q);
    pump(job.queue);
    return job;
  }
  return launch(job);
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs() {
  return order.map((id) => jobs.get(id)).filter(Boolean).map((j) => j.summary()).reverse();
}

export function killJob(id) {
  const j = jobs.get(id);
  if (!j) return false;

  // 还没轮到它：直接从队列里摘掉（不然后面的人要等一个永远不会跑的空位）
  if (j.status === 'queued') {
    j.status = 'cancelled';
    j.endedAt = Date.now();
    j.push('[请求终止] 还没轮到它，已取消');
    const q = (queues.get(j.queue) || []).filter((x) => x !== j.id);
    if (q.length) queues.set(j.queue, q); else queues.delete(j.queue);
    pump(j.queue);
    return true;
  }

  if (j.status !== 'running' || !j.proc) return false;
  j.push('[请求终止] 正在连同子进程一起结束…');
  const okKill = killTree(j.proc);
  j.push(okKill ? '[请求终止] 已发出终止信号' : '[请求终止] 终止失败（进程可能已经退出）');
  return okKill;
}

/** 订阅某任务的新行；返回退订函数 */
export function subscribe(id, fn) {
  const j = jobs.get(id);
  if (!j) return () => {};
  j.listeners.add(fn);
  return () => j.listeners.delete(fn);
}

/** 有没有任务占着（在跑或排队）—— 首页据此显示"有任务在进行" */
export function anyRunning() {
  for (const j of jobs.values()) if (busy(j)) return true;
  return false;
}
