#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
私信备份 · 图片压缩与索引迁移（P0-1）
==============================================================
把 data/images 与 bili/images 里的 jpg/png 批量转成 WebP，
**同步迁移三处索引的文件名键**，校验通过后才删除原图。

为什么不能只转码
--------------------------------------------------------------
查看页与两个索引都是**以文件名为键**的：
    · data/messages.json     → messages[].images[].local  （带目录的路径）
    · data/ocr.json / ocr.js → 键是裸文件名（img_8v3ck4.jpg）
    · data/vlm.json / vlm.js → 同上
    · data/meta.json         → peer_avatar_local / self_avatar_local
只改磁盘扩展名不改索引 → 缩略图、图内文字搜索、图片描述全部失联。

五个阶段（顺序不可调换）
--------------------------------------------------------------
  1) 扫描   找出候选图片，按体积从大到小排序
  2) 转码   逐张写成同名 .webp（先写 .tmp 再 os.replace，保证不产生半个文件）
  3) 迁移   在索引文件里做「带引号的旧文件名 → 新文件名」精确文本替换
  4) 校验   重新解析索引，断言每个键、每条 local 都指向磁盘上真实存在的文件
  5) 删除   只有校验全部通过，才删除被替换掉的原图

任何一步出错就中止，**不删任何原图**。

刻意不动的两类东西
--------------------------------------------------------------
  · GIF（49 张 / 26.5 MB）：动图转 WebP 有丢帧风险，而它只占总量 1%。
  · avatar_*.jpg（4 张）：更新脚本里头像路径是**硬编码 .jpg** 的，
    动了会让头像失联，收益又几乎为零。
  · faces/ 目录（1793 张 / 40 MB）：faces.js 按路径引用，且它不占大头。

用法
--------------------------------------------------------------
  python scripts/compress_images.py --dry-run          # 只估算，不写盘
  python scripts/compress_images.py                    # 正式压缩（默认删原图）
  python scripts/compress_images.py --limit 100        # 先拿最大的 100 张试跑
  python scripts/compress_images.py --max-edge 2048    # 再省一截（长边限 2048）
  python scripts/compress_images.py --keep-original    # 保留原图（不推荐）
  python scripts/compress_images.py --set bili
"""

import argparse
import io
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image, ImageOps

# 本机有几张 9999x9999（约 1 亿像素）的图，会触发 Pillow 的「解压炸弹」警告。
# 这些是本项目的本地备份文件，来源可信，把上限调高避免刷屏，但仍留一道保险。
Image.MAX_IMAGE_PIXELS = 300_000_000

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

# 数据集：key → 数据目录（与查看页的 SOURCES 注册表一致）
SETS = {
    'weibo': ROOT / 'data',
    'bili': ROOT / 'bili',
}

# 可转码的输入扩展名
CONVERT_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.bmp'}
# 刻意跳过的扩展名（动图保留原样）
SKIP_EXT = {'.gif'}
# 刻意跳过的文件名前缀（更新脚本里硬编码 .jpg 的头像）
SKIP_PREFIX = ('avatar_',)

# 需要迁移文件名键的索引文件（相对数据集目录）
INDEX_FILES = [
    'messages.json', 'messages.js',
    'ocr.json', 'ocr.js',
    'vlm.json', 'vlm.js',
    'meta.json',
]
# 顺带迁移的留档（万一以后用得上，保持内部一致）
RAW_FILES = ['raw/messages.bak.json', 'raw/rebuild_partial.json']

REPORT_NAME = '_compression.json'

# 超过这个像素数的图单独串行处理，避免 4 张 1 亿像素图同时解码把内存打满
HUGE_PIXELS = 40_000_000


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------
def mb(n):
    return '%.1f MB' % (n / 1048576.0)


def log(msg=''):
    print(msg, flush=True)


def load_json(p):
    with open(p, 'r', encoding='utf-8') as f:
        return json.load(f)


def atomic_write_text(p, text):
    """先写同目录临时文件再 os.replace，避免中途失败留下半个文件。"""
    tmp = p.with_name(p.name + '.tmp')
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    os.replace(tmp, p)


def html_probe(im):
    """判断图像是否带透明通道。"""
    if im.mode in ('RGBA', 'LA', 'PA'):
        return True
    if im.mode == 'P' and 'transparency' in im.info:
        return True
    return False


# --------------------------------------------------------------------------
# 阶段 1：扫描
# --------------------------------------------------------------------------
def scan(dset_dir):
    """列出候选图片，按体积从大到小排序。"""
    img_dir = dset_dir / 'images'
    if not img_dir.is_dir():
        return [], {}, 0, 0

    cands, skip_gif, skip_avatar = [], 0, 0
    for p in sorted(img_dir.iterdir()):
        if not p.is_file():
            continue
        ext = p.suffix.lower()
        if ext == '.tmp':
            continue
        if any(p.name.startswith(x) for x in SKIP_PREFIX):
            skip_avatar += 1
            continue
        if ext in SKIP_EXT:
            skip_gif += 1
            continue
        if ext in CONVERT_EXT:
            try:
                cands.append((p, p.stat().st_size))
            except OSError:
                pass

    cands.sort(key=lambda t: -t[1])
    return cands, {}, skip_gif, skip_avatar


def header_size(p):
    """只读文件头拿像素尺寸（不解码全图），用于把超大图挑出来。"""
    try:
        with Image.open(p) as im:
            return im.size
    except Exception:
        return None


# --------------------------------------------------------------------------
# 阶段 2：转码
# --------------------------------------------------------------------------
def edge_limit_for(w, h, max_edge):
    """
    这张图允许的长边上限。

    长截图（长宽比 > 2.5）放宽一倍：这类图基本是小字截图（本机只有 9 张，
    但字最怕糊），按普通照片的上限压会把字压没。
    """
    if not max_edge:
        return 0
    long_side, short_side = max(w, h), max(1, min(w, h))
    return max_edge * 2 if long_side / short_side > 2.5 else max_edge


def transcode(src, quality, max_edge, in_memory):
    """
    把一张图转成 WebP。
    in_memory=True 时返回 (bytes, (w,h))，不落盘（dry-run 用）。
    in_memory=False 时直接写 <stem>.webp，返回 (落盘字节数, (w,h))。
    """
    with Image.open(src) as im:
        lim = edge_limit_for(im.size[0], im.size[1], max_edge)

        # JPEG 专用加速：让 libjpeg 直接按 1/2、1/4、1/8 解码。
        # 本机有 745 张长边 5000~9999 的图，整张解码一次要 20 秒左右；
        # 让解码器按缩放档位出图能省掉大部分像素。必须在 load() 之前调用。
        if lim:
            try:
                im.draft('RGB', (lim, lim))
            except Exception:
                pass   # draft 只对 JPEG/MPO 有效，其它格式静默跳过

        im = ImageOps.exif_transpose(im)   # 先按 EXIF 摆正，否则方向会变
        im.load()

        if html_probe(im):
            if im.mode != 'RGBA':
                im = im.convert('RGBA')
        elif im.mode not in ('RGB', 'L'):
            im = im.convert('RGB')

        if lim and max(im.size) > lim:
            im = im.copy()
            im.thumbnail((lim, lim), Image.LANCZOS)

        expect = im.size
        kwargs = dict(format='WEBP', quality=int(quality), method=6)

        if in_memory:
            buf = io.BytesIO()
            im.save(buf, **kwargs)
            return buf.getvalue(), expect

        dst = src.with_suffix('.webp')
        tmp = dst.with_name(dst.name + '.tmp')
        im.save(str(tmp), **kwargs)
        os.replace(tmp, dst)
        return dst.stat().st_size, expect


def log_result(r):
    """逐张打印一行结果（--verbose 用）。"""
    tag = {'converted': '转码', 'resumed': '沿用', 'kept': '保留',
           'already': '已是', 'error': '失败'}.get(r['status'], r['status'])
    pct = (100.0 * (r['src_bytes'] - r['new_bytes']) / r['src_bytes']
           if r['src_bytes'] else 0)
    log('      [%s] %-28s %8s → %8s  (省 %5.1f%%) %s'
        % (tag, r['src'], mb(r['src_bytes']), mb(r['new_bytes']), pct, r['note']))


def convert_one(job, quality, max_edge, min_saving, dry):
    """返回一张图的处理结果（不抛异常，错误封装进 dict）。"""
    src, src_bytes = job
    dst = src.with_suffix('.webp')
    res = {
        'src': src.name, 'dst': dst.name, 'src_bytes': src_bytes,
        'new_bytes': 0, 'status': 'kept', 'note': '',
    }
    try:
        # 已经是 .webp 的：无需转码
        if src.suffix.lower() == '.webp':
            res['status'] = 'already'
            res['new_bytes'] = src_bytes
            return res

        # 断点续跑：同名 .webp 已存在且可用 → 直接认它
        if dst.exists() and not dry:
            try:
                with Image.open(dst) as im2:
                    if im2.format == 'WEBP':
                        n = dst.stat().st_size
                        if n < src_bytes * (1 - min_saving):
                            res.update(status='resumed', new_bytes=n)
                            return res
            except Exception:
                pass  # 坏文件，下面重转

        payload, expect = transcode(src, quality, max_edge, in_memory=dry)
        new_bytes = len(payload) if dry else payload

        # 收益太小就不换：宁可保留原图，也不做「压完更大」的蠢事
        if new_bytes >= src_bytes * (1 - min_saving):
            leftover = ''
            if not dry:
                try:
                    dst.unlink(missing_ok=True)
                except Exception:
                    # 删不掉就把残留留着（阶段 4 的孤儿检查认得这种残留），
                    # 绝不能因为「清理残留失败」把整轮索引迁移带崩。
                    leftover = '（残留 .webp 未能清理）'
            res.update(status='kept', new_bytes=new_bytes,
                       note='收益不足（%.1f%%）%s'
                            % (100.0 * (src_bytes - new_bytes) / src_bytes, leftover))
            return res

        if not dry:
            # 落地后复查：能不能正常打开、尺寸对不对、格式是不是 WebP
            with Image.open(dst) as im3:
                if im3.format != 'WEBP':
                    raise RuntimeError('落盘文件不是 WebP')
                if tuple(im3.size) != tuple(expect):
                    raise RuntimeError('尺寸不符：期望 %s 实得 %s'
                                       % (expect, im3.size))

        res.update(status='converted', new_bytes=new_bytes)
        return res
    except Exception as e:
        res.update(status='error', note='%s: %s' % (type(e).__name__, e))
        return res


# --------------------------------------------------------------------------
# 阶段 3：迁移索引里的文件名键
# --------------------------------------------------------------------------
def migrate(dset_dir, mapping):
    """
    mapping: {旧文件名: 新文件名}，只含真正变了的。

    索引里出现的形式有**两种**，必须都覆盖到：
      · 裸文件名            "img_8v3ck4.jpg"             （ocr/vlm 索引的键）
      · 带目录的完整路径    "data/images/img_8v3ck4.jpg"  （messages[].images[].local）

    ⚠ 2026-09-16 真实事故：早先的实现只编译裸名模式
      (`re.escape('"' + o + '"')`)，于是 messages.json / messages.js 里那些
      **带 data/images/ 前缀**的路径一处都没替换 —— 结果 975 个新 .webp 全成了
      孤儿，而 messages 仍指向 .jpg。幸好第 4 阶段校验把它拦了下来，原图一张没删。
      教训：改「按文件名做键」的逻辑，先 grep 一遍所有引用形态，别只想着一种。

    做法是**文本级精确替换**（带引号），不重新序列化 —— 这样能保住原文件
    的格式与字段顺序，也让 messages.json 与 messages.js 始终保持一致。
    """
    changed = []
    olds = [k for k, v in mapping.items() if k != v]
    if not olds:
        return changed

    # 一次性编译，避免对 2.5MB 的文件做 1400 次全文扫描。
    # 目录前缀写成可选的，并用 [^"]* 吃掉中间的目录层级（data/images/、bili/images/…）。
    # 备选串按长度倒序，避免短名先命中长名的前缀。
    alts = '|'.join(re.escape(o) for o in sorted(olds, key=len, reverse=True))
    pat = re.compile(r'"((?:[^"]*/)?)(' + alts + r')"')

    def repl(m):
        prefix, name = m.group(1), m.group(2)
        # 远程地址绝不动：contacts_raw.json 里有
        # "http://img.t.sinajs.cn/t6/style/images/face/xxx.png" 这类外链，
        # 它的 basename 万一撞上本地图片名，改了就成死链。
        if '://' in prefix:
            return m.group(0)
        new = mapping.get(name)
        if not new:
            return m.group(0)
        return '"' + prefix + new + '"'

    for rel in INDEX_FILES + RAW_FILES:
        p = dset_dir / rel
        if not p.is_file():
            continue
        with open(p, 'r', encoding='utf-8') as f:
            text = f.read()
        hits = []

        def count_repl(m, _hits=hits):
            out = repl(m)
            if out != m.group(0):
                _hits.append(1)
            return out

        new_text = pat.sub(count_repl, text)
        if not hits:
            continue
        atomic_write_text(p, new_text)
        changed.append((rel, len(hits)))

    return changed


# --------------------------------------------------------------------------
# 阶段 4：校验
# --------------------------------------------------------------------------
def leftover_webp(dset_dir, name):
    """
    这个 .webp 是不是「收益不足、本应删掉」的残留？

    convert_one 在收益不足时会把刚生成的 dst.unlink() 掉。但若删除被外部拦下
    （本项目实测：WorkBuddy 的批量删除保护会拦删除动作并中止进程），
    .webp 就留在了盘上，且 messages 引用的是原图 → 它会被孤儿检查误报。
    判定办法：同名的原图还在，且这个 .webp 并不比原图小。
    真 bug（索引漏迁移）的特征恰好相反 —— .webp 明显更小却没被引用，仍会被抓住。
    """
    p = dset_dir / 'images' / name
    if p.suffix.lower() != '.webp':
        return False
    for ext in CONVERT_EXT - {'.webp'}:
        q = p.with_suffix(ext)
        if q.is_file():
            try:
                return p.stat().st_size >= q.stat().st_size
            except OSError:
                return False
    return False


def verify(dset_dir, label, before, pending=None):
    """
    重新解析索引，断言一切都指向真实存在的文件。返回问题列表。

    pending: 本次「即将删除的原图」文件名集合。
    校验发生在**删除之前**，此刻磁盘上原图与新 .webp 并存；
    迁移完成后 messages 引用的是 .webp，于是原图会看起来像「没人引用的孤儿」。
    它们只是还没删，不算问题 —— 所以要从孤儿检查里排除掉。
    """
    errs = []
    pending = pending or set()
    img_dir = dset_dir / 'images'
    on_disk = {p.name for p in img_dir.iterdir() if p.is_file()} \
        if img_dir.is_dir() else set()

    # 4.1 messages.json：条数不变 + 每条 local 都存在
    mj = dset_dir / 'messages.json'
    try:
        msgs = load_json(mj)
    except Exception as e:
        return ['%s：messages.json 解析失败 %s' % (label, e)]
    if len(msgs) != before['messages']:
        errs.append('%s：messages 条数变了 %d → %d'
                    % (label, before['messages'], len(msgs)))

    n_ref, miss = 0, []
    for m in msgs:
        for im in (m.get('images') or []):
            loc = im.get('local')
            if not loc:
                continue
            n_ref += 1
            base = loc.split('/')[-1]
            if base not in on_disk:
                miss.append(loc)
    if miss:
        errs.append('%s：%d 条图片引用在磁盘上找不到，例如 %s'
                    % (label, len(miss), miss[:5]))

    # 4.2 messages.js 与 messages.json 的图片引用完全一致
    js = dset_dir / 'messages.js'
    if js.is_file():
        text = js.read_text(encoding='utf-8')
        js_locals = set(re.findall(r'"local":"([^"]+)"', text))
        json_locals = set()
        for m in msgs:
            for im in (m.get('images') or []):
                if im.get('local'):
                    json_locals.add(im['local'])
        only_js = js_locals - json_locals
        only_json = json_locals - js_locals
        if only_js or only_json:
            errs.append('%s：messages.js 与 messages.json 的图片路径不一致'
                        '（仅 js %d 个，仅 json %d 个）'
                        % (label, len(only_js), len(only_json)))

    # 4.3 ocr / vlm 索引：键数不变 + 键都能在磁盘找到
    for kind, fname in (('ocr', 'ocr.json'), ('vlm', 'vlm.json')):
        p = dset_dir / fname
        if not p.is_file():
            continue
        try:
            idx = load_json(p)
        except Exception as e:
            errs.append('%s：%s 解析失败 %s' % (label, fname, e))
            continue
        keys = [k for k in idx if not k.startswith('_')]
        if len(keys) != before[kind]:
            errs.append('%s：%s 有效键数变了 %d → %d'
                        % (label, fname, before[kind], len(keys)))
        bad = [k for k in keys if k not in on_disk]
        if bad:
            errs.append('%s：%s 有 %d 个键指向不存在的文件，例如 %s'
                        % (label, fname, len(bad), bad[:5]))

        # 对应的 .js 包装也要能解析出同样的键
        jsf = dset_dir / fname.replace('.json', '.js')
        if jsf.is_file():
            jt = jsf.read_text(encoding='utf-8')
            js_keys = set(re.findall(r'"([^"\\]+\.(?:jpg|jpeg|png|webp|bmp|gif))":', jt))
            missing_in_js = set(keys) - js_keys
            if missing_in_js:
                errs.append('%s：%s 里的 %d 个键在对应 .js 中找不到，例如 %s'
                            % (label, fname, len(missing_in_js),
                               sorted(missing_in_js)[:5]))

    # 4.4 孤儿文件（不是本次引入的，但顺手报一下）
    # ⚠ 这里的 ref **只能**取 messages 的引用，绝不能把 ocr/vlm 的键也算进来。
    # 否则「messages.json 漏迁移」这个 bug 就再也抓不住了：那次事故里
    # ocr/vlm 的键是迁移成功的（指向真实存在的 .webp），一旦算作"已引用"，
    # 4.1/4.2/4.3/4.4 四条检查会全部通过 → 原图被删 → messages 指向已删除的 .jpg。
    ref = set()
    for m in msgs:
        for im in (m.get('images') or []):
            if im.get('local'):
                ref.add(im['local'].split('/')[-1])

    orphan = [n for n in sorted(on_disk)
              if n not in ref
              and n not in pending
              and not n.startswith(SKIP_PREFIX)
              and (dset_dir / 'images' / n).suffix.lower() in CONVERT_EXT | SKIP_EXT
              and not leftover_webp(dset_dir, n)]
    if orphan:
        errs.append('%s：有 %d 个图片文件没有被任何消息引用（孤儿），例如 %s'
                    % (label, len(orphan), orphan[:5]))

    return errs


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def process_set(key, dset_dir, args):
    log('')
    log('=' * 66)
    log('数据集 %s  →  %s' % (key, dset_dir))
    log('=' * 66)

    if not (dset_dir / 'images').is_dir():
        log('  找不到 images 目录，跳过')
        return None

    cands, _, skip_gif, skip_avatar = scan(dset_dir)
    total_before = sum(s for _, s in cands)

    log('  候选图片 %d 张，合计 %s' % (len(cands), mb(total_before)))
    log('  跳过：GIF %d 张（保留动图）· 头像 %d 张（更新脚本硬编码 .jpg）'
        % (skip_gif, skip_avatar))

    if args.limit and len(cands) > args.limit:
        cands = cands[:args.limit]
        log('  --limit %d：只处理最大的 %d 张（合计 %s）'
            % (args.limit, len(cands), mb(sum(s for _, s in cands))))
    elif args.sample and len(cands) > args.sample:
        # 跨尺寸分层抽样：从大到小均匀取点，避免只抽到 1 亿像素那几张
        n = len(cands)
        idx = sorted({round(i * (n - 1) / (args.sample - 1))
                      for i in range(args.sample)}) if args.sample > 1 else [0]
        cands = [cands[i] for i in idx]
        log('  --sample %d：跨尺寸抽样 %d 张（合计 %s）'
            % (args.sample, len(cands), mb(sum(s for _, s in cands))))

    # 限量 / 抽样之后剩下的才是「本次真正要处理的东西」。
    # 收益统计必须用它 —— 否则会出现「before 是全量、after 只有抽样」，
    # 算出「可省 100%」这种假数字。
    total_before = sum(s for _, s in cands)

    # 记录迁移前的基线，供校验对比
    before = {}
    try:
        before['messages'] = len(load_json(dset_dir / 'messages.json'))
    except Exception:
        before['messages'] = -1
    for kind, fname in (('ocr', 'ocr.json'), ('vlm', 'vlm.json')):
        try:
            idx = load_json(dset_dir / fname)
            before[kind] = len([k for k in idx if not k.startswith('_')])
        except Exception:
            before[kind] = -1

    # 超大图挑出来串行处理，普通图走线程池
    normal, huge = [], []
    for job in cands:
        wh = header_size(job[0])
        if wh and wh[0] * wh[1] >= HUGE_PIXELS:
            huge.append(job)
        else:
            normal.append(job)

    log('  其中超大图（≥%d 万像素）%d 张，将串行处理' % (HUGE_PIXELS // 10000, len(huge)))
    log('  开始转码（quality=%s，长边上限=%s，%s）…'
        % (args.quality, args.max_edge or '不限',
           '仅估算不写盘' if args.dry_run else '写盘'))

    t0 = time.time()
    results = []
    done = 0

    step = 10 if len(cands) <= 200 else 50

    def progress():
        if done and done % step == 0:
            log('    … 已完成 %d / %d（%.0fs）' % (done, len(cands), time.time() - t0))

    if normal:
        with ThreadPoolExecutor(max_workers=args.jobs) as ex:
            futs = [ex.submit(convert_one, j, args.quality, args.max_edge,
                              args.min_saving, args.dry_run) for j in normal]
            for f in as_completed(futs):
                r = f.result()
                results.append(r)
                done += 1
                if args.verbose:
                    log_result(r)
                progress()
    for j in huge:
        r = convert_one(j, args.quality, args.max_edge,
                        args.min_saving, args.dry_run)
        results.append(r)
        done += 1
        if args.verbose:
            log_result(r)
        progress()

    elapsed = time.time() - t0
    by = {}
    for r in results:
        by[r['status']] = by.get(r['status'], 0) + 1

    converted = [r for r in results if r['status'] in ('converted', 'resumed')]
    after_bytes = sum(r['new_bytes'] for r in results)
    saved = total_before - after_bytes

    log('')
    log('  转码完成：%.0fs' % elapsed)
    log('    成功转码 %d · 续跑沿用 %d · 保留原图 %d · 已是 webp %d · 失败 %d'
        % (by.get('converted', 0), by.get('resumed', 0), by.get('kept', 0),
           by.get('already', 0), by.get('error', 0)))
    log('    体积 %s → %s（可省 %s，%.0f%%）'
        % (mb(total_before), mb(after_bytes), mb(saved),
           100.0 * saved / total_before if total_before else 0))

    errs_conv = [r for r in results if r['status'] == 'error']
    if errs_conv:
        log('')
        log('  ⚠ 转码失败 %d 张（这些会保留原图）：' % len(errs_conv))
        for r in errs_conv[:10]:
            log('      %s  %s' % (r['src'], r['note']))

    if args.dry_run:
        log('')
        log('  [--dry-run] 未写入任何文件，也未改动索引。')
        return {
            'dry_run': True, 'candidates': len(cands),
            'bytes_before': total_before, 'bytes_after': after_bytes,
            'saved': saved, 'status': by, 'seconds': round(elapsed, 1),
        }

    # ---- 阶段 3：迁移索引 ----
    mapping = {r['src']: r['dst'] for r in converted}
    log('')
    log('  迁移索引里的文件名键（%d 个）…' % len(mapping))
    changed = migrate(dset_dir, mapping)
    if changed:
        for rel, n in changed:
            log('    %-28s 替换 %d 处' % (rel, n))
    else:
        log('    索引里没有需要替换的名字（可能都已迁移过）')

    # ---- 阶段 4：校验 ----
    log('')
    log('  校验索引与磁盘的一致性…')
    # pending：本次即将删除的原图。校验在删除之前跑，此刻原图与 .webp 并存，
    # 迁移已生效 → 原图会被误判成孤儿，所以显式排除。
    pending = {r['src'] for r in converted}
    errs = verify(dset_dir, key, before, pending)
    if errs:
        log('')
        log('  ❌ 校验未通过，**不会删除任何原图**：')
        for e in errs:
            log('      · %s' % e)
        log('')
        log('  处理方式：索引已迁移但原图仍在，属于可恢复状态。')
        log('  请修好后重跑（重跑会自动沿用已生成的 .webp）。')
        return None

    log('  ✅ 校验通过：messages 条数一致，所有索引键与图片引用都指向真实文件')

    # ---- 阶段 5：删除原图 ----
    failed = []
    if args.keep_original:
        log('')
        log('  --keep-original：保留全部原图，不删除。')
        deleted = 0
    else:
        deleted = 0
        freed = 0
        for r in converted:
            src = dset_dir / 'images' / r['src']
            if src.suffix.lower() == '.webp':
                continue
            try:
                size = src.stat().st_size
            except OSError:
                continue          # 已经不在了（上一轮删过），跳过即可
            try:
                src.unlink()
                deleted += 1
                freed += size
            except Exception as e:
                # 外部环境可能拦删除（本机实测：WorkBuddy 沙箱的批量删除保护
                # 默认上限 50 个/轮，超出就直接中止进程）。这里逐张记账、
                # 不抛出去 —— 索引与校验都已经通过了，不该被清理动作带崩。
                failed.append((r['src'], '%s: %s' % (type(e).__name__, e)))
        log('')
        log('  已删除原图 %d 张，回收 %s' % (deleted, mb(freed)))
        if failed:
            log('')
            log('  ⚠ 有 %d 张原图没能删除（**索引与校验均已通过，页面照常好用**）：'
                % len(failed))
            for n, why in failed[:5]:
                log('      %s  %s' % (n, why[:90]))
            if len(failed) > 5:
                log('      …其余 %d 张同理' % (len(failed) - 5))
            log('')
            log('  常见原因：当前运行环境有「批量删除保护」。')
            log('  处理办法：在**普通命令行窗口**里重跑本脚本（双击「压缩图片.cmd」），')
            log('            已转码的会直接沿用，只会继续删没删掉的那部分。')

    # ---- 写压缩报告 ----
    report = {
        '_meta': {
            'tool': 'compress_images.py',
            'version': 1,
            'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'quality': args.quality, 'max_edge': args.max_edge,
            'min_saving': args.min_saving, 'keep_original': args.keep_original,
        },
        'set': key,
        'candidates': len(cands),
        'status': by,
        'skipped_gif': skip_gif,
        'skipped_avatar': skip_avatar,
        'bytes_before': total_before,
        'bytes_after': after_bytes,
        'saved': saved,
        'deleted': deleted,
        'delete_failed': len(failed),
        'seconds': round(elapsed, 1),
        'mapping': mapping,          # 旧名 → 新名（只含真正变了的）
        'failures': [{'src': r['src'], 'note': r['note']} for r in errs_conv],
    }
    atomic_write_text(dset_dir / REPORT_NAME, json.dumps(report, ensure_ascii=False))
    log('  报告已写入 %s' % (dset_dir / REPORT_NAME))

    # 磁盘实况
    after_disk = sum(p.stat().st_size for p in (dset_dir / 'images').iterdir()
                     if p.is_file())
    log('  images 目录当前实际占用：%s' % mb(after_disk))

    return report


def main():
    ap = argparse.ArgumentParser(
        description='把私信备份里的图片批量转成 WebP，并同步迁移索引文件名键')
    ap.add_argument('--set', default='all', choices=['weibo', 'bili', 'all'],
                    help='处理哪套数据集（默认 all）')
    ap.add_argument('--dry-run', action='store_true',
                    help='只估算收益，不写盘、不改索引、不删原图')
    ap.add_argument('--limit', type=int, default=0,
                    help='只处理体积最大的 N 张（试跑用）')
    ap.add_argument('--sample', type=int, default=0,
                    help='跨尺寸均匀抽样 N 张（试跑用，比 --limit 更有代表性）')
    ap.add_argument('--verbose', action='store_true',
                    help='逐张打印处理结果')
    ap.add_argument('--quality', type=int, default=82,
                    help='WebP 质量，默认 82（肉眼无损档）')
    ap.add_argument('--max-edge', type=int, default=0,
                    help='长边上限像素，0=保持原尺寸（默认）。设 2048 可再省一大截')
    ap.add_argument('--min-saving', type=float, default=0.005,
                    help='至少省这么多比例才替换，默认 0.005（0.5%%）')
    ap.add_argument('--jobs', type=int, default=3,
                    help='并发线程数，默认 3（内存吃紧就别调大）')
    ap.add_argument('--keep-original', action='store_true',
                    help='保留原图（默认转换成功且校验通过后删除原图）')
    args = ap.parse_args()

    targets = list(SETS) if args.set == 'all' else [args.set]

    log('私信备份 · 图片压缩与索引迁移')
    log('  Python  %s' % sys.version.split()[0])
    log('  参数    quality=%s  max_edge=%s  min_saving=%s  jobs=%s'
        % (args.quality, args.max_edge, args.min_saving, args.jobs))
    log('  模式    %s' % ('DRY-RUN（不写盘）' if args.dry_run
                          else ('压缩并保留原图' if args.keep_original
                                else '压缩 → 校验 → 删除原图')))
    log('  数据集  %s' % ', '.join(targets))

    t_all = time.time()
    reports = {}
    for key in targets:
        r = process_set(key, SETS[key], args)
        if r is None and not args.dry_run:
            log('')
            log('数据集 %s 未完成，中止后续数据集。' % key)
            return 2
        reports[key] = r

    log('')
    log('=' * 66)
    log('汇总')
    log('=' * 66)
    tb = ta = 0
    n_del_fail = 0
    for key, r in reports.items():
        if not r:
            continue
        tb += r['bytes_before']
        ta += r['bytes_after']
        n_del_fail += r.get('delete_failed', 0)
        log('  %-6s %s → %s（省 %s，%.0f%%）'
            % (key, mb(r['bytes_before']), mb(r['bytes_after']),
               mb(r['saved']),
               100.0 * r['saved'] / r['bytes_before'] if r['bytes_before'] else 0))
    if tb:
        log('  %-6s %s → %s（省 %s，%.0f%%）'
            % ('合计', mb(tb), mb(ta), mb(tb - ta), 100.0 * (tb - ta) / tb))
    log('  总耗时 %.0fs' % (time.time() - t_all))
    if n_del_fail:
        log('')
        log('  ⚠ 合计 %d 张原图没能删除 —— 索引与校验都已通过，页面照常好用。' % n_del_fail)
        log('    请在**普通命令行窗口**里重跑一次（双击「压缩图片.cmd」）把删除做完。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
