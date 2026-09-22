#!/usr/bin/env node
/* ============================================================
   P2-15 · 表情包一键导出
   ============================================================
   把会话用到的表情图**按使用次数**导出成一个文件夹，附一份 CSV 清单
   和一张纯本地网页（缩略图墙），方便挑图 / 打包分享。

   表情是怎么被引用的（实测）：
     · 微博：正文里写 `[微笑]`（DM_FACES.phrase）或 `[/ee808d.png]`（DM_FACES.ee）
     · B站 ：正文里写 `[某套表情包_某个表情]`（DM_FACES_B.phrase）
   所以使用次数 = 在 messages.json 的 text 里数 `[名称]` / `[/名称.png]` 的出现次数。
   另外 `--with-sent` 可以顺带导出聊天里**真正发出去**的自定义表情图
   （B站 media_type=6，文件在 <dir>/images/face_*），这批不在表情库索引里。

   ⚠ 纯本地：只读项目内文件、只往项目内 exports/ 写，不联网、不上传。

   用法：
     node scripts/export_faces.mjs                     # 两个会话都导
     node scripts/export_faces.mjs --session bili --used-only
     node scripts/export_faces.mjs --top 60 --with-sent
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadSessions, findSession } from './sessions.mjs';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, d = null) => {
  const i = ARGS.indexOf(f);
  if (i < 0) return d;
  const v = ARGS[i + 1];
  if (v === undefined || v.startsWith('--')) return d;
  return v;
};

if (has('--help') || has('-h')) {
  console.log(`表情包导出（纯本地）

  --session <key|all>   导哪个会话，默认 all
  --out <dir>           输出目录，默认 exports/表情包_<会话名>
  --min-uses N          只导使用次数 >= N 的，默认 0（全部）
  --used-only           等价于 --min-uses 1
  --top N               只导使用最多的 N 个
  --with-sent           额外导出发送过的自定义表情图（B站 images/face_*）
  --no-copy             只写 CSV 和网页，不复制图片文件
  --no-html             不生成 index.html
  --quiet

  导出内容：图片文件（按使用次数排序编号）+ 表情包清单.csv + index.html 缩略图墙`);
  process.exit(0);
}

const QUIET = has('--quiet');
const say = (...a) => { if (!QUIET) console.log(...a); };

const sessionArg = val('--session', 'all');
const sessions = sessionArg === 'all' ? loadSessions() : [findSession(sessionArg)];

let minUses = parseInt(val('--min-uses', '0'), 10);
if (!Number.isFinite(minUses) || minUses < 0) {
  console.error('[x] --min-uses 要是非负整数');
  process.exit(2);
}
if (has('--used-only')) minUses = Math.max(minUses, 1);

const topN = val('--top') ? parseInt(val('--top'), 10) : null;
if (topN != null && (!Number.isFinite(topN) || topN <= 0)) {
  console.error('[x] --top 要是正整数');
  process.exit(2);
}

const WITH_SENT = has('--with-sent');
const NO_COPY = has('--no-copy');
const NO_HTML = has('--no-html');

const IMG_EXT_OK = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** 读 faces.js：`window.DM_FACES_B = {...};` → 对象。全局名从会话清单来。 */
function readFacesObj(file, globalName) {
  if (!fs.existsSync(file)) return null;
  const s = fs.readFileSync(file, 'utf8').trim();
  // 用全局名精确剥前缀，不要用贪婪正则 —— 否则 DM_FACES 会误剥 DM_FACES_B
  const m = s.match(/^\s*(?:window\.)?([A-Za-z_$][\w$]*)\s*=\s*/);
  if (!m) return null;
  const name = m[1];
  if (globalName && name !== globalName) {
    console.error(`[!] ${path.relative(ROOT, file)} 里的全局名是 ${name}，清单写的是 ${globalName}，` +
      '按文件里的实际名字读');
  }
  try {
    return JSON.parse(s.slice(m[0].length).replace(/;\s*$/, ''));
  } catch (e) {
    console.error(`[x] 解析 ${path.relative(ROOT, file)} 失败：${e.message}`);
    process.exit(3);
  }
}

/** Windows 文件名里不能出现的字符换掉 */
function safeName(s, max = 56) {
  let out = String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  out = out.replace(/^[.\s]+|[.\s]+$/g, '');
  if (out.length > max) out = out.slice(0, max);
  return out || '未命名';
}

/** 数一个名称在正文里出现的次数（两种引用写法都数） */
function countUse(counter, name) {
  const direct = counter.bracket[name] || 0;
  const eeForm = counter.eeBracket[name] || 0;
  return direct + eeForm;
}

function scanUsage(messages) {
  const bracket = Object.create(null);
  const eeBracket = Object.create(null);
  const RE_BRACKET = /\[([^\[\]]{1,60})\]/g;
  for (const m of messages) {
    const t = m.text || '';
    if (!t || t.indexOf('[') < 0) continue;
    let mm;
    RE_BRACKET.lastIndex = 0;
    while ((mm = RE_BRACKET.exec(t)) !== null) {
      const inner = mm[1];
      // 微博的 ee 表情写法是 [/ee808d.png]，去掉前导斜杠和扩展名后按编号归一化。
      // ⚠ 只能存归一化后的键：同时存「带扩展名」和「不带」会让同一个表情算两次。
      if (inner.startsWith('/')) {
        const stem = inner.slice(1).replace(/\.[a-z0-9]+$/i, '');
        eeBracket[stem] = (eeBracket[stem] || 0) + 1;
        continue;
      }
      bracket[inner] = (bracket[inner] || 0) + 1;
    }
  }
  return { bracket, eeBracket };
}

const grand = { sessions: 0, files: 0, bytes: 0, html: [] };

for (const S of sessions) {
  const base = path.join(ROOT, S.dir);
  const facesJs = path.join(base, 'faces.js');
  const facesDir = path.join(base, 'faces');
  const obj = readFacesObj(facesJs, S.globals.faces);

  if (!obj) {
    console.error(`[!] ${S.label}：没有 ${S.dir}/faces.js，跳过`);
    continue;
  }

  const msgPath = path.join(base, 'messages.json');
  const messages = fs.existsSync(msgPath) ? JSON.parse(fs.readFileSync(msgPath, 'utf8')) : [];
  const usage = scanUsage(messages);

  /* 表情库：phrase（按名称）+ ee（按编号） */
  const items = [];
  const seenPath = new Set();
  const collect = (map, group) => {
    for (const [name, rel] of Object.entries(map || {})) {
      if (typeof rel !== 'string' || !rel) continue;
      const abs = path.resolve(ROOT, rel);
      // 同一个文件可能既在 phrase 又在 ee 里，去重保留第一次（phrase 优先）
      if (seenPath.has(abs)) continue;
      seenPath.add(abs);
      const ext = path.extname(abs).toLowerCase();
      if (!IMG_EXT_OK.has(ext)) continue;
      items.push({
        name,
        group,
        rel,
        abs,
        ext,
        uses: countUse(usage, name),
        exists: fs.existsSync(abs),
        sent: false,
      });
    }
  };
  collect(obj.phrase, 'phrase');
  collect(obj.ee, 'ee');

  /* 顺带：聊天里真正发出去的自定义表情图 */
  if (WITH_SENT) {
    for (const m of messages) {
      for (const im of (m.images || [])) {
        if (im.kind !== 'emoji' || !im.local) continue;
        const abs = path.resolve(ROOT, im.local);
        if (seenPath.has(abs)) continue;
        seenPath.add(abs);
        const ext = path.extname(abs).toLowerCase();
        if (!IMG_EXT_OK.has(ext)) continue;
        items.push({
          name: '（聊天发送）' + path.basename(abs, ext),
          group: 'sent',
          rel: im.local,
          abs,
          ext,
          uses: 1,
          exists: fs.existsSync(abs),
          sent: true,
        });
      }
    }
  }

  // 排序：用过多的在前，其次名称；缺文件的排到最后（不隐藏，但明确标出来）
  items.sort((a, b) => (b.uses - a.uses) || a.name.localeCompare(b.name, 'zh'));

  let picked = items.filter((it) => it.uses >= minUses);
  if (topN != null) picked = picked.slice(0, topN);

  if (!picked.length) {
    say(`[!] ${S.label}：没有符合条件的表情（试试点 --min-uses 0）`);
    continue;
  }

  const outDir = path.resolve(ROOT, val('--out') && sessions.length === 1
    ? val('--out')
    : path.join('exports', '表情包_' + S.label));

  const missing = picked.filter((it) => !it.exists);
  const copyable = picked.filter((it) => it.exists);
  if (missing.length) {
    console.error(`[!] ${S.label}：有 ${missing.length} 个表情索引里记了但在磁盘上找不到，已跳过复制`);
  }

  // 目录总是建出来：--no-copy 时不复制图片，但 CSV / 网页仍然写在这里
  fs.mkdirSync(outDir, { recursive: true });

  let copied = 0, bytes = 0;
  const rows = [];
  picked.forEach((it, idx) => {
    const rank = String(idx + 1).padStart(4, '0');
    let fileName = null;
    if (!NO_COPY && it.exists) {
      const stem = safeName(it.name.replace(/^\[|\]$/g, ''), 48);
      fileName = `${rank}_${stem}${it.ext}`;
      const dest = path.join(outDir, fileName);
      try {
        fs.copyFileSync(it.abs, dest);
        copied++;
        bytes += fs.statSync(dest).size;
      } catch (e) {
        console.error(`  [!] 复制失败 ${it.rel}：${e.message}`);
        fileName = null;
      }
    }
    // 网页里图片的引用路径：复制过就用导出目录里的副本，否则指回原位置
    const imgRef = (NO_COPY || !fileName)
      ? path.relative(outDir, it.abs).split(path.sep).join('/')
      : fileName;
    rows.push({ ...it, rank, fileName, imgRef });
  });

  /* CSV 清单 */
  const csvEsc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csvHeader = ['序号', '名称', '使用次数', '来源', '导出文件名', '原始路径', '文件是否在磁盘上'];
  const csvLines = [csvHeader.join(',')];
  for (const r of rows) {
    csvLines.push([
      r.rank, r.name, r.uses,
      r.group === 'phrase' ? '按名称引用' : (r.group === 'ee' ? '按编号引用' : '聊天发送'),
      r.fileName || '', r.rel, r.exists ? '是' : '否',
    ].map(csvEsc).join(','));
  }
  // 加 BOM：Excel 直接双击打开不会把中文读成乱码
  fs.writeFileSync(path.join(outDir, '表情包清单.csv'), '\uFEFF' + csvLines.join('\r\n') + '\r\n', 'utf8');

  /* 缩略图墙 */
  let htmlPath = null;
  if (!NO_HTML) {
    if (NO_COPY) {
      console.error('[!] --no-copy 与网页一起用会让图片引用指回原目录，仍会生成网页');
    }
    const cells = rows.map((r) => `
      <figure class="c">
        <img loading="lazy" src="${r.imgRef.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" alt="${String(r.name).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">
        <figcaption><b>${String(r.name).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</b>
          <span>${r.uses} 次</span>
          ${r.exists ? '' : '<em>文件缺失</em>'}
        </figcaption>
      </figure>`).join('');
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>表情包 · ${S.title}</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#262b35;--text:#e8ecf4;--muted:#98a2b3;--accent:#5b8cff}
  @media (prefers-color-scheme: light){
    :root{--bg:#f4f6fb;--card:#ffffff;--line:#e2e6ef;--text:#151922;--muted:#5b6472;--accent:#2f5fd0}
  }
  *{box-sizing:border-box}
  body{margin:0;padding:20px;background:var(--bg);color:var(--text);
       font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  h1{margin:0 0 4px;font-size:20px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:16px}
  .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}
  .c{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;
     padding:8px;display:flex;flex-direction:column;align-items:center;gap:6px}
  .c img{width:72px;height:72px;object-fit:contain;image-rendering:auto}
  figcaption{font-size:11px;color:var(--muted);text-align:center;word-break:break-all;line-height:1.35}
  figcaption b{display:block;color:var(--text);font-weight:600}
  figcaption span{color:var(--accent)}
  figcaption em{display:block;color:#d05252;font-style:normal}
</style></head>
<body>
  <h1>表情包 · ${S.title}</h1>
  <div class="sub">共 ${rows.length} 个 · 使用次数来自本地 messages.json 的正文统计 ·
    本页纯本地生成，不联网、不上传</div>
  <div class="grid">${cells}</div>
</body></html>`;
    // 网页与图片放同一个目录（图片用相对路径引用）。
    // --no-copy 时图片指回原始目录，网页文件名区分一下，免得和「有复制」的混起来。
    htmlPath = path.join(outDir, NO_COPY ? '表情包清单.html' : 'index.html');
    fs.writeFileSync(htmlPath, html, 'utf8');
  }

  say(`[ok] ${S.label}：${rows.length} 个表情` +
      (NO_COPY ? '（--no-copy，只写了清单）' : ` → ${path.relative(ROOT, outDir)}（复制 ${copied} 个文件，` +
        `${(bytes / 1024 / 1024).toFixed(1)} MB）`));
  const usedCount = rows.filter((r) => r.uses > 0).length;
  say(`     用过 ${usedCount} 个 · 没用过 ${rows.length - usedCount} 个` +
      (missing.length ? ` · 文件缺失 ${missing.length} 个` : ''));

  grand.sessions++;
  grand.files += copied;
  grand.bytes += bytes;
  grand.html.push(htmlPath ? path.relative(ROOT, htmlPath) : null);
}

if (grand.sessions > 1) {
  say('');
  say(`合计：${grand.sessions} 个会话 · 复制 ${grand.files} 个文件 · ${(grand.bytes / 1024 / 1024).toFixed(1)} MB`);
}
for (const h of grand.html) if (h) say(`缩略图墙：${h}`);
say('（纯本地文件操作，全程没有联网、没有上传）');
