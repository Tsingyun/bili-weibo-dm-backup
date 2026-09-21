import fs from 'node:fs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const cookieHeader = fs.readFileSync(R + '/cookie_header.txt', 'utf8');
const FID = '5343066366937128';

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

const tests = [
  ['thumb 240', `https://upload.api.weibo.com/2/mss/msget_thumbnail?fid=${FID}&high=240&width=240&size=240,158&source=209678993&imageType=origin`],
  ['thumb 1000', `https://upload.api.weibo.com/2/mss/msget_thumbnail?fid=${FID}&high=1000&width=1000&size=1000,1000&source=209678993&imageType=origin`],
  ['thumb 3000', `https://upload.api.weibo.com/2/mss/msget_thumbnail?fid=${FID}&high=3000&width=3000&size=3000,3000&source=209678993&imageType=origin`],
  ['thumb 9999 large', `https://upload.api.weibo.com/2/mss/msget_thumbnail?fid=${FID}&high=9999&width=9999&size=9999,9999&source=209678993&imageType=large`],
  ['msget', `https://upload.api.weibo.com/2/mss/msget?fid=${FID}&source=209678993`],
  ['msget_origin', `https://upload.api.weibo.com/2/mss/msget_origin?fid=${FID}&source=209678993`],
  ['msget 2000 origin', `https://upload.api.weibo.com/2/mss/msget_thumbnail?fid=${FID}&high=2000&width=2000&size=2000,2000&source=209678993&imageType=origin`],
];

for (const [name, u] of tests) {
  try {
    const r = await fetch(u, { headers: { Cookie: cookieHeader, Referer: 'https://api.weibo.com/chat', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await r.arrayBuffer());
    let extra = '';
    if (buf[0] === 0xFF && buf[1] === 0xD8) { const s = jpegSize(buf); extra = ' JPEG ' + (s ? s.w + 'x' + s.h : '?'); }
    console.log(`[${r.status}] ${String(buf.length).padStart(8)}B ${r.headers.get('content-type')} :: ${name}${extra}`);
    if (r.status !== 200) console.log('     body:', buf.toString('utf8').slice(0, 200));
  } catch (e) { console.log('ERR', name, e.message); }
}
