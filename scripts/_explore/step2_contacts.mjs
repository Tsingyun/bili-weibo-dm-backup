import fs from 'node:fs';
import path from 'node:path';
import { CDP, sleep } from './cdp_lib.mjs';

const ROOT = import.meta.dirname.replace(/\\/g, '/') + '/../..';
const OUT = path.join(ROOT, 'data', 'raw');
const LOG = path.join(ROOT, 'data', 'raw', 'step2.log');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOG, '', 'utf8');
const log = (...a) => {
  const line = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  fs.appendFileSync(LOG, line + '\n', 'utf8');
  try { process.stdout.write(line + '\n'); } catch {}
};

try {
  const cdp = await CDP.attach(9333, 'api.weibo.com/chat');
  log('[cdp] target =', cdp.target.url);

  const me = await cdp.eval(`(async () => {
    try {
      const r = await fetch('https://api.weibo.com/webim/query_primary_info.json?source=209678993', {credentials:'include'});
      return await r.text();
    } catch(e) { return 'ERR:'+e.message; }
  })()`);
  log('=== primary_info ===');
  log(String(me).slice(0, 1200));

  const contactsRaw = await cdp.eval(`(async () => {
    try {
      const u = 'https://api.weibo.com/webim/2/direct_messages/contacts.json?special_source=3&add_virtual_user=3,4&is_include_group=0&need_back=0,0&is_include_folder=1&count=200&source=209678993';
      const r = await fetch(u, {credentials:'include'});
      const t = await r.text();
      return JSON.stringify({status: r.status, len: t.length, body: t});
    } catch(e) { return 'ERR:'+e.message; }
  })()`);

  let contacts = null;
  try {
    const wrap = JSON.parse(contactsRaw);
    fs.writeFileSync(path.join(OUT, 'contacts_raw.json'), wrap.body, 'utf8');
    contacts = JSON.parse(wrap.body);
    log('=== contacts status', String(wrap.status), 'len', String(wrap.len), '===');
  } catch (e) {
    log('contacts parse err', e.message, String(contactsRaw).slice(0, 400));
  }

  if (contacts) {
    const dump = JSON.stringify(contacts);
    const names = [...dump.matchAll(/"screen_name":"([^"]*)"/g)].map(m => m[1]);
    log('screen_names:', JSON.stringify([...new Set(names)]));
    log('top keys:', JSON.stringify(Object.keys(contacts)));
  }

  log('DONE-OK');
  cdp.close();
} catch (e) {
  log('FATAL', e && e.stack ? e.stack : String(e));
}
