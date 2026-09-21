# -*- coding: utf-8 -*-
"""
图片 OCR 索引生成器 —— 本地识别，图片不离开本机
=================================================
输入：data/images/ 下的 photo_ / card_ / vcover_ 图片（跳过动画表情与头像）
输出：data/ocr.json（索引数据） + data/ocr.js（供查看页直接 <script> 加载）
特点：
  - 全程内存处理，不写任何临时图片文件
  - 模型随包分发，运行时不下载、不写用户目录缓存
  - 断点续跑：已识别过的文件直接跳过，增量更新只跑新增的几张
  - 大图（近 1 亿像素）按需缩放；长截图分段识别以保住小字精度

用法：
  python image_ocr.py                     # 增量（只跑未索引的图）
  python image_ocr.py --full              # 全部重跑
  python image_ocr.py --limit 5           # 只处理 5 张（试跑）
  python image_ocr.py --only a.jpg b.jpg  # 只处理指定文件（调试）
  python image_ocr.py --prune             # 清理已不存在的图片的索引
"""
import os
import sys
import json
import time
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# ---- 数据集切换：--set weibo（默认，data/）或 --set bili（bili/） ----------------
SETS = {
    'weibo': {'dir': 'data', 'js': 'DM_OCR',   'skip': ('pic_', 'emoji_', 'avatar_')},
    'bili':  {'dir': 'bili', 'js': 'DM_OCR_B', 'skip': ('face_', 'avatar_', 'emoji_')},
}


def _merge_sessions_json():
    """多会话支持：把 sessions.json 里的会话并进 SETS，--set <key> 即可直接用。

    与查看页、更新脚本共用同一份清单。缺文件 / 格式不对就静默保持内置两个，
    不动原来的行为。
    """
    # DM_SESSIONS_JSON 是给回归测试用的替代清单开关
    mpath = os.environ.get('DM_SESSIONS_JSON') or os.path.join(ROOT, 'sessions.json')
    try:
        with open(mpath, 'r', encoding='utf-8') as f:
            man = json.load(f)
    except Exception:
        return
    for s in (man.get('sessions') or []):
        if not isinstance(s, dict):
            continue
        key = str(s.get('key') or '').strip()
        d = str(s.get('dir') or '').strip().replace('\\', '/').strip('/')
        if not key or not d:
            continue
        g = s.get('globals') if isinstance(s.get('globals'), dict) else {}
        js = g.get('ocr') or ''.join(
            c if c.isalnum() else '_' for c in key.upper())
        if not js.startswith('DM_OCR'):
            js = 'DM_OCR_' + js
        skip = s.get('skip')
        if not (isinstance(skip, list) and skip):
            skip = SETS.get(key, {}).get('skip') or ('pic_', 'emoji_', 'avatar_')
        SETS[key] = {'dir': d, 'js': js, 'skip': tuple(skip)}


_merge_sessions_json()

IMGDIR = OCRJSON = OCRJS = LOCKFILE = ''
SKIP_PREFIX = SETS['weibo']['skip']
JS_GLOBAL = SETS['weibo']['js']


def use_set(name):
    """切换数据集：目录、导出全局名、跳过前缀一起换"""
    global IMGDIR, OCRJSON, OCRJS, LOCKFILE, SKIP_PREFIX, JS_GLOBAL
    cfg = SETS[name]
    IMGDIR = os.path.join(ROOT, cfg['dir'], 'images')
    OCRJSON = os.path.join(ROOT, cfg['dir'], 'ocr.json')
    OCRJS = os.path.join(ROOT, cfg['dir'], 'ocr.js')
    LOCKFILE = os.path.join(ROOT, cfg['dir'], 'ocr.lock')
    SKIP_PREFIX = cfg['skip']
    JS_GLOBAL = cfg['js']
    os.makedirs(IMGDIR, exist_ok=True)


# ---------------------------------------------------------------- 单实例锁
# 两个实例同时跑会各自拿着「启动时的快照」互相覆盖（image_vlm.py 已真实踩过）。
def _pid_alive(pid):
    if pid <= 0:
        return False
    try:
        if os.name == 'nt':
            import ctypes
            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(0x1000, False, pid)
            if not h:
                return False
            code = ctypes.c_ulong()
            k32.GetExitCodeProcess(h, ctypes.byref(code))
            k32.CloseHandle(h)
            return code.value == 259
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def acquire_lock():
    for _ in range(2):
        try:
            fd = os.open(LOCKFILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            import atexit
            atexit.register(release_lock)
            return
        except FileExistsError:
            try:
                other = int((open(LOCKFILE, encoding='utf-8').read() or '0').strip())
            except Exception:
                other = 0
            if _pid_alive(other):
                print(f'[ERR] 已有一个实例正在运行（PID {other}），'
                      '为避免索引互相覆盖，本次退出。')
                print(f'      若确认它已停止，删除这个文件后重试：{LOCKFILE}')
                sys.exit(3)
            try:
                os.remove(LOCKFILE)
            except Exception:
                pass


def release_lock():
    try:
        os.remove(LOCKFILE)
    except Exception:
        pass


use_set('weibo')
MAXSIDE = 1600          # 缩放后长边像素
TALL_RATIO = 2.5        # 高/宽 超过此值且够高 → 判定为超长截图，分段识别
TALL_MIN_H = 3000       # 实测：普通竖版截图整体缩放后识别更准，只有真·长图才需分段
SEG_OVERLAP = 0.10      # 分段重叠比例，避免切断文字行
MIN_CHARS = 1           # 少于这么多字符视为「无文字」
MIN_SCORE = 0.55        # 单行置信度下限，滤掉噪声

os.environ.setdefault('PYTHONIOENCODING', 'utf-8')


def targets(full=False, limit=0, only=None):
    """列出待处理的图片文件名"""
    old = {}
    if not full and os.path.exists(OCRJSON):
        try:
            old = json.load(open(OCRJSON, encoding='utf-8'))
        except Exception:
            old = {}
    if only:
        return [f for f in only if os.path.exists(os.path.join(IMGDIR, f))], old

    names = []
    for fn in sorted(os.listdir(IMGDIR)):
        if fn.startswith(SKIP_PREFIX):
            continue
        if not fn.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.bmp')):
            continue
        if fn in old and (old[fn] or {}).get('t') is not None:
            continue
        names.append(fn)
    if limit:
        names = names[:limit]
    return names, old


def fit(im, maxside=MAXSIDE):
    """按需缩小，返回 ndarray RGB"""
    import numpy as np
    w, h = im.size
    sc = min(1.0, maxside / max(w, h))
    if sc < 1.0:
        im = im.resize((max(1, int(w * sc)), max(1, int(h * sc))), 1)  # 1 = LANCZOS
    return np.asarray(im.convert('RGB'))


def segments(im, force=None):
    """长截图 → 纵向切块（全部在内存，不落盘）"""
    w, h = im.size
    is_tall = h > TALL_RATIO * w and h > TALL_MIN_H
    if force is False:
        is_tall = False
    if force is True:
        is_tall = True
    if not is_tall:
        return [im], False
    seg_h = int(MAXSIDE * 1.35)
    step = max(1, int(seg_h * (1 - SEG_OVERLAP)))
    out, y = [], 0
    while y < h:
        box = (0, y, w, min(h, y + seg_h))
        out.append(im.crop(box))
        if box[3] >= h:
            break
        y += step
    return out, True


_ENGINE = None


def ocr_engine():
    global _ENGINE
    if _ENGINE is None:
        from rapidocr import RapidOCR
        _ENGINE = RapidOCR()
    return _ENGINE


def run_ocr(engine, arr, min_score=MIN_SCORE):
    """兼容新旧两种 RapidOCR 返回结构，返回过滤后的 [(文字, 置信度)]"""
    res = engine(arr)
    pairs = []
    if hasattr(res, 'txts'):                       # 新版 RapidOCROutput
        txts = list(getattr(res, 'txts', None) or [])
        scs = list(getattr(res, 'scores', None) or [])
        for i, t in enumerate(txts):
            pairs.append((t, float(scs[i]) if i < len(scs) else 1.0))
    else:                                          # 旧版 (result, elapse)
        body = res[0] if isinstance(res, tuple) else res
        for item in (body or []):
            try:
                pairs.append((item[1], float(item[2])))
            except Exception:
                pass
    return [(t, s) for t, s in pairs if t and str(t).strip() and s >= min_score]


def read_one(engine, path, force_seg=None, min_score=MIN_SCORE, verbose=False):
    """识别单张图，返回 (index_entry, 是否分段)"""
    from PIL import Image
    t1 = time.time()
    im = Image.open(path)
    W, H = im.size
    segs, is_tall = segments(im, force_seg)
    lines, scores = [], []
    for seg in segs:
        pairs = run_ocr(engine, fit(seg), min_score)
        for t, s in pairs:
            lines.append(t)
            scores.append(s)
    text = '\n'.join(lines)
    entry = {
        't': text,
        'n': len(lines),
        's': round(sum(scores) / len(scores), 3) if scores else 0,
        'w': W, 'h': H,
        'seg': len(segs),
        'ms': int((time.time() - t1) * 1000),
    }
    if verbose:
        print(f'  {os.path.basename(path)}  {W}x{H}  分段={len(segs)}  行={len(lines)}  '
              f'置信={entry["s"]}  {entry["ms"]}ms')
    return entry, is_tall


def write(out=None):
    """写 data/ocr.json 与 data/ocr.js（落盘前与磁盘版本合并，索引只增不减）"""
    disk = {}
    if os.path.exists(OCRJSON):
        try:
            disk = json.load(open(OCRJSON, encoding='utf-8'))
        except Exception:
            disk = {}
    if out is None:
        out = disk
    merged = {k: v for k, v in out.items() if not k.startswith('_')}
    kept = 0
    for k, v in disk.items():
        if k.startswith('_') or not isinstance(v, dict) or v.get('t') is None:
            continue                      # 磁盘上这条还没识别过，不算「成果」
        cur = merged.get(k)
        if not isinstance(cur, dict) or cur.get('t') is None:
            merged[k] = v
            kept += 1
    body = merged
    payload = {
        '_meta': {
            'engine': 'rapidocr (PP-OCRv6 onnxruntime)',
            'maxside': MAXSIDE,
            'count': len(body),
            'with_text': len([1 for v in body.values() if (v or {}).get('t')]),
            'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        }
    }
    payload.update(body)
    tmp = OCRJSON + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, OCRJSON)
    js_tmp = OCRJS + '.tmp'
    with open(js_tmp, 'w', encoding='utf-8') as f:
        f.write('window.' + JS_GLOBAL + '=')
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    os.replace(js_tmp, OCRJS)      # 原子替换：查看页不会读到写了一半的 js
    tail = f'  [从磁盘合并保留 {kept} 条]' if kept else ''
    print(f'[write] ocr.json {os.path.getsize(OCRJSON)/1024:.0f} KB  '
          f'（{len(body)} 条索引，其中 {payload["_meta"]["with_text"]} 张有文字）' + tail)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--full', action='store_true', help='全部重新识别')
    ap.add_argument('--limit', type=int, default=0, help='只处理前 N 张（试跑）')
    ap.add_argument('--only', nargs='*', default=[], help='只处理指定文件名（调试）')
    ap.add_argument('--prune', action='store_true', help='清理已删除图片的索引')
    ap.add_argument('--force-seg', choices=['on', 'off'], help='强制开启/关闭长截图分段')
    ap.add_argument('--min-score', type=float, default=MIN_SCORE, help='单行置信度下限')
    ap.add_argument('--quiet', action='store_true', help='不打印明细')
    ap.add_argument('--set', choices=sorted(SETS.keys()), default='weibo',
                    help='数据集 key，见项目根 sessions.json'
                         '（内置 weibo = data/，bili = bili/）')
    args = ap.parse_args()
    use_set(args.set)
    acquire_lock()          # 单实例：防两个进程互抢同一份索引

    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None      # 本机自己的备份图，关掉「解压炸弹」告警

    names, old = targets(args.full, args.limit, args.only)

    if args.prune:
        alive = set(os.listdir(IMGDIR))
        gone = [k for k in old if k not in alive and not k.startswith('_')]
        for k in gone:
            old.pop(k, None)
        if gone:
            print(f'[prune] 清理了 {len(gone)} 条已失效索引')
        write(out=old)
        return

    if not names:
        print('[done] 没有需要处理的图片（索引已是最新）')
        return

    force_seg = {'on': True, 'off': False, None: None}[args.force_seg]
    print(f'[start] 待处理 {len(names)} 张，历史索引 {len(old)} 条')
    engine = ocr_engine()

    out = dict(old)
    t0, hit = time.time(), 0
    for i, fn in enumerate(names, 1):
        path = os.path.join(IMGDIR, fn)
        try:
            entry, is_tall = read_one(engine, path, force_seg, args.min_score,
                                      verbose=args.only or len(names) <= 12)
            if entry['t']:
                hit += 1
            out[fn] = entry
        except Exception as e:
            print(f'  [ERR] {fn}: {e}')
            out[fn] = {'t': '', 'n': 0, 's': 0, 'w': 0, 'h': 0, 'seg': 0, 'ms': 0,
                       'err': str(e)[:150]}
        if not args.quiet and (i % 20 == 0 or i == len(names)):
            el = time.time() - t0
            eta = el / i * (len(names) - i)
            print(f'  {i}/{len(names)}  有文字 {hit}  已用 {el:.0f}s  剩余约 {eta:.0f}s')

    write(out)
    print(f'[done] 处理 {len(names)} 张，其中 {hit} 张识别到文字，'
          f'总耗时 {time.time()-t0:.0f}s')


if __name__ == '__main__':
    main()
