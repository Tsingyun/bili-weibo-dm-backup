/**
 * 最小 CDP 模拟端（只在测试里用）
 * ================================================================
 * 为什么要有它：
 *   「浏览器开着时，登录校验会走页面里那条路（verifyInBrowser）」这条链路，
 *   光靠单元断言测不到 —— 它要连 /json/list、握手 WebSocket、发 Runtime.evaluate。
 *   真开一个浏览器来测又会弹出窗口、污染用户的登录环境。
 *   所以这里手写一个**够用的** CDP 端点：HTTP 罗列 target + 一个能回话的 WebSocket。
 *
 * 用法：
 *   const m = await startMockCdp(0, { body: '200\n{"profile":{"id":1,...}}' });
 *   // 之后把 DM_CDP_PORT 设成 m.port 去跑 login.mjs
 *   await m.close();
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 解析一个客户端发来的（必然带掩码的）文本帧 */
function readFrame(buf) {
  if (buf.length < 6) return null;
  const b1 = buf[0];
  const opcode = b1 & 0x0f;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const mask = buf.slice(off, off + 4);
  off += 4;
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.slice(off, off + len));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, text: payload.toString('utf8'), total: off + len };
}

/** 构造一个服务端文本帧（不带掩码） */
function textFrame(s) {
  const p = Buffer.from(s, 'utf8');
  const head = p.length < 126
    ? Buffer.from([0x81, p.length])
    : (() => { const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); return h; })();
  return Buffer.concat([head, p]);
}

export function startMockCdp(port = 0, opts = {}) {
  const url = opts.url || 'https://api.weibo.com/chat#/chat';
  const body = opts.body !== undefined
    ? opts.body
    : '200\n' + JSON.stringify({ profile: { id: 1234567890, screen_name: 'mock_user' } });

  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'mock', Protocol: '1.3' }));
      return;
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        id: '1', type: 'page', title: 'mock', url,
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/1`,
      }]));
      return;
    }
    res.writeHead(404); res.end();
  });

  return new Promise((resolve, reject) => {
    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
      );
      let acc = Buffer.alloc(0);
      socket.on('data', (d) => {
        acc = Buffer.concat([acc, d]);
        for (;;) {
          const f = readFrame(acc);
          if (!f) break;
          acc = acc.slice(f.total);
          if (f.opcode === 8) { socket.end(); return; }
          let msg = null;
          try { msg = JSON.parse(f.text); } catch { continue; }
          if (msg.method === 'Runtime.evaluate') {
            const val = typeof body === 'function' ? body(msg.params) : body;
            socket.write(textFrame(JSON.stringify({
              id: msg.id,
              result: { result: { type: 'string', value: val } },
            })));
          } else {
            socket.write(textFrame(JSON.stringify({ id: msg.id, result: {} })));
          }
        }
      });
      socket.on('error', () => { /* 测试里断就断了 */ });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}
