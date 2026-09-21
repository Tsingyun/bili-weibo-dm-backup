# -*- coding: utf-8 -*-
"""
图片内容理解索引生成器 —— 为「没有文字的图片」生成可搜索的中文描述
==================================================================
适用：OCR 没识别到文字的纯照片 / 插画 / 分享卡片（风景、人像、舞台、截图配图…）

输入：data/images/ 下 OCR 判定为「无文字」的图片（默认只处理这些，避免截图外传）
输出：data/vlm.json（索引数据） + data/vlm.js（供查看页 <script> 加载，window.DM_VLM）

说明：
  - 调用智谱 GLM-4.6V-Flash（官方免费模型），图片经压缩后上传
  - 全程内存处理，不落任何临时图片文件
  - 断点续跑：已生成过描述的图片直接跳过
  - API Key 读取优先级：环境变量 GLM_API_KEY > data/glm_key.txt

用法：
  python image_vlm.py                  # 增量（只跑还没描述的图）
  python image_vlm.py --limit 3        # 试跑 3 张
  python image_vlm.py --only a.jpg     # 只处理指定文件
  python image_vlm.py --all-text       # 连有文字的图也一起描述（默认不）
  python image_vlm.py --prune          # 清理已删除图片的索引
"""
import os
import io
import re
import sys
import json
import time
import base64
import random
import argparse
import threading
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# ---- 数据集切换：--set weibo（默认，data/）或 --set bili（bili/） ----------------
SETS = {
    'weibo': {'dir': 'data', 'js': 'DM_VLM',   'skip': ('pic_', 'emoji_', 'avatar_')},
    'bili':  {'dir': 'bili', 'js': 'DM_VLM_B', 'skip': ('face_', 'avatar_', 'emoji_')},
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
        js = g.get('vlm') or ''.join(
            c if c.isalnum() else '_' for c in key.upper())
        if not js.startswith('DM_VLM'):
            js = 'DM_VLM_' + js
        skip = s.get('skip')
        if not (isinstance(skip, list) and skip):
            skip = SETS.get(key, {}).get('skip') or ('pic_', 'emoji_', 'avatar_')
        SETS[key] = {'dir': d, 'js': js, 'skip': tuple(skip)}


_merge_sessions_json()

IMGDIR = OCRJSON = VLMJSON = VLMJS = LOCKFILE = ''
SKIP_PREFIX = SETS['weibo']['skip']
JS_GLOBAL = SETS['weibo']['js']


def use_set(name):
    """切换数据集：目录、导出全局名、跳过前缀一起换"""
    global IMGDIR, OCRJSON, VLMJSON, VLMJS, LOCKFILE, SKIP_PREFIX, JS_GLOBAL
    cfg = SETS[name]
    IMGDIR = os.path.join(ROOT, cfg['dir'], 'images')
    OCRJSON = os.path.join(ROOT, cfg['dir'], 'ocr.json')
    VLMJSON = os.path.join(ROOT, cfg['dir'], 'vlm.json')
    VLMJS = os.path.join(ROOT, cfg['dir'], 'vlm.js')
    LOCKFILE = os.path.join(ROOT, cfg['dir'], 'vlm.lock')
    SKIP_PREFIX = cfg['skip']
    JS_GLOBAL = cfg['js']
    os.makedirs(IMGDIR, exist_ok=True)


# ---------------------------------------------------------------- 单实例锁
# 两个实例同时跑会各自拿着「启动时的快照」，互相覆盖对方新生成的结果
# （2026-09-15 真实事故：174 条索引被并发实例压回 59 条）。这里加锁拦住。
def _pid_alive(pid):
    if pid <= 0:
        return False
    try:
        if os.name == 'nt':
            import ctypes
            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return False
            code = ctypes.c_ulong()
            k32.GetExitCodeProcess(h, ctypes.byref(code))
            k32.CloseHandle(h)
            return code.value == 259                  # STILL_ACTIVE
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def acquire_lock():
    """拿不到锁就退出，避免并发写坏索引"""
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
                os.remove(LOCKFILE)      # 陈旧的锁，清掉重来
            except Exception:
                pass


def release_lock():
    try:
        os.remove(LOCKFILE)
    except Exception:
        pass


use_set('weibo')
KEYFILE = os.path.join(ROOT, 'data', 'glm_key.txt')   # 两个数据集共用同一个 Key

API = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
MODEL = 'glm-4.6v-flash'
# 免费视觉模型降级链（据官方定价页，永久免费的只有这三个）。
# 高峰期 glm-4.6v-flash 常返回 1305「访问量过大」，此时自动改用链上下一个模型，
# 不必干等退避——免费额度内互备，不再整批卡死。
FREE_MODELS = ['glm-4.6v-flash', 'glm-4v-flash']
_MODELS = [list(FREE_MODELS)]    # main() 里按 --model 覆盖；元素为「模型名列表」
MAXSIDE = 1600      # 上传前长边（实测 q88 后平均 ~190KB，远低于 5MB 上限）
QUALITY = 88
TIMEOUT = 180
RETRY = 6           # 免费模型高峰期会返回 429，多给几次机会
WORKERS = 3         # 实测：并发 8 必被 429（错误码 1305），3 较稳
MIN_INTERVAL = 3.0  # 每次请求最小间隔（秒），防触发限流


PROMPT = (
    '用中文为这张图片写一段检索描述，我要靠它以后搜索到这张图。\n'
    '规则：\n'
    '1. 直接输出内容，不要开场白（不要"这张图片显示了"之类）；\n'
    '2. 先写一行关键词：15~25 个，用「、」分隔，覆盖画面主体、场景环境、'
    '动作状态、主要颜色、整体风格（如实景照片/插画/二次元/游戏截图/表情包/海报）；\n'
    '3. 再写一句概括，30 字以内；\n'
    '4. 图中有可见文字就原样抄录关键文字；\n'
    '5. 每个词只出现一次，不要重复、不要同义堆叠，全文不超过 150 字。'
)

os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
_lock = threading.Lock()
_last_call = [0.0]
_QUIET = [False]         # 由命令行 --quiet 控制
_RATE_LOGGED = [False]   # 限流提示只打一次，避免并发刷屏
_SWITCHED = set()        # 已提示过「切换模型」的目标模型，避免并发刷屏

# 模型爱在开头加「关键词：」「概括：」这类标签，留着会污染搜索（搜「关键词」全军命中）
# 注意：模型还会写「15~25个关键词：」这种带数量的变体，也要一起吃掉
TAG_RE = re.compile(
    r'^\s*(?:\d+\s*[~～\-—到至]\s*\d+\s*个?\s*)?'
    r'(关键词|关键要素|画面描述|图像描述|图片描述|描述|概括|总结|内容|Caption)\s*[:：]\s*',
    re.M)

# 推理型模型（glm-4.1v-thinking-flash 之类）会把思考过程写在 <think>…</think> 里，
# 直接留着会污染搜索，必须整块吃掉
THINK_RE = re.compile(r'<think(?:ing)?>.*?</think(?:ing)?>', re.S | re.I)

# 降级链里的 glm-4v-flash 爱用 markdown 输出：**关键词：** / - 列表 / ### 小标题。
# 不清掉的话上面的 TAG_RE 就匹配不到，小标题会原样进索引。
BOLD_RE = re.compile(r'\*{1,3}([^*\n]+)\*{1,3}')
BULLET_RE = re.compile(r'^\s*(?:#{1,6}\s*|[-*•·]\s+)', re.M)

MAX_DESC = 200      # 描述字数上限（提示词要求 ≤150，留点余量防个别模型超写）
MAX_KW = 30         # 关键词最多保留多少个（提示词要求 15~25）


def _tidy_token(p):
    """修掉关键词两端的引号噪声。

    只碰 ASCII 引号：模型偶尔在开头带个孤立的 ' 或 "。
    中文引号（“”‘’）一律保留——例句里的「文字“45 w you”」是正文，不能删。
    """
    p = p.strip()
    p = re.sub(r'^[\'"]+', '', p)          # 开头的孤立引号
    if p.count('"') % 2 or p.count("'") % 2:
        p = re.sub(r'[\'"]+$', '', p)      # 尾部配对不上的引号
    return p.strip()


def _dedup_keywords(t):
    """首行是「、」分隔的关键词表时：去重 + 限量。

    模型偶尔会复读成「美味佳肴、美味食物、美味佳肴、美味食物…」一路写到上限，
    这些重复词既占篇幅又污染搜索（搜「美味食物」命中一堆无关图），必须清掉。
    """
    lines = t.split('\n')
    first = lines[0] if lines else ''
    if '。' in first or first.count('、') < 3:
        return t                       # 不像关键词表，别乱动
    seen, keep = set(), []
    for p in re.split(r'[、，,]\s*', first):
        p = _tidy_token(p)
        if not p or p in seen:
            continue
        seen.add(p)
        keep.append(p)
        if len(keep) >= MAX_KW:
            break
    lines[0] = '、'.join(keep)
    return '\n'.join(lines)


def clean(text):
    """去掉模型的思考过程 / markdown 记号 / 自加小标题，关键词去重，限长"""
    t = text or ''
    t = THINK_RE.sub('', t)            # 1) <think> 思考块整块吃掉
    t = BOLD_RE.sub(r'\1', t)          # 2) **粗体** → 纯文本
    t = BULLET_RE.sub('', t)           # 3) ### 标题 / - 列表记号
    t = TAG_RE.sub('', t)              # 4) 「关键词：」这类小标题
    t = re.sub(r'[ \t]+\n', '\n', t)
    t = re.sub(r'\n{3,}', '\n\n', t).strip()
    t = _dedup_keywords(t)             # 5) 关键词去重 + 限量
    if len(t) > MAX_DESC:              # 6) 限长，尽量断在标点处
        cut = t[:MAX_DESC]
        for sep in ('。', '；', '\n', '、', '，'):
            i = cut.rfind(sep)
            if i >= MAX_DESC * 0.6:
                cut = cut[:i + (1 if sep in '。；' else 0)]
                break
        t = cut.rstrip('、，,；; ') + '…'
    return t


# ---------------------------------------------------------------- key
def load_key():
    k = os.environ.get('GLM_API_KEY', '').strip()
    if k:
        return k
    if os.path.exists(KEYFILE):
        return open(KEYFILE, encoding='utf-8').read().strip()
    return ''


# ---------------------------------------------------------------- image
def encode(path, maxside=MAXSIDE, quality=QUALITY):
    """压缩成 base64（内存完成，不落盘）"""
    from PIL import Image
    im = Image.open(path)
    W, H = im.size
    sc = min(1.0, maxside / max(W, H))
    if sc < 1.0:
        im = im.resize((max(1, int(W * sc)), max(1, int(H * sc))), 1)
    if im.mode != 'RGB':
        im = im.convert('RGB')
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=quality, optimize=True)
    raw = buf.getvalue()
    return base64.b64encode(raw).decode('ascii'), len(raw), (W, H)


# ---------------------------------------------------------------- api
def call_api(key, b64, model=MODEL, prompt=PROMPT):
    body = {
        'model': model,
        'messages': [{
            'role': 'user',
            'content': [
                {'type': 'image_url',
                 'image_url': {'url': 'data:image/jpeg;base64,' + b64}},
                {'type': 'text', 'text': prompt},
            ],
        }],
        'max_tokens': 1024,
        'temperature': 0.1,
    }
    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(API, data=data, method='POST')
    req.add_header('Authorization', 'Bearer ' + key)
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode('utf-8'))


def describe(key, path, model=MODEL, prompt=PROMPT, verbose=False,
             maxside=MAXSIDE):
    """识别单张图，返回 (条目 dict)。失败抛异常

    限流（429/1305）时不再只干等退避，而是换到降级链上的下一个免费模型重试。
    每张图都从链首开始，所以主模型恢复后会自动切回高质量的那个。
    """
    t1 = time.time()
    b64, nbytes, (W, H) = encode(path, maxside)
    models = _MODELS[0] or [model]
    mi = 0
    cur = models[mi]
    last = None
    for attempt in range(1, RETRY + 1):
        with _lock:                                  # 严格串行化「请求发起」节奏，防限流
            wait = MIN_INTERVAL - (time.time() - _last_call[0])
            if wait > 0:
                time.sleep(wait)
            _last_call[0] = time.time()
        try:
            res = call_api(key, b64, cur, prompt)
            break
        except urllib.error.HTTPError as e:
            detail = ''
            try:
                detail = e.read().decode('utf-8', 'replace')[:200]
            except Exception:
                pass
            last = f'HTTP {e.code} {detail}'
            if e.code in (429, 500, 502, 503, 504) and attempt < RETRY:
                if e.code == 429 and len(models) > 1:
                    # 换一个免费模型试试，通常立刻就能用，不必长等
                    mi = (mi + 1) % len(models)
                    nxt = models[mi]
                    if nxt != cur:
                        with _lock:
                            first = nxt not in _SWITCHED
                            _SWITCHED.add(nxt)
                        if first:
                            print(f'  [切换] {cur} 被限流 → 改用免费模型 {nxt}')
                        cur = nxt
                    pause = 1.5 + random.uniform(0, 2)
                else:
                    pause = (10 * attempt if e.code == 429 else 2 ** attempt * 2) \
                            + random.uniform(0, 3)
                    if not _RATE_LOGGED[0]:
                        _RATE_LOGGED[0] = True
                        print(f'  [限流] 触发限流，自动退避重试（首次等待 {pause:.0f}s）…')
                time.sleep(pause)
                continue
            raise RuntimeError(last)
        except Exception as e:
            last = f'{type(e).__name__}: {e}'
            if attempt < RETRY:
                time.sleep(2 ** attempt * 2)
                continue
            raise RuntimeError(last)

    ch = (res.get('choices') or [{}])[0]
    msg = ch.get('message') or {}
    text = clean(msg.get('content') or '')
    usage = res.get('usage') or {}
    # 有些模型把思考过程放在 reasoning_content，正文为空时兜底用不上就留空
    entry = {
        'd': text,
        'w': W, 'h': H,
        'kb': round(nbytes / 1024, 1),
        'tok': int(usage.get('total_tokens') or 0),
        'ms': int((time.time() - t1) * 1000),
        'm': cur,
    }
    if not text:
        entry['raw'] = json.dumps(res, ensure_ascii=False)[:300]
    if verbose:
        print(f'  {os.path.basename(path)}  {W}x{H}  {entry["kb"]}KB  '
              f'{entry["tok"]}tok  {entry["ms"]}ms')
        print(f'     → {text[:200]}')
    return entry


# ---------------------------------------------------------------- targets
def targets(all_text=False, full=False, limit=0, only=None):
    old = {}
    if os.path.exists(VLMJSON):
        try:
            old = json.load(open(VLMJSON, encoding='utf-8'))
        except Exception:
            old = {}
    if only:
        return [f for f in only if os.path.exists(os.path.join(IMGDIR, f))], old

    ocr = {}
    if os.path.exists(OCRJSON):
        ocr = json.load(open(OCRJSON, encoding='utf-8'))

    names = []
    for fn in sorted(os.listdir(IMGDIR)):
        if fn.startswith(SKIP_PREFIX):
            continue
        if not fn.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.bmp')):
            continue
        if not full and (old.get(fn) or {}).get('d'):
            continue                 # 只有「已成功生成描述」才跳过，失败/空描述会重跑
        if not all_text:
            # 默认只处理 OCR 判定为「无文字」的图：有文字的截图不外传
            oe = ocr.get(fn)
            if oe is None or (oe or {}).get('t'):
                continue
        names.append(fn)
    if limit:
        names = names[:limit]
    return names, old


def write(out=None):
    # 落盘前先读回磁盘版本做「合并」：描述只增不减。
    # 这样即使某个旧实例拿着过期快照在跑，也抹不掉别人已生成的结果。
    disk = {}
    if os.path.exists(VLMJSON):
        try:
            disk = json.load(open(VLMJSON, encoding='utf-8'))
        except Exception:
            disk = {}
    if out is None:
        out = disk
    merged = {k: v for k, v in out.items() if not k.startswith('_')}
    kept = 0
    for k, v in disk.items():
        if k.startswith('_') or not isinstance(v, dict) or not (v.get('d') or '').strip():
            continue
        cur = merged.get(k)
        if not isinstance(cur, dict) or not (cur.get('d') or '').strip():
            merged[k] = v
            kept += 1
    body = merged
    ok = [v for v in body.values() if (v or {}).get('d')]
    used = sorted({(v or {}).get('m') for v in body.values() if (v or {}).get('m')})
    payload = {
        '_meta': {
            # 如实记录索引里实际出现的模型（降级链可能让多模型混合落盘）
            'engine': 'zhipu ' + (', '.join(used) if used else MODEL) + ' (vision)',
            'maxside': MAXSIDE, 'quality': QUALITY,
            'count': len(body),
            'described': len(ok),
            'chars': sum(len(v.get('d') or '') for v in body.values()),
            'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        }
    }
    payload.update(body)
    tmp = VLMJSON + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, VLMJSON)
    js_tmp = VLMJS + '.tmp'
    with open(js_tmp, 'w', encoding='utf-8') as f:
        f.write('window.' + JS_GLOBAL + '=')
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    os.replace(js_tmp, VLMJS)      # 原子替换：查看页不会读到写了一半的 js
    tail = f'  [从磁盘合并保留 {kept} 条]' if kept else ''
    print(f'[write] vlm.json {os.path.getsize(VLMJSON)/1024:.0f} KB  '
          f'（{len(body)} 条，其中 {len(ok)} 张有描述，共 '
          f'{payload["_meta"]["chars"]:,} 字）' + tail)


def main():
    global MIN_INTERVAL
    ap = argparse.ArgumentParser()
    ap.add_argument('--full', action='store_true', help='全部重新生成')
    ap.add_argument('--all-text', action='store_true',
                    help='连有文字的图也一起描述（默认跳过）')
    ap.add_argument('--limit', type=int, default=0, help='只处理前 N 张（试跑）')
    ap.add_argument('--only', nargs='*', default=[], help='只处理指定文件名')
    ap.add_argument('--prune', action='store_true', help='清理已删除图片的索引')
    ap.add_argument('--clean', action='store_true',
                    help='清洗已有描述里的小标题（不重新识别）')
    ap.add_argument('--workers', type=int, default=WORKERS, help='并发数')
    ap.add_argument('--interval', type=float, default=MIN_INTERVAL,
                    help='每次请求最小间隔（秒），防限流')
    ap.add_argument('--maxside', type=int, default=MAXSIDE,
                    help='上传前图片长边像素')
    ap.add_argument('--model', default=','.join(FREE_MODELS),
                    help='模型名；可用逗号写成降级链。默认 "glm-4.6v-flash,glm-4v-flash"'
                         '（按官方定价页，免费视觉模型只有这三个：'
                         'glm-4.6v-flash / glm-4v-flash / glm-4.1v-thinking-flash）')
    ap.add_argument('--quiet', action='store_true', help='不打印明细')
    ap.add_argument('--set', choices=sorted(SETS.keys()), default='weibo',
                    help='数据集 key，见项目根 sessions.json'
                         '（内置 weibo = data/，bili = bili/）')
    args = ap.parse_args()
    use_set(args.set)
    acquire_lock()          # 单实例：防两个进程互抢同一份索引

    MIN_INTERVAL = args.interval
    _QUIET[0] = args.quiet
    _MODELS[0] = [m.strip() for m in str(args.model).split(',') if m.strip()] or [MODEL]

    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None

    if args.clean:
        out = json.load(open(VLMJSON, encoding='utf-8')) \
              if os.path.exists(VLMJSON) else {}
        n = 0
        for k, v in out.items():
            if k.startswith('_') or not isinstance(v, dict):
                continue
            o = v.get('d') or ''
            c = clean(o)
            if c != o:
                v['d'] = c
                n += 1
        print(f'[clean] 清洗了 {n} 条描述里的多余小标题')
        write(out=out)
        return

    if args.prune:
        out = json.load(open(VLMJSON, encoding='utf-8')) if os.path.exists(VLMJSON) else {}
        alive = set(os.listdir(IMGDIR))
        gone = [k for k in out if k not in alive and not k.startswith('_')]
        for k in gone:
            out.pop(k, None)
        if gone:
            print(f'[prune] 清理了 {len(gone)} 条已失效索引')
        write(out=out)
        return

    key = load_key()
    if not key:
        print('[ERR] 找不到 API Key：请设置环境变量 GLM_API_KEY，'
              f'或把 key 写进 {KEYFILE}')
        sys.exit(2)

    names, old = targets(args.all_text, args.full, args.limit, args.only)
    if not names:
        print('[done] 没有需要处理的图片（索引已是最新）')
        return

    print(f'[start] 待处理 {len(names)} 张，历史索引 {len(old)} 条，'
          f'模型={args.model}，并发={args.workers}')

    out = dict(old)
    t0 = time.time()
    done = [0]
    fail = [0]
    toks = [0]
    lock = threading.Lock()
    verbose = bool(args.only) or len(names) <= 5

    def work(fn):
        path = os.path.join(IMGDIR, fn)
        try:
            entry = describe(key, path, args.model, PROMPT, verbose=verbose,
                             maxside=args.maxside)
            if not (entry.get('d') or '').strip():
                entry['err'] = '空描述'
        except Exception as e:
            entry = {'d': '', 'w': 0, 'h': 0, 'ms': 0, 'err': str(e)[:200]}
        with lock:
            out[fn] = entry
            done[0] += 1
            toks[0] += int(entry.get('tok') or 0)
            if entry.get('err'):
                fail[0] += 1
                print(f'  [ERR] {fn}: {entry["err"][:140]}')
            i = done[0]
            if i % 5 == 0:             # 定期落盘：免费模型限流严重，跑得很慢，落密一点才不会白跑
                try:
                    write(out)
                except Exception as e:
                    print(f'  [warn] 中途保存失败：{e}')
            if not args.quiet and (i % 10 == 0 or i == len(names)):
                el = time.time() - t0
                print(f'  {i}/{len(names)}  失败 {fail[0]}  已用 {el:.0f}s  '
                      f'剩余约 {el/i*(len(names)-i):.0f}s')

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        list(ex.map(work, names))

    write(out)
    print(f'[done] 处理 {len(names)} 张，成功 {len(names)-fail[0]}，失败 {fail[0]}，'
          f'共 {toks[0]:,} tokens，总耗时 {time.time()-t0:.0f}s')


if __name__ == '__main__':
    main()
