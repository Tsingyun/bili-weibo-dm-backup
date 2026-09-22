import fs from 'node:fs';
import path from 'node:path';
import { CDP, sleep } from './cdp_lib.mjs';

const ROOT = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const OUT = path.join(ROOT, 'data', 'raw');
fs.mkdirSync(OUT, { recursive: true });

const CHAT_URL = 'https://api.weibo.com/chat#/chat';
const PORT = 9333;

const cdp = await CDP.attach(PORT);
console.log('[cdp] attached to', cdp.target.url);

const netlog = [];
cdp.on('Network.requestWillBeSent', (p) => {
  const t = p.type;
  if (t === 'XHR' || t === 'Fetch') netlog.push({ t, url: p.request.url, method: p.request.method });
});

await cdp.send('Page.enable');
await cdp.send('Network.enable');
await cdp.send('Runtime.enable');

console.log('[nav] ->', CHAT_URL);
await cdp.send('Page.navigate', { url: CHAT_URL });

await sleep(9000);

let state = null;
try {
  state = await cdp.eval(`(() => {
    const d = {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      text: (document.body ? document.body.innerText : '').slice(0, 800),
      hasLoginForm: !!document.querySelector('#login_form, .login_form, .login-btn, [class*=qrcode], [class*=login]'),
      cookies: document.cookie.length
    };
    return d;
  })()`);
} catch (e) {
  console.log('[eval] err', e.message);
}

// 再等一会儿，让聊天页把接口都发出来
await sleep(6000);
try {
  state = await cdp.eval(`({href: location.href, title: document.title, text: (document.body?document.body.innerText:'').slice(0,800)})`);
} catch {}

const uniq = [...new Map(netlog.map(x => [x.url, x])).values()];
const weiboApi = uniq.filter(x => /weibo\.com|sina\.com\.cn/.test(x.url) && /(webim|direct_messages|message|chat|conversation|user_list|friend)/i.test(x.url));

fs.writeFileSync(path.join(OUT, 'step1_state.json'), JSON.stringify({ state, netCount: uniq.length, weiboApi, allXhr: uniq }, null, 2), 'utf8');

console.log('=== PAGE STATE ===');
console.log(JSON.stringify(state, null, 2));
console.log('=== XHR TOTAL:', uniq.length, '===');
console.log('=== CANDIDATE API ===');
for (const u of weiboApi) console.log(u.method, u.url);
console.log('=== ALL XHR (first 60) ===');
for (const u of uniq.slice(0, 60)) console.log(u.t, u.url);

cdp.close();
