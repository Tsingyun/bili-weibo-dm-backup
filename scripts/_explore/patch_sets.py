# -*- coding: utf-8 -*-
"""给 image_ocr.py / image_vlm.py 增加 --set weibo|bili 双数据集支持。"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

OCR_SETS = '''# ---- 数据集切换：--set weibo（默认，data/）或 --set bili（bili/） ----------------
SETS = {
    'weibo': {'dir': 'data', 'js': 'DM_OCR',   'skip': ('pic_', 'emoji_', 'avatar_')},
    'bili':  {'dir': 'bili', 'js': 'DM_OCR_B', 'skip': ('face_', 'avatar_', 'emoji_')},
}
IMGDIR = OCRJSON = OCRJS = ''
SKIP_PREFIX = SETS['weibo']['skip']
JS_GLOBAL = SETS['weibo']['js']


def use_set(name):
    """切换数据集：目录、导出全局名、跳过前缀一起换"""
    global IMGDIR, OCRJSON, OCRJS, SKIP_PREFIX, JS_GLOBAL
    cfg = SETS[name]
    IMGDIR = os.path.join(ROOT, cfg['dir'], 'images')
    OCRJSON = os.path.join(ROOT, cfg['dir'], 'ocr.json')
    OCRJS = os.path.join(ROOT, cfg['dir'], 'ocr.js')
    SKIP_PREFIX = cfg['skip']
    JS_GLOBAL = cfg['js']
    os.makedirs(IMGDIR, exist_ok=True)


use_set('weibo')
'''

VLM_SETS = '''# ---- 数据集切换：--set weibo（默认，data/）或 --set bili（bili/） ----------------
SETS = {
    'weibo': {'dir': 'data', 'js': 'DM_VLM',   'skip': ('pic_', 'emoji_', 'avatar_')},
    'bili':  {'dir': 'bili', 'js': 'DM_VLM_B', 'skip': ('face_', 'avatar_', 'emoji_')},
}
IMGDIR = OCRJSON = VLMJSON = VLMJS = ''
SKIP_PREFIX = SETS['weibo']['skip']
JS_GLOBAL = SETS['weibo']['js']


def use_set(name):
    """切换数据集：目录、导出全局名、跳过前缀一起换"""
    global IMGDIR, OCRJSON, VLMJSON, VLMJS, SKIP_PREFIX, JS_GLOBAL
    cfg = SETS[name]
    IMGDIR = os.path.join(ROOT, cfg['dir'], 'images')
    OCRJSON = os.path.join(ROOT, cfg['dir'], 'ocr.json')
    VLMJSON = os.path.join(ROOT, cfg['dir'], 'vlm.json')
    VLMJS = os.path.join(ROOT, cfg['dir'], 'vlm.js')
    SKIP_PREFIX = cfg['skip']
    JS_GLOBAL = cfg['js']
    os.makedirs(IMGDIR, exist_ok=True)


use_set('weibo')
'''


def patch(fname, old_block, new_block, more):
    p = os.path.join(ROOT, 'scripts', fname)
    t = io.open(p, encoding='utf-8').read()
    assert t.count(old_block) == 1, f'{fname}: 头部块匹配 {t.count(old_block)} 次'
    t = t.replace(old_block, new_block)
    for old, new, cnt in more:
        c = t.count(old)
        assert c == cnt, f'{fname}: {old[:50]!r} 匹配 {c} 次（期望 {cnt}）'
        t = t.replace(old, new, cnt)
    io.open(p, 'w', encoding='utf-8', newline='').write(t)
    print(f'  [ok] {fname}')


# ---------------- image_ocr.py ----------------
patch(
    'image_ocr.py',
    """IMGDIR = os.path.join(ROOT, 'data', 'images')
OCRJSON = os.path.join(ROOT, 'data', 'ocr.json')
OCRJS = os.path.join(ROOT, 'data', 'ocr.js')

SKIP_PREFIX = ('pic_', 'emoji_', 'avatar_')   # 动画表情 / 表情包 / 头像
""",
    OCR_SETS,
    [
        # 导出的全局名跟着数据集走
        ("        f.write('window.DM_OCR=')",
         "        f.write('window.' + JS_GLOBAL + '=')", 1),
        # 新增 --set 参数
        ("    ap.add_argument('--quiet', action='store_true', help='不打印明细')\n    args = ap.parse_args()",
         "    ap.add_argument('--quiet', action='store_true', help='不打印明细')\n"
         "    ap.add_argument('--set', choices=['weibo', 'bili'], default='weibo',\n"
         "                    help='数据集：weibo = data/，bili = bili/')\n"
         "    args = ap.parse_args()\n"
         "    use_set(args.set)", 1),
    ])

# ---------------- image_vlm.py ----------------
patch(
    'image_vlm.py',
    """IMGDIR = os.path.join(ROOT, 'data', 'images')
OCRJSON = os.path.join(ROOT, 'data', 'ocr.json')
VLMJSON = os.path.join(ROOT, 'data', 'vlm.json')
VLMJS = os.path.join(ROOT, 'data', 'vlm.js')
KEYFILE = os.path.join(ROOT, 'data', 'glm_key.txt')
""",
    VLM_SETS + "KEYFILE = os.path.join(ROOT, 'data', 'glm_key.txt')   # 两个数据集共用同一个 Key\n",
    [
        # 后面那行 SKIP_PREFIX 常量删掉（use_set 已经管了）
        ("SKIP_PREFIX = ('pic_', 'emoji_', 'avatar_')\n", "", 1),
        ("        f.write('window.DM_VLM=')",
         "        f.write('window.' + JS_GLOBAL + '=')", 1),
        ("    ap.add_argument('--quiet', action='store_true', help='不打印明细')\n    args = ap.parse_args()",
         "    ap.add_argument('--quiet', action='store_true', help='不打印明细')\n"
         "    ap.add_argument('--set', choices=['weibo', 'bili'], default='weibo',\n"
         "                    help='数据集：weibo = data/，bili = bili/')\n"
         "    args = ap.parse_args()\n"
         "    use_set(args.set)", 1),
    ])

print('done')
