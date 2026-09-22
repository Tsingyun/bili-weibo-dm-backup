# -*- coding: utf-8 -*-
"""把「图片内容描述（VLM）」步骤接入 update.ps1（保持 UTF-8 BOM）"""
import os

P = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), 'scripts', 'update.ps1')
src = open(P, encoding='utf-8-sig').read()      # 自动去掉 BOM
reps = []

# ---- 用法注释 ----
reps.append((
    '# 用法：powershell -ExecutionPolicy Bypass -File scripts\\update.ps1 [-Full] [-NoImg] [-Rebuild]',
    '# 用法：powershell -ExecutionPolicy Bypass -File scripts\\update.ps1 '
    '[-Full] [-NoImg] [-Rebuild] [-NoVlm]'
))

# ---- 新增开关 ----
reps.append((
    """param(
  [switch]$Full,
  [switch]$NoImg,
  [switch]$Rebuild
)""",
    """param(
  [switch]$Full,
  [switch]$NoImg,
  [switch]$Rebuild,
  [switch]$NoVlm
)"""
))

# ---- 步骤编号 4 → 5 ----
reps.append(('[1/4]', '[1/5]', 2))
reps.append(('[2/4]', '[2/5]', 1))
reps.append(('[3/4]', '[3/5]', 1))
reps.append(('[4/4]', '[4/5]', 2))

# ---- 追加第 5 步：图片内容描述 ----
reps.append((
    """    & $ocrPy (Join-Path $PSScriptRoot 'image_ocr.py')
  } else {
    Say '[4/5] 跳过图片文字索引：未安装 OCR 环境（双击「命令/图片与OCR/安装OCR环境.cmd」可启用）。'
  }
}""",
    """    & $ocrPy -u (Join-Path $PSScriptRoot 'image_ocr.py')
  } else {
    Say '[4/5] 跳过图片文字索引：未安装 OCR 环境（双击「命令/图片与OCR/安装OCR环境.cmd」可启用）。'
  }
}

# 5) 图片内容描述（云端 GLM-4.6V-Flash，仅处理「没有文字的照片」；没配 Key 就跳过）
if ($code -eq 0 -and -not $NoImg -and -not $NoVlm) {
  Say ''
  $ocrPy   = Join-Path $root '.ocr-env\\Scripts\\python.exe'
  $keyFile = Join-Path $root 'data\\glm_key.txt'
  $hasKey  = (Test-Path $keyFile) -or [bool]$env:GLM_API_KEY
  if ((Test-Path $ocrPy) -and $hasKey) {
    Say '[5/5] 为新图片生成内容描述（只上传无文字的照片，免费模型，可能较慢）…'
    $env:PYTHONIOENCODING = 'utf-8'
    & $ocrPy -u (Join-Path $PSScriptRoot 'image_vlm.py')
  } else {
    Say '[5/5] 跳过图片内容描述：未安装环境或未配置 API Key。'
  }
}"""
))

ok = True
for item in reps:
    old, new = item[0], item[1]
    want = item[2] if len(item) > 2 else 1
    n = src.count(old)
    tag = old.strip().split('\n')[0][:56]
    if n != want:
        print(f'  [FAIL] {tag} → 期望 {want} 次，实际 {n} 次')
        ok = False
        continue
    src = src.replace(old, new)
    print(f'  [OK]   {tag}  ×{n}')

if not ok:
    print('\n有替换未命中，未写入')
    raise SystemExit(1)

open(P, 'w', encoding='utf-8-sig').write(src)    # 写回时带 BOM
raw = open(P, 'rb').read(3)
print(f'\n已写入，BOM={"✓ 保留" if raw == b"\\xef\\xbb\\xbf" else "✗ 丢失"}  '
      f'大小 {os.path.getsize(P)} 字节')

chk = open(P, encoding='utf-8-sig').read()
for k in ('$NoVlm', '[5/5]', 'image_vlm.py', 'glm_key.txt', 'image_ocr.py'):
    print(f'  复核 {k:16} {"✓" if k in chk else "✗"}')
print('  残留旧编号 [x/4]:', '有 ✗' if '/4]' in chk else '无 ✓')
