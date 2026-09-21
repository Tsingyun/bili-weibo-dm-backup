// 探查失败项的原始结构
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const ids = ['5109513017360454','5165231579860657','5177888689356876','5192001651214674','5245970738318071','5298828593856857'];

const cookie = fs.readFileSync(path.join(DATA, 'cookie_header.txt'), 'utf8').trim();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
async function api(u) {
  const r = await fetch('https://api.weibo.com/webim/' + u, { headers: { Cookie: cookie, Referer: 'https://api.weibo.com/chat', 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest' } });
  return await r.text();
}
// 用 conversation 接口按 max_id 附近捞不现实，改用页面已有的 messages.json 存不下原始字段
// 改为直接重新拉一页原始数据：以 max_id=该条 idstr 拉一页，找匹配 id
for (const id of ids) {
  const t = await api(`2/direct_messages/conversation.json?convert_emoji=1&count=20&max_id=${id}&uid=1234567890&is_include_group=0&from_contacts=1&source=209678993`);
  let j; try { j = JSON.parse(t); } catch { console.log(id, 'PARSE FAIL', t.slice(0,120)); continue; }
  const hit = (j.direct_messages || []).find(m => String(m.idstr) === id || String(m.id) === id);
  if (!hit) { console.log(id, '— 未命中（可能 id 需用 max_id 上一页）'); continue; }
  console.log('=====', id, 'media_type=', hit.media_type, 'text=', JSON.stringify(hit.text));
  console.log('  att_ids=', JSON.stringify(hit.att_ids));
  console.log('  pic_infos=', JSON.stringify(hit.pic_infos));
  console.log('  ext_text=', JSON.stringify(hit.ext_text));
  console.log('  url_objects=', JSON.stringify((hit.url_objects||[]).map(o=>({ori:o.url_ori, info:o.info}))));
}
