#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
压缩前的画质闸门：拿「图内文字搜索」的识别结果当尺子量。
==============================================================
本机备份里的图片，最有价值的信息是截图里的字（查看页支持「图内文字搜索」）。
所以在删原图之前，先实测一遍：**同一张图，压缩前后 OCR 出来的文字差多少**。

挑的是索引里文字最多的那几张（最能暴露画质损失）。
相似度用 difflib 算字符级比例，1.0 = 一字不差。

用法：
  python scripts/_explore/probe_quality.py                    # q82 长边 2048，4 张
  python scripts/_explore/probe_quality.py --n 8 --quality 82 --max-edge 2048
  python scripts/_explore/probe_quality.py --set bili
"""
import argparse
import difflib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 300_000_000

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

SETS = {'weibo': ROOT / 'data', 'bili': ROOT / 'bili'}


def edge_limit_for(w, h, max_edge):
    """和 compress_images.py 保持一致：长截图放宽一倍，别把字压没。"""
    if not max_edge:
        return 0
    long_side, short_side = max(w, h), max(1, min(w, h))
    return max_edge * 2 if long_side / short_side > 2.5 else max_edge


def compress(src, dst, quality, max_edge):
    with Image.open(src) as im:
        lim = edge_limit_for(im.size[0], im.size[1], max_edge)
        if lim:
            try:
                im.draft('RGB', (lim, lim))
            except Exception:
                pass
        im = ImageOps.exif_transpose(im)
        im.load()
        if im.mode not in ('RGB', 'L'):
            im = im.convert('RGB')
        if lim and max(im.size) > lim:
            im = im.copy()
            im.thumbnail((lim, lim), Image.LANCZOS)
        im.save(str(dst), format='WEBP', quality=int(quality), method=6)
        return im.size


def ocr_text(engine, path):
    """兼容新旧两种 RapidOCR 返回结构（新版是 RapidOCROutput，带 .txts）"""
    res = engine(str(path))
    if hasattr(res, 'txts'):                       # 新版 RapidOCROutput
        return '\n'.join(t for t in (getattr(res, 'txts', None) or [])
                         if isinstance(t, str))
    body = res[0] if isinstance(res, tuple) else res   # 旧版 (result, elapse)
    parts = []
    for item in (body or []):
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            t = item[1]
            if isinstance(t, str):
                parts.append(t)
    return '\n'.join(parts)


def norm(s):
    return ''.join(ch for ch in (s or '') if not ch.isspace())


def ratio(a, b):
    """
    相似度。**必须关掉 autojunk** —— difflib 默认会把「出现次数超过序列长度 1%」
    的元素当成噪声丢掉，而中文文本里常用字很容易超过 1%，会算出完全失真的分数
    （实测同一对字符串能算出 0.26，其实内容几乎一致）。
    """
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def sim_content(a, b):
    """
    与「阅读顺序」无关的内容相似度。

    为什么要这么算：RapidOCR 在大图和缩小后的图上，检测框的排序会变
    （同一张图，原图↔压缩后 的普通相似度可能只有 0.3，但两边字符完全一样）。
    把字符排序后再比，比的就是「认出来的字有没有变」，不受顺序干扰。
    """
    return ratio(''.join(sorted(a)), ''.join(sorted(b)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', default='weibo', choices=sorted(SETS.keys()))
    ap.add_argument('--n', type=int, default=4, help='测几张（取文字最多的）')
    ap.add_argument('--quality', type=int, default=82)
    ap.add_argument('--max-edge', type=int, default=2048)
    args = ap.parse_args()

    d = SETS[args.set]
    idx = json.load(open(d / 'ocr.json', encoding='utf-8'))
    rows = []
    for k, v in idx.items():
        if k.startswith('_') or not isinstance(v, dict):
            continue
        t = norm(v.get('t') or '')
        if len(t) >= 40:
            rows.append((len(t), k, t))
    rows.sort(reverse=True)
    if not rows:
        print('没有带文字的图片，跳过')
        return 0
    picks = rows[:args.n]
    print('数据集 %s：候选 %d 张带文字图，取文字最多的 %d 张' % (args.set, len(rows), len(picks)))
    print('参数：quality=%s  max_edge=%s（长截图放宽到 %s）'
          % (args.quality, args.max_edge, args.max_edge * 2))
    print('=' * 66)

    from rapidocr import RapidOCR
    engine = RapidOCR()

    tmpdir = Path(tempfile.mkdtemp(prefix='dm-q-'))
    # worst：原图 vs 压缩后，两边都用同一套「整图识别」方法 —— 这才是画质损失的真指标
    # worst_idx：压缩后 vs 索引里现存的文字。长截图在索引里是分段识别的，
    #            跟整图识别天生对不齐，所以只作参考、不作判据。
    worst = worst_idx = 1.0
    tot_o = tot_c = 0
    for n, (ln, key, old_txt) in enumerate(picks, 1):
        src = d / 'images' / key
        if not src.exists():
            print('%2d. %-30s 源文件不在，跳过' % (n, key))
            continue
        dst = tmpdir / (src.stem + '.webp')
        size = compress(src, dst, args.quality, args.max_edge)
        ob, cb = src.stat().st_size, dst.stat().st_size
        tot_o += ob
        tot_c += cb
        new_txt = norm(ocr_text(engine, dst))
        # 原图用同样方法识别两遍：两遍之间的相似度就是「识别器自身的抖动」
        raw1 = norm(ocr_text(engine, src))
        raw2 = norm(ocr_text(engine, src))
        selfsim = ratio(raw1, raw2)
        sim_idx = ratio(old_txt, new_txt)
        sim_ord = ratio(raw1, new_txt)
        sim_cnt = sim_content(raw1, new_txt)      # 判据：与顺序无关的内容相似度
        worst = min(worst, sim_cnt)
        worst_idx = min(worst_idx, sim_idx)
        print('%2d. %-30s 压缩后 %sx%s  %7s → %7s  省 %4.0f%%'
              % (n, key, size[0], size[1],
                  '%.2fMB' % (ob / 1048576), '%.2fMB' % (cb / 1048576),
                  100 * (1 - cb / ob)))
        print('      文字长度：原图识别 %d / %d　压缩后 %d（索引里存的是 %d）'
              % (len(raw1), len(raw2), len(new_txt), len(old_txt)))
        print('      原图自比对 %.3f（识别器稳定性）' % selfsim)
        print('      内容相似度 %.3f（与顺序无关，判据）｜ 顺序敏感 %.3f ｜ 对比索引 %.3f'
              % (sim_cnt, sim_ord, sim_idx))
        print('      压缩后识别出的前 60 字：%s' % (new_txt[:60] or '（没识别出文字！）'))
        print('')

    print('=' * 66)
    print('内容相似度（与顺序无关）最低 %.3f ｜ 对比索引最低 %.3f'
          % (worst, worst_idx))
    print('判据说明：OCR 在大图与缩小图上检测框排序会变，所以用「排序后比较」排除顺序干扰；'
          '索引那一栏只作参考（索引是分段识别出来的，跟整图识别天生对不齐）。')
    print('体积合计 %.2fMB → %.2fMB（省 %.0f%%）'
          % (tot_o / 1048576, tot_c / 1048576,
             100 * (1 - tot_c / tot_o) if tot_o else 0))
    if worst >= 0.95:
        print('结论：压缩后文字内容基本无损，「图内文字搜索」不受影响 —— 可以删原图。')
    elif worst >= 0.88:
        print('结论：文字基本保留，个别字有出入。可以接受；想更稳就再提高 quality。')
    else:
        print('结论：⚠ 文字损失明显，先别删原图 —— 调高 quality 或放宽 max_edge。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
