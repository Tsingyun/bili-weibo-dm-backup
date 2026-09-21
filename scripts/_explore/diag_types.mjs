import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const messages = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'messages.json'), 'utf8'));
const mt = {}, ty = {}, vt = {};
let vcover = 0, vcoverLocal = 0, emojiLocal = 0, emojiAll = 0;
for (const m of messages) {
  mt[m.media_type] = (mt[m.media_type] || 0) + 1;
  ty[m.type] = (ty[m.type] || 0) + 1;
  if (m.media_type === 4) vt[m.text] = (vt[m.text] || 0) + 1;
  for (const im of (m.images || [])) {
    if (im.kind === 'photo' && /^vcover_/.test(im.file || '')) { vcover++; if (im.local) vcoverLocal++; }
    if (im.kind === 'emoji') { emojiAll++; if (im.local) emojiLocal++; }
  }
}
console.log('media_type 分布:', JSON.stringify(mt));
console.log('type 分布:', JSON.stringify(ty));
console.log('video cover: 总', vcover, '本地', vcoverLocal);
console.log('emoji: 总', emojiAll, '本地', emojiLocal);
console.log('media_type=4 的文本样例:', JSON.stringify(vt));
// 找出 media_type=4/10 里有 video_pic_fid(即 gif_video) 的
console.log('gif_video 非空条数:', messages.filter(m => m.gif_video).length);
