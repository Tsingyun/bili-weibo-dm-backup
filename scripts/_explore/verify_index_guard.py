# -*- coding: utf-8 -*-
"""
索引守卫回归测试 —— 单实例锁 + 落盘合并
=======================================
背景（2026-09-15 真实事故）：
  有两个 image_vlm.py 实例同时在跑，各自攥着「自己启动那一刻的快照」。
  后落盘的那个用它那份旧快照覆盖了文件 —— 已生成的 136 条图片描述被压回 44 条
  （vlm.json 174 条 → 59 条，13,649 字 → 3,535 字）。
本脚本锁死两条防线，防止再退化：
  ① 落盘前与磁盘版本合并 —— 描述只增不减，过期快照抹不掉别人的成果
  ② 单实例锁 —— 同一数据集同一时刻只允许一个写者

跑法：
  .ocr-env/Scripts/python.exe scripts/_explore/verify_index_guard.py
退出码 0 = 全过，1 = 有失败
"""
import os
import sys
import json
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

PASS = [0]
FAIL = [0]


def chk(cond, name, detail=''):
    if cond:
        PASS[0] += 1
        print('  [ok] ' + name + ('   ' + detail if detail else ''))
    else:
        FAIL[0] += 1
        print('  [!!] ' + name + '   ' + detail)


# ---------------------------------------------------------- 1. vlm 合并落盘
print('[1] vlm 落盘合并：过期快照抹不掉已有描述')
import image_vlm as V                                     # noqa: E402

d1 = tempfile.mkdtemp()
V.VLMJSON = os.path.join(d1, 'vlm.json')
V.VLMJS = os.path.join(d1, 'vlm.js')
json.dump({'a.jpg': {'d': '甲'}, 'b.jpg': {'d': '乙'}, 'c.jpg': {'d': ''}},
          open(V.VLMJSON, 'w', encoding='utf-8'), ensure_ascii=False)

# 模拟一个「启动时只认得 c」的旧进程落盘
V.write({'c.jpg': {'d': '丙'}, 'd.jpg': {'d': '丁'}})
res = json.load(open(V.VLMJSON, encoding='utf-8'))
chk(res.get('a.jpg', {}).get('d') == '甲', '磁盘上 a.jpg 的描述被保住')
chk(res.get('b.jpg', {}).get('d') == '乙', '磁盘上 b.jpg 的描述被保住')
chk(res.get('c.jpg', {}).get('d') == '丙', '内存里的新描述覆盖了空的旧条目')
chk(res.get('d.jpg', {}).get('d') == '丁', '内存里的新增条目被写入')
chk(res['_meta']['described'] == 4, '_meta.described 统计正确', str(res['_meta']['described']))

# 再模拟一次：内存里的条目「描述为空」时，也不能把磁盘上的好描述冲掉
V.write({'a.jpg': {'d': ''}})
res2 = json.load(open(V.VLMJSON, encoding='utf-8'))
chk(res2.get('a.jpg', {}).get('d') == '甲', '内存里空描述不会冲掉磁盘上的好描述')

# ---------------------------------------------------------- 2. ocr 合并落盘
print('[2] ocr 落盘合并：t 非 None 视为已识别成果')
import image_ocr as O                                     # noqa: E402

d2 = tempfile.mkdtemp()
O.OCRJSON = os.path.join(d2, 'ocr.json')
O.OCRJS = os.path.join(d2, 'ocr.js')
json.dump({'x.jpg': {'t': '文字X'}, 'y.jpg': {'t': ''}},
          open(O.OCRJSON, 'w', encoding='utf-8'), ensure_ascii=False)

O.write({'z.jpg': {'t': ''}})
r2 = json.load(open(O.OCRJSON, encoding='utf-8'))
chk(r2.get('x.jpg', {}).get('t') == '文字X', '磁盘上 x.jpg 识别出的文字被保住')
chk(r2.get('y.jpg', {}).get('t') == '', '磁盘上 y.jpg 的「无文字」结论被保住')
chk('z.jpg' in r2, '新条目被写入')

# ---------------------------------------------------------- 3. 单实例锁
print('[3] 单实例锁')
for mod, name in ((V, 'image_vlm.py'), (O, 'image_ocr.py')):
    chk(callable(getattr(mod, 'acquire_lock', None)), name + ' 有 acquire_lock()')
    chk(callable(getattr(mod, '_pid_alive', None)), name + ' 有 _pid_alive()')
    chk(bool(getattr(mod, 'LOCKFILE', '')), name + ' 有独立的 LOCKFILE 路径')

chk(V.LOCKFILE.endswith('data\\vlm.lock') or V.LOCKFILE.endswith('data/vlm.lock'),
    'vlm 锁落在 data/ 下', V.LOCKFILE)
chk(O.LOCKFILE.endswith('data\\ocr.lock') or O.LOCKFILE.endswith('data/ocr.lock'),
    'ocr 锁落在 data/ 下', O.LOCKFILE)
chk(V._pid_alive(os.getpid()) is True, '能识别「活着」的 PID（自己）')
chk(V._pid_alive(999999) is False, '能识别「已退出」的 PID')
chk(V._pid_alive(0) is False, 'PID=0 视为无效/非活着')

# 拿锁 → 同路径再拿一次应被拒（用子进程跑，避免污染当前进程）
print('[4] 锁互斥（子进程实测）')
import subprocess                                         # noqa: E402
d3 = tempfile.mkdtemp()
lock = os.path.join(d3, 'test.lock')
code = (
    'import sys, os, time; sys.path.insert(0, r"%s");\n'
    'import image_vlm as V;\n'
    'V.LOCKFILE = r"%s";\n'
    'V.acquire_lock();\n'
    'print("HOLDING", flush=True);\n'
    'time.sleep(30)\n'          # 必须「活着」持锁：进程一退出 atexit 就会把锁释放
) % (os.path.join(ROOT, 'scripts'), lock)
p1 = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE,
                      stderr=subprocess.STDOUT, text=True)
try:
    first = p1.stdout.readline().strip()
    chk('HOLDING' in first, '第一个实例成功拿锁', first)
    p2 = subprocess.run([sys.executable, '-c', code], capture_output=True,
                        text=True, timeout=30)
    note = (p2.stdout or '').strip().replace('\n', ' ')[:90]
    chk(p2.returncode == 3, '第二个实例被拒（退出码 3）',
        'rc=%s  %s' % (p2.returncode, note))
finally:
    p1.kill()
    p1.wait()
try:
    os.remove(lock)
except Exception:
    pass

print()
print('结果：通过 %d，失败 %d' % (PASS[0], FAIL[0]))
sys.exit(1 if FAIL[0] else 0)
