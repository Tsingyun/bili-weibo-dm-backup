/**
 * 最小 zip 读写（自己实现，不依赖任何 npm 包 / 外部命令）
 * ===============================================================
 * 为什么要自己写：
 *   · 这个项目承诺「解压即用、不装依赖」。Compress-Archive / 7z / tar 在受限环境里
 *     经常调不动，而且失败时拿不到有用报错（踩过）。
 *   · Node 自带 `zlib.deflateRawSync` / `inflateRawSync` / `crc32`，
 *     剩下要手写的只有「本地头 + 中央目录 + EOCD」这三段固定格式。
 *
 * 写出去的 zip 带 UTF-8 文件名标志位（0x0800），Windows 资源管理器、
 * macOS 归档工具、Python zipfile 都能正确解开中文名（已实测）。
 *
 * 读只支持到「我们能生成的东西」这个范围：store / deflate、无加密、无 zip64。
 * 超出范围会明确报错，不静默给错数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

let CRC_TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

function dosDateTime(mtime) {
  const d = new Date(mtime || Date.now());
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * 写 zip。
 * @param {Array<{name:string, data:Buffer, mtime?:number}>} entries
 *        name 用 `/` 分隔，写进包里的就是它（不含额外根目录，要加前缀自己加）
 * @param {string} outPath
 * @returns {{files:number, bytes:number}}
 */
/** 写满一个 buffer（writeSync 允许短写，必须循环） */
function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

export function writeZip(entries, outPath) {
  // ⚠ 旧实现是「把所有条目 + 中央目录拼成一个大 Buffer 再一次性写」：
  //   导出带图片的 bundle 时（微博 174 MB 图片）等于把几百 MB 全压在内存里，
  //   而且 deflateRawSync 一路阻塞事件循环，服务端那几分钟完全不响应。
  //   改成边写边落盘：本地头段顺序写进文件，中央目录只在内存里留结构（很小）。
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fd = fs.openSync(outPath, 'w');
  const centrals = [];
  let offset = 0;
  let total = 0;

  try {
    if (entries.length > 0xffff) throw new Error('条目太多（>65535），zip 装不下');
    for (const en of entries) {
    const name = String(en.name).replace(/\\/g, '/');
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(en.data) ? en.data : Buffer.from(String(en.data), 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const { time, date } = dosDateTime(en.mtime);
    const crc = crc32(raw);
    // uint32 的字段装不下 4GB 以上；不拦的话写出来的是一个尺寸字段溢出的坏包
    if (raw.length > 0xfffffffe || comp.length > 0xfffffffe) {
      throw new Error('单条目过大（>4GB），无法写入 zip：' + name);
    }

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);   // UTF-8 文件名
    lh.writeUInt16LE(8, 8);        // deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    writeAll(fd, lh); writeAll(fd, nameBuf); writeAll(fd, comp);
    total += lh.length + nameBuf.length + comp.length;

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
      centrals.push(ch, nameBuf);

      offset += lh.length + nameBuf.length + comp.length;
    }

    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    writeAll(fd, cd);
    writeAll(fd, eocd);
    total += cd.length + eocd.length;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  return { files: entries.length, bytes: total };
}

/** 把一棵目录打进 zip（key 前缀可选） */
export function zipDir(srcDir, outPath, rootName = '') {
  const entries = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.DS_Store' || e.name === 'Thumbs.db') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const r = path.relative(srcDir, full).replace(/\\/g, '/');
        entries.push({
          name: rootName ? rootName + '/' + r : r,
          data: fs.readFileSync(full),
          mtime: fs.statSync(full).mtimeMs,
        });
      }
    }
  };
  walk(srcDir);
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  return writeZip(entries, outPath);
}

const MAX_ENTRY = 512 * 1024 * 1024;   // 单文件 512MB 上限，防畸形包把内存吃光
// 解压后的**总量**上限。只有单文件上限是不够的：500 个 500MB 的条目
// （或者一个高度可压缩的小 zip 炸出几十 GB）照样能把内存吃干 —— 这是经典的 zip bomb。
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const MAX_COUNT = 20000;

/**
 * 读 zip → [{name, data}]。
 * 只认 store(0) / deflate(8)；加密、zip64、分卷一律报错。
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  // 读包全程包一层：坏包/截断包会让 readUInt32LE 抛
  // "Offset is outside the bounds of the DataView" 这种看不懂的错，
  // 调用方（导入他人备份）拿到后也只会原样糊到用户脸上。
  try {
    return readZipInner(buf);
  } catch (e) {
    if (/损坏|不支持|加密|过大|太多|不是/.test(String(e && e.message))) throw e;
    throw new Error('压缩包损坏或不是标准 zip（' + String(e && e.message || e).slice(0, 80) + '）');
  }
}

function readZipInner(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这不是一个 zip 文件（找不到中央目录）');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('暂不支持 zip64 格式的压缩包');
  if (count > MAX_COUNT) throw new Error('压缩包条目太多（' + count + '），拒绝解压');

  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏（第 ' + (n + 1) + ' 项）');
    const flag = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + cmtLen;

    if (flag & 0x0001) throw new Error('压缩包已加密，无法读取：' + name);
    if (!name.endsWith('/')) {
      if (rawSize > MAX_ENTRY) throw new Error('单文件过大，拒绝解压：' + name);
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏：' + name);
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.slice(start, start + compSize);
      let data;
      if (method === 8) data = zlib.inflateRawSync(comp);
      else if (method === 0) data = Buffer.from(comp);
      else throw new Error('压缩方式不支持（method=' + method + '）：' + name);
      total += data.length;
      if (total > MAX_TOTAL) throw new Error('解压后总量超过 2GB，拒绝解压（可能是 zip bomb）');
      out.push({ name, data });
    }
  }
  return out;
}

export function readZipFile(file) {
  return readZip(fs.readFileSync(file));
}
