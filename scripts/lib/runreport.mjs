/**
 * 抓取运行报告（P0-2）
 * ===============================================================
 * 以前每次抓取发生了什么，只活在那个黑窗口里 —— 窗口一关，「这次到底抓全没有、
 * 有几张图挂了、是不是中途被限流」就没人知道了，出问题只能全量重跑。
 *
 * 现在每次运行结束都往 <dir>/_runs/<时间戳>.json 落一份摘要：
 *   模式 / 时间窗 / 翻了几页 / 新增多少条 / 图片成几败几 / 接口报错 / 耗时
 * 失败的下载另存 <dir>/retry.json，下次增量**优先**重试（并自动销账）。
 *
 * 三条约束：
 *   1) **只增不改数据**：本模块不碰 messages.json，只写自己的报告与待重试清单。
 *   2) **不许因为写报告把抓取搞崩**：任何一步出错都吞掉并打一行，绝不抛给主流程。
 *   3) **有上限**：报告默认留最近 30 份；失败清单默认留 500 条，避免无限膨胀。
 */
import fs from 'node:fs';
import path from 'node:path';

export const RUNS_DIR = '_runs';
export const RETRY_FILE = 'retry.json';
const KEEP_RUNS = 30;
const MAX_FAILURES = 500;
const MAX_ERRORS = 20;

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function pad(n) { return String(n).padStart(2, '0'); }
/** 与索引快照同一套时间写法：20260923-011500（本机时区，好认） */
function stamp(d = new Date()) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
         pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}
function writeAtomic(p, text) {
  try {
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, p);
  } catch { /* 报告写不出来也不能拖垮抓取 */ }
}
function readJson(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; }
}

/**
 * 开一次运行记录。
 * @param {{session:string, dirAbs:string, mode:string, since?:string, until?:string,
 *          noImg?:boolean, messagesBefore?:number, argv?:string[]}} o
 */
export function startRun(o) {
  const t0 = Date.now();
  return {
    _t0: t0,
    _dirAbs: o.dirAbs,
    schema: 1,
    session: o.session,
    dir: path.basename(o.dirAbs),
    mode: o.mode || 'incr',
    started_at: new Date(t0).toISOString(),
    since: o.since || null,
    until: o.until || null,
    no_img: !!o.noImg,
    messages_before: o.messagesBefore ?? null,
    messages_after: null,
    added: 0,
    pages: 0,
    reached_end: false,
    images: { jobs: 0, ok: 0, skip: 0, fail: 0 },
    errors: [],
    failures: [],
    retried: 0,
  };
}

/** 记一条接口/处理错误（最多 20 条，多了只计数） */
export function noteError(run, msg) {
  if (!run) return;
  if (run.errors.length < MAX_ERRORS) run.errors.push({ at: new Date().toISOString(), msg: String(msg).slice(0, 200) });
  else run._errOverflow = (run._errOverflow || 0) + 1;
}

/** 图片下载结果汇总；failures 里记的是"下次还能再试一次"的那些 */
export function noteImages(run, { jobs = 0, ok = 0, skip = 0, fail = 0, failures = [] } = {}) {
  if (!run) return;
  run.images.jobs += jobs; run.images.ok += ok;
  run.images.skip += skip; run.images.fail += fail;
  for (const f of failures) {
    if (run.failures.length < MAX_FAILURES) run.failures.push(f);
  }
}

/**
 * 收尾：算耗时、写报告、合并失败清单、清理旧报告。
 * @returns {{file:string, retried:number, pending:number}|null}
 */
export function finishRun(run, extra = {}) {
  if (!run) return null;
  const dirAbs = run._dirAbs;
  const finished = new Date();
  run.finished_at = finished.toISOString();
  run.duration_ms = finished.getTime() - run._t0;
  Object.assign(run, extra);
  if (run._errOverflow) run.errors.push({ at: finished.toISOString(), msg: `…另有 ${run._errOverflow} 条同类错误未逐条记录` });
  delete run._errOverflow; delete run._t0; delete run._dirAbs;

  const runsDir = path.join(dirAbs, RUNS_DIR);
  try { fs.mkdirSync(runsDir, { recursive: true }); } catch {}
  const file = path.join(runsDir, stamp(finished) + '.json');
  writeAtomic(file, JSON.stringify(run, null, 2) + '\n');

  // 待重试清单：与旧的合并去重（按 key），成功的不再留着
  const prev = readJson(path.join(dirAbs, RETRY_FILE), null);
  const prevItems = (prev && Array.isArray(prev.items)) ? prev.items : [];
  const merged = new Map();
  for (const it of prevItems) if (it && it.key) merged.set(it.key, it);
  const done = new Set(extra.succeededKeys || []);
  for (const k of done) merged.delete(k);
  for (const f of (run.failures || [])) if (f && f.key) merged.set(f.key, f);
  const items = [...merged.values()].slice(0, MAX_FAILURES);
  writeAtomic(path.join(dirAbs, RETRY_FILE), JSON.stringify({
    schema: 1,
    updated_at: finished.toISOString(),
    note: '上次没下载成功的图片。下次更新会优先重试，成功一件销一件；也可以直接删掉这个文件放弃重试。',
    items,
  }, null, 2) + '\n');

  pruneRuns(runsDir);
  // 展示用一律正斜杠（Windows 上 path.join 会给反斜杠，日志里看着别扭）
  return { file: run.dir + '/' + RUNS_DIR + '/' + path.basename(file), pending: items.length };
}

/** 只留最近 KEEP_RUNS 份，避免目录无限膨胀 */
export function pruneRuns(runsDir, keep = KEEP_RUNS) {
  try {
    if (!exists(runsDir)) return 0;
    const files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort();
    let n = 0;
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try { fs.rmSync(path.join(runsDir, f)); n++; } catch {}
    }
    return n;
  } catch { return 0; }
}

/** 最近 N 次运行（新的在前）；读不动的文件跳过 */
export function listRuns(dirAbs, limit = 5) {
  const runsDir = path.join(dirAbs, RUNS_DIR);
  if (!exists(runsDir)) return [];
  try {
    const files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort().reverse();
    const out = [];
    for (const f of files.slice(0, limit)) {
      const o = readJson(path.join(runsDir, f), null);
      if (o) out.push({ id: f.replace(/\.json$/, ''), ...o });
    }
    return out;
  } catch { return []; }
}

/** 读待重试清单（给下次运行"优先重试"用） */
export function loadRetry(dirAbs) {
  const o = readJson(path.join(dirAbs, RETRY_FILE), null);
  return (o && Array.isArray(o.items)) ? o.items : [];
}

/**
 * 把下载任务按「上次失败过的排前面」重排，并告诉调用方上次失败了几件。
 * 为什么只调整顺序而不单独重发请求：单独重发会绕过已有的并发与去重，
 * 容易把请求量打上去（平台限流就是这么来的）。
 */
export function prioritize(jobs, dirAbs, keyOf = (j) => j.file || j.url || '') {
  const pending = loadRetry(dirAbs);
  if (!pending.length) return { jobs, pending: 0 };
  const rank = new Map(pending.map((it, i) => [it.key, i]));
  const sorted = jobs.slice().sort((a, b) => {
    const ra = rank.has(keyOf(a)) ? rank.get(keyOf(a)) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(keyOf(b)) ? rank.get(keyOf(b)) : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
  return { jobs: sorted, pending: pending.length };
}
