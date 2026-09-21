# -*- coding: utf-8 -*-
"""卸载实测：删除 .ocr-env（等价于卸载脚本里的 rmdir /s /q），验证清理彻底且不误伤"""
import os, shutil, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENV = os.path.join(ROOT, '.ocr-env')


def dirsize(p):
    t = n = 0
    for r, d, f in os.walk(p):
        for x in f:
            try:
                t += os.path.getsize(os.path.join(r, x)); n += 1
            except Exception:
                pass
    return t, n


def snap(label):
    print(f'--- {label} ---')
    t, n = dirsize(ENV)
    print(f'  .ocr-env            {"不存在" if not os.path.exists(ENV) else f"{t/1048576:.1f} MB / {n} 个文件"}')
    for f in ('data/ocr.json', 'data/ocr.js'):
        p = os.path.join(ROOT, f)
        print(f'  {f:18} {os.path.getsize(p)/1024:.1f} KB' if os.path.exists(p) else f'  {f:18} 不存在')
    u = shutil.disk_usage('C:\\')
    print(f'  C 盘可用            {u.free/2**30:.3f} GB')
    return u.free


# 关键：卸载不该动的目录
KEEP = ['.edge-profile', 'data/images', 'data/faces', 'data/raw', 'scripts',
        '查看备份.html', '使用说明.md', '更新备份.cmd', '重建备份.cmd']
print('=== 卸载前 ===')
before_free = snap('before')
keep_before = {k: (dirsize(os.path.join(ROOT, k)) if os.path.isdir(os.path.join(ROOT, k))
                   else (os.path.getsize(os.path.join(ROOT, k)) if os.path.exists(os.path.join(ROOT, k)) else None))
               for k in KEEP}

print('\n=== 执行卸载 ===')
t0 = time.time()
shutil.rmtree(ENV, ignore_errors=True)
print(f'  rmtree 完成，耗时 {time.time()-t0:.1f}s，目录是否仍存在：{os.path.exists(ENV)}')

print('\n=== 卸载后 ===')
after_free = snap('after')

print('\n=== 结果 ===')
freed = after_free - before_free
print(f'  释放空间            {freed/1048576:.1f} MB')
print(f'  运行环境已彻底删除  {"✅ 是" if not os.path.exists(ENV) else "❌ 否"}')

print('\n=== 未受影响的文件（卸载前 → 卸载后）===')
ok = True
for k in KEEP:
    now = (dirsize(os.path.join(ROOT, k)) if os.path.isdir(os.path.join(ROOT, k))
           else (os.path.getsize(os.path.join(ROOT, k)) if os.path.exists(os.path.join(ROOT, k)) else None))
    same = (now == keep_before[k])
    if not same:
        ok = False
    b = keep_before[k]
    fmt = lambda v: (f'{v[0]/1048576:.1f} MB / {v[1]} 文件' if isinstance(v, tuple) else (f'{v/1024:.1f} KB' if v else '—'))
    print(f'  {"✅" if same else "❌"} {k:16} {fmt(b)} → {fmt(now)}')
print(f'\n  卸载是否误伤其它文件：{"✅ 没有" if ok else "❌ 有"}')

print('\n=== 用户目录残留（本次安装是否写到过用户目录）===')
home = os.path.expanduser('~')
for p in ('.rapidocr', '.cache/rapidocr', 'AppData/Local/RapidOCR',
          'AppData/Local/pip/cache', '.paddleocr', '.paddlex'):
    fp = os.path.join(home, p.replace('/', os.sep))
    print(f'  {"✗ 存在" if os.path.exists(fp) else "✓ 不存在"}  {p}')
