#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
压缩前的成本探测：只读文件头，不解码全图。
==============================================================
回答两个问题：
  1) 有多少张图大到会拖慢压缩（≥40MP 的「超大图」）？
  2) 长边超过某个阈值的有多少张、占多少体积？（决定要不要 --max-edge）

用法：
  python scripts/_explore/probe_huge.py
  python scripts/_explore/probe_huge.py --max-edge 2048
"""
import argparse
import os
import sys
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = 300_000_000

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

SETS = {'weibo': ROOT / 'data', 'bili': ROOT / 'bili'}
EXT = {'.jpg', '.jpeg', '.png', '.webp', '.bmp'}
SKIP_PREFIX = ('avatar_',)
HUGE = 40_000_000


def mb(n):
    return '%.1f MB' % (n / 1048576.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max-edge', type=int, default=2048)
    args = ap.parse_args()

    for key, d in SETS.items():
        img = d / 'images'
        if not img.is_dir():
            continue
        files = [p for p in sorted(img.iterdir())
                 if p.is_file() and p.suffix.lower() in EXT
                 and not p.name.startswith(SKIP_PREFIX)]
        total = sum(p.stat().st_size for p in files)
        print('=' * 62)
        print('%s：%d 张，%s' % (key, len(files), mb(total)))
        print('=' * 62)

        buckets = {}
        huge_n = huge_b = 0
        over_n = over_b = 0
        unreadable = []
        for p in files:
            size = p.stat().st_size
            try:
                with Image.open(p) as im:
                    w, h = im.size
                    fmt = im.format
            except Exception as e:
                unreadable.append((p.name, str(e)[:40]))
                continue
            px = w * h
            if px >= HUGE:
                huge_n += 1
                huge_b += size
            if max(w, h) > args.max_edge:
                over_n += 1
                over_b += size
            # 按「万像素」分档
            k = min(int(px // 10_000_000), 10)
            b = buckets.setdefault(k, [0, 0])
            b[0] += 1
            b[1] += size

        print('  像素分档（×1000 万像素）:')
        for k in sorted(buckets):
            n, by = buckets[k]
            label = ('>=1 亿' if k >= 10 else '%d~%d 千万' % (k, k + 1))
            print('    %-12s %5d 张  %10s' % (label, n, mb(by)))
        print('  ≥4000 万像素（串行处理，最慢）: %d 张  %s' % (huge_n, mb(huge_b)))
        print('  长边 > %d（会被 --max-edge 缩放）: %d 张  %s'
              % (args.max_edge, over_n, mb(over_b)))
        if unreadable:
            print('  读不出尺寸的 %d 个，例如 %s' % (len(unreadable), unreadable[:3]))
        print('')
    return 0


if __name__ == '__main__':
    sys.exit(main())
