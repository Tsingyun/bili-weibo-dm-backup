// 极简 CDP 客户端（零依赖，Node 18+ 内置 WebSocket）
export async function listTargets(port = 9333) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) });
  return await r.json();
}

export async function findPageTarget(port = 9333, match = null) {
  const list = await listTargets(port);
  const pages = list.filter(t => t.type === 'page');
  if (!pages.length) throw new Error('no page target');
  if (match) {
    const hit = pages.find(p => (p.url || '').includes(match));
    if (hit) return hit;
  }
  return pages[0];
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this._id = 0;
    this._pending = new Map();
    this._listeners = new Map();
    // socket 出错必须有人接着：只监听一次（open 阶段）的话，连接建立之后的错误
    // 会变成未处理的 'error' 事件，直接把调用方进程带崩。
    ws.addEventListener('error', () => { /* close 会紧随其后，在那里统一收尾 */ });
    ws.addEventListener('close', () => {
      for (const [, p] of this._pending) {
        try { p.reject(new Error('CDP 连接已关闭')); } catch {}
      }
      this._pending.clear();
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code} ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        const ls = this._listeners.get(msg.method);
        if (ls) for (const f of ls) { try { f(msg.params, msg.sessionId); } catch {} }
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws open timeout')), 15000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error('ws error: ' + (e.message || 'unknown'))); }, { once: true });
    });
    return new CDP(ws);
  }

  static async attach(port = 9333, match = null) {
    const t = await findPageTarget(port, match);
    const c = await CDP.connect(t.webSocketDebuggerUrl);
    c.target = t;
    return c;
  }

  send(method, params = {}, timeoutMs = 180000) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      // ⚠ 这个定时器以前从不 clear：任务早就完成了，一个 180 秒的 timer 还挂在事件循环上，
      //   既拖着进程不退出，也会在一次次轮询里越积越多。
      const t = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, timeoutMs);
      if (typeof t.unref === 'function') t.unref();
      const done = (fn) => (v) => { clearTimeout(t); fn(v); };
      this._pending.set(id, { resolve: done(resolve), reject: done(reject) });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(t);
        reject(e);
      }
    });
  }

  on(method, fn) {
    if (!this._listeners.has(method)) this._listeners.set(method, []);
    this._listeners.get(method).push(fn);
  }

  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
      userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error('eval exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  close() { try { this.ws.close(); } catch {} }
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
