import { CDP } from './cdp_lib.mjs';

const c = await CDP.attach(9333, 'api.weibo.com/chat');
console.log('target:', c.target.url);

async function t(name, params, ms = 25000) {
  const s = Date.now();
  try {
    const v = await c.send('Runtime.evaluate', params, ms);
    console.log(`[OK ${Date.now() - s}ms] ${name} ->`, JSON.stringify(v.result).slice(0, 160));
    return v;
  } catch (e) {
    console.log(`[FAIL ${Date.now() - s}ms] ${name} -> ${e.message}`);
    return null;
  }
}

await t('1+1', { expression: '1+1', returnByValue: true });
await t('location.href', { expression: 'location.href', returnByValue: true });
await t('promise-resolve', { expression: 'Promise.resolve(42)', awaitPromise: true, returnByValue: true });
await t('async-iife-fetch', {
  expression: `(async () => { try { const r = await fetch("https://api.weibo.com/webim/query_primary_info.json?source=209678993", {credentials:'include'}); return (await r.text()).slice(0,60); } catch(e){ return 'ERR:'+e.message; } })()`,
  awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true, userGesture: true
});
await t('document.readyState', { expression: 'document.readyState', returnByValue: true });

c.close();
