import fs from 'node:fs';
import { CDP } from './cdp_lib.mjs';

const R = import.meta.dirname.replace(/\\/g, '/') + '/../../data/raw';
const cdp = await CDP.attach(9333, 'api.weibo.com/chat');

// 1) 导出 cookies
let cookies = null;
try {
  const r = await cdp.send('Storage.getCookies', {});
  cookies = r.cookies;
} catch (e) {
  const r = await cdp.send('Network.getAllCookies', {});
  cookies = r.cookies;
}
console.log('cookies total:', cookies.length);
const weibo = cookies.filter(c => /weibo|sina/.test(c.domain));
console.log('weibo cookies:', weibo.map(c => c.domain + c.path + ' ' + c.name + '=' + String(c.value).slice(0, 12) + '...').join('\n'));

const jar = {};
for (const c of weibo) {
  const key = c.name;
  if (!(key in jar)) jar[key] = c.value;
}
const cookieHeader = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
fs.writeFileSync(R + '/cookie_header.txt', cookieHeader, 'utf8');
fs.writeFileSync(R + '/cookies_full.json', JSON.stringify(weibo, null, 2), 'utf8');
console.log('\ncookieHeader length:', cookieHeader.length);
console.log('has SUB:', /(^|; )SUB=/.test(cookieHeader), '| has SUBP:', /SUBP=/.test(cookieHeader));

// 2) 测试图片不同参数
const FID = '5343066366937128';
const variants = [
  `https://upload.api.weibo.com/2/mss/msget_thumbnail?fid=${FID}&high=240&width=240&size=240,158&source=209678993&imageType=origin`,
  `https://upload.api.weibo.com/2/mss/msget_thumbnail?fid=${FID}&source=209678993&imageType=origin`,
  `https://upload.api.weibo.com/2/mss/msget_thumbnail?fid=${FID}&source=209678993&imageType=large`,
  `https://upload.api.weibo.com/2/mss/msget_thumbnail?fid=${FID}&source=209678993&imageType=bmiddle`,
  `https://upload.api.weibo.com/2/mss/msget_thumbnail?fid=${FID}&source=209678993&imageType=middle`,
];
for (const u of variants) {
  try {
    const r = await fetch(u, {
      headers: { Cookie: cookieHeader, Referer: 'https://api.weibo.com/chat', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(20000)
    });
    const buf = Buffer.from(await r.arrayBuffer());
    console.log(`\n[${r.status}] type=${r.headers.get('content-type')} len=${buf.length}`);
    console.log('  ', u.replace('https://upload.api.weibo.com', ''));
    let sig = '';
    if (buf[0] === 0xFF && buf[1] === 0xD8) sig = 'JPEG';
    else if (buf.slice(0, 4).toString() === 'GIF8') sig = 'GIF';
    else if (buf.slice(0, 8).toString('hex').startsWith('89504e47')) sig = 'PNG';
    else sig = 'other:' + buf.slice(0, 40).toString('utf8').slice(0, 40);
    console.log('   magic=', sig);
  } catch (e) { console.log('ERR', u, e.message); }
}

cdp.close();
