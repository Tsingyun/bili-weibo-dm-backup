# -*- coding: utf-8 -*-
"""
只读诊断：抽样转码，量出「图片压缩」到底能省多少磁盘。
不修改任何原始文件，输出全部落在系统临时目录，跑完即删。

用法：
    .ocr-env/Scripts/python.exe scripts/_explore/probe_webp_gain.py [每层样本数]

为什么用「分层抽样」：
    图片体积分布极偏（均 1.99MB，最大 95MB）。若随机抽，小图占多数会低估收益；
    若把大图全取，又会高估收益（大图恰恰压得最狠）。
    所以按体积分层各抽 N 个 → 算出「每层各自的压缩率」→ 再按全量里各层的
    真实字节数加权，得到无偏估计。

输出三个方案：
    A. WebP q82，原尺寸        —— 画质无损感知，适合存档
    B. WebP q78，长边限 2560   —— 2K 屏够看，适合浏览
    C. WebP q78，长边限 2048   —— 更省，适合手机/网页
"""
import os, sys, random, glob, tempfile, shutil
from PIL import Image

Image.MAX_IMAGE_PIXELS = None          # 本项目有 1 亿像素大图，关掉炸弹告警

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIRS = ['data/images', 'bili/images']
N = int(sys.argv[1]) if len(sys.argv) > 1 else 25

STRATA = [(0, 200 * 1024, '<200KB'),
          (200 * 1024, 1024 * 1024, '200KB-1MB'),
          (1024 * 1024, 5 * 1024 * 1024, '1-5MB'),
          (5 * 1024 * 1024, float('inf'), '>=5MB')]

PLANS = [('A. WebP q82 原尺寸', 82, None),
         ('B. WebP q78 长边限 2560', 78, 2560),
         ('C. WebP q78 长边限 2048', 78, 2048)]


def collect():
    files = []
    for d in DIRS:
        for f in glob.glob(os.path.join(ROOT, d, '*')):
            try:
                files.append((os.path.getsize(f), f))
            except OSError:
                pass
    return files


def stratum_of(size):
    for i, (lo, hi, _) in enumerate(STRATA):
        if lo <= size < hi:
            return i
    return len(STRATA) - 1


def encode(src, dst, q, maxside):
    im = Image.open(src)
    im.load()
    if maxside:
        w, h = im.size
        if max(w, h) > maxside:
            k = maxside / float(max(w, h))
            im = im.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)
    if im.mode not in ('RGB', 'RGBA'):
        im = im.convert('RGBA' if 'A' in im.mode else 'RGB')
    im.save(dst, 'WEBP', quality=q, method=4)
    return os.path.getsize(dst)


def main():
    allf = collect()
    total_bytes = sum(s for s, _ in allf)
    groups = [[] for _ in STRATA]
    for s, f in allf:
        groups[stratum_of(s)].append((s, f))

    random.seed(20260915)
    print('全量：%d 个文件，%.0f MB' % (len(allf), total_bytes / 1048576.0))
    print('分层抽样：每层最多 %d 个' % N)
    print()
    print('%-12s %6s %10s   %s' % ('体积层', '总数', '该层体积', '抽样数'))
    print('-' * 56)
    picked = []
    for i, (lo, hi, name) in enumerate(STRATA):
        g = groups[i]
        random.shuffle(g)
        pick = g[:N]
        picked.append(pick)
        print('%-12s %6d %8.0f MB   %d' % (name, len(g), sum(s for s, _ in g) / 1048576.0, len(pick)))

    tmp = tempfile.mkdtemp(prefix='webp_probe_')
    print()
    print('=== 各层实测压缩率 ===')
    header = '%-12s' % '体积层' + ''.join('%22s' % p[0] for p in PLANS)
    print(header)
    print('-' * (12 + 22 * len(PLANS)))
    ratios = {i: {} for i in range(len(STRATA))}
    for i, (lo, hi, name) in enumerate(STRATA):
        pick = picked[i]
        if not pick:
            continue
        orig = sum(s for s, _ in pick)
        row = '%-12s' % name
        for pi, (pname, q, ms) in enumerate(PLANS):
            got = 0
            for s, f in pick:
                dst = os.path.join(tmp, 'p.webp')
                try:
                    got += encode(f, dst, q, ms)
                except Exception:
                    got += s          # 转码失败按原样计入，不虚报收益
            r = got / float(orig)
            ratios[i][pi] = r
            row += '%21.0f%%' % (r * 100)
        print(row)

    print()
    print('=== 加权外推（按全量各层真实字节加权）===')
    print('%-26s %14s %8s' % ('方案', '外推总体积', '相对当前'))
    print('-' * 52)
    for pi, (pname, q, ms) in enumerate(PLANS):
        est = 0.0
        for i, (lo, hi, name) in enumerate(STRATA):
            if not groups[i] or pi not in ratios[i]:
                continue
            est += sum(s for s, _ in groups[i]) * ratios[i][pi]
        print('%-26s %11.0f MB %7.0f%%' % (pname, est / 1048576.0, est / total_bytes * 100))
    print()
    print('对比：当前两套图片合计 %.0f MB（微博 %.0f MB + B站 %.0f MB）' % (
        total_bytes / 1048576.0,
        sum(s for s, _ in glob.glob(os.path.join(ROOT, 'data/images', '*'))) / 1048576.0 if False else
        sum(os.path.getsize(f) for f in glob.glob(os.path.join(ROOT, 'data/images', '*'))) / 1048576.0,
        sum(os.path.getsize(f) for f in glob.glob(os.path.join(ROOT, 'bili/images', '*'))) / 1048576.0))
    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
