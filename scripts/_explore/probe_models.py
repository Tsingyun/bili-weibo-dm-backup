# -*- coding: utf-8 -*-
"""探测 GLM 免费视觉模型可用性：对每个候选模型发一次极小请求"""
import io, os, sys, json, time, base64
import urllib.request, urllib.error

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import image_vlm as V

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
key = open(os.path.join(ROOT, 'data', 'glm_key.txt'), encoding='utf-8').read().strip()

# 造一张 64x64 纯色小图，尽量省流量
try:
    from PIL import Image
    buf = io.BytesIO()
    Image.new('RGB', (64, 64), (200, 30, 90)).save(buf, 'JPEG', quality=70)
    raw = buf.getvalue()
except Exception:
    raw = base64.b64decode(
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
        'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
        'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==')
b64 = base64.b64encode(raw).decode('ascii')
print('探测图大小: %.1f KB' % (len(raw) / 1024))
print()

CAND = ['glm-4.6v-flash', 'glm-4.5v', 'glm-4v-flash', 'glm-4.1v-thinking-flash',
        'glm-4v-plus-0111', 'glm-4.6v']

for m in CAND:
    t0 = time.time()
    try:
        res = V.call_api(key, b64, m, '用 5 个字描述这张图。')
        txt = ((res.get('choices') or [{}])[0].get('message') or {}).get('content') or ''
        print('[OK ] %-26s %.1fs -> %s' % (m, time.time() - t0, txt.replace('\n', ' ')[:60]))
    except urllib.error.HTTPError as e:
        body = ''
        try:
            body = e.read().decode('utf-8', 'replace')[:160]
        except Exception:
            pass
        print('[ERR] %-26s %.1fs -> HTTP %s %s' % (m, time.time() - t0, e.code, body))
    except Exception as e:
        print('[ERR] %-26s %.1fs -> %s: %s' % (m, time.time() - t0, type(e).__name__, str(e)[:100]))
    time.sleep(2)
