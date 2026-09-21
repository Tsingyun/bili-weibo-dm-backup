# ============================================================
# P0-4 · 无人值守自动更新（给 Windows 计划任务调用的静默版）
# ============================================================
# 与「更新备份.cmd」的区别：
#   · 不弹交互提示、不 pause，跑完自己退出，退出码 0=全部成功 / 1=有失败
#   · 每一步的输出都写进 logs\auto_<时间戳>.log，事后能翻
#   · 一次跑完：抓取增量 → 图片索引(OCR) → 图片描述(VLM) → （可选）压缩
#               → 索引快照 → 一键体检
#
# ⚠ 需要**用户已登录**的桌面会话：抓取要靠本机浏览器（Edge + CDP），
#   服务会话里没有桌面，浏览器起不来。注册任务时用的是「登录时运行」。
#
# ⚠ 本文件必须保存为「UTF-8 带 BOM」，否则 Windows PowerShell 5.1 会把中文读成乱码。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\auto_update.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\auto_update.ps1 -Sessions bili
#   powershell -ExecutionPolicy Bypass -File scripts\auto_update.ps1 -SkipIndex -Compress
# ============================================================
param(
  # 逗号分隔的会话 key，对应 sessions.json 里的 key；默认两个都跑
  [string]$Sessions = 'weibo,bili',
  # 跳过图片抓取（只更新消息文本，快）
  [switch]$NoImages,
  # 跳过图片索引（OCR + 图片描述）—— 这两步最慢
  [switch]$SkipIndex,
  # 跳过图片描述（只做 OCR）
  [switch]$SkipVlm,
  # 顺带把图片压成 WebP 并删掉原图（默认不做：这是不可逆操作）
  [switch]$Compress,
  # 跳过索引快照
  [switch]$NoSnapshot,
  # 跳过一键体检
  [switch]$NoDoctor,
  # 把每一步的输出也实时打到控制台（默认只在失败时打）
  [switch]$Verbose
)

$ErrorActionPreference = 'Continue'
try {
  & chcp.com 65001 | Out-Null
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$root     = Split-Path -Parent $PSScriptRoot
$scripts  = Join-Path $root 'scripts'
$logDir   = Join-Path $root 'logs'
$stamp    = Get-Date -Format 'yyyyMMdd_HHmmss'
$logFile  = Join-Path $logDir ("auto_{0}.log" -f $stamp)
$histFile = Join-Path $logDir 'auto_history.txt'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$failures = New-Object System.Collections.Generic.List[string]
$steps    = 0

function Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

# 跑一个外部命令并把输出收进日志；返回退出码
function RunStep([string]$title, [string]$exe, [string[]]$argv) {
  $script:steps++
  Log ("── {0}" -f $title)
  Log ("   {0} {1}" -f $exe, ($argv -join ' '))
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  # 先把 $LASTEXITCODE 清零：命令根本没起来时它会是上一次的残留值，
  # 那样「启动失败」反而会被记成成功。
  $global:LASTEXITCODE = 0
  try {
    $out = & $exe @argv 2>&1 | Out-String
  } catch {
    $out = "启动失败：$($_.Exception.Message)"
    $global:LASTEXITCODE = 9009
  }
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 0 }
  $sw.Stop()
  if ($out -and $out.Trim()) {
    Add-Content -Path $logFile -Value $out.TrimEnd() -Encoding UTF8
    if ($Verbose) { Write-Host $out.TrimEnd() }
  }
  if ($code -ne 0) {
    Log ("   [NG] 退出码 {0}（耗时 {1:N1}s）" -f $code, $sw.Elapsed.TotalSeconds)
    $script:failures.Add("$title（退出码 $code）")
  } else {
    Log ("   [ok] 耗时 {0:N1}s" -f $sw.Elapsed.TotalSeconds)
  }
  return $code
}

# ---------- 找可执行文件 ----------
function Find-Node {
  $cands = @(
    'C:\Program Files\nodejs\node.exe'
  )
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Find-Python {
  # 优先用项目自带的 OCR 环境（RapidOCR 装在它里面，由「安装OCR环境.cmd」生成）
  $cands = @(
    (Join-Path $root '.ocr-env\Scripts\python.exe')
  )
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$node = Find-Node
$py   = Find-Python

$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

Log "==================== 自动更新开始 ===================="
Log ("项目目录：{0}" -f $root)
Log ("会话：{0}" -f $Sessions)
Log ("Node：{0}" -f ($(if ($node) { $node } else { '（没找到，跳过依赖 Node 的步骤）' })))
Log ("Python：{0}" -f ($(if ($py) { $py } else { '（没找到，跳过依赖 Python 的步骤）' })))

$sessionList = $Sessions.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }

foreach ($s in $sessionList) {
  Log ""
  Log ("########## 会话：{0} ##########" -f $s)

  # ---------- 1. 抓取增量 ----------
  $launcher = if ($s -eq 'bili') { 'bili.ps1' } elseif ($s -eq 'weibo') { 'update.ps1' } else { $null }
  if (-not $launcher) {
    Log ("   [!] 会话 {0} 没有对应的抓取脚本（只有 weibo / bili 内置），跳过抓取" -f $s)
  } else {
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $scripts $launcher))
    if ($NoImages) { $argv += '-NoImg' }
    # bili.ps1 / update.ps1 都支持 -NoVlm：自动流程里 VLM 由下面的 image_vlm.py 统一跑
    $argv += '-NoVlm'
    RunStep ("抓取增量（{0}）" -f $s) 'powershell.exe' $argv | Out-Null
  }

  # ---------- 2. 图片索引：OCR ----------
  if (-not $SkipIndex) {
    if (-not $py) {
      Log "   [!] 没有 Python，跳过 OCR 索引"
      $failures.Add("$s OCR 索引（缺 Python）")
    } else {
      RunStep ("图片内文字 OCR（{0}）" -f $s) $py @((Join-Path $scripts 'image_ocr.py'), '--set', $s) | Out-Null
    }
  }

  # ---------- 3. 图片索引：VLM ----------
  if ((-not $SkipIndex) -and (-not $SkipVlm)) {
    if (-not $py) {
      Log "   [!] 没有 Python，跳过图片描述"
      $failures.Add("$s 图片描述（缺 Python）")
    } else {
      RunStep ("图片内容描述（{0}）" -f $s) $py @((Join-Path $scripts 'image_vlm.py'), '--set', $s) | Out-Null
    }
  }

  # ---------- 4. 压缩（可选，不可逆） ----------
  if ($Compress) {
    if (-not $py) {
      Log "   [!] 没有 Python，跳过压缩"
      $failures.Add("$s 压缩（缺 Python）")
    } else {
      RunStep ("图片压缩并删原图（{0}）" -f $s) $py @((Join-Path $scripts 'compress_images.py'), '--set', $s) | Out-Null
    }
  }

  # ---------- 5. 索引快照 ----------
  if (-not $NoSnapshot) {
    if (-not $node) {
      Log "   [!] 没有 Node，跳过快照"
    } else {
      RunStep ("索引快照（{0}）" -f $s) $node @(
        (Join-Path $scripts 'snapshot.mjs'), '--make', '--session', $s, '--note', 'auto'
      ) | Out-Null
    }
  }

  # ---------- 6. 一键体检 ----------
  if (-not $NoDoctor) {
    if (-not $node) {
      Log "   [!] 没有 Node，跳过体检"
    } else {
      RunStep ("一键体检（{0}）" -f $s) $node @(
        (Join-Path $scripts 'doctor.mjs'), '--session', $s
      ) | Out-Null
    }
  }
}

# ---------- 汇总 ----------
$result = if ($failures.Count -eq 0) { '成功' } else { '失败' }
Log ""
Log ("==================== 自动更新结束（{0}）====================" -f $result)
Log ("共 {0} 个步骤，失败 {1} 个" -f $steps, $failures.Count)
foreach ($f in $failures) { Log ("  ✗ {0}" -f $f) }
Log ("日志：{0}" -f (Split-Path -Leaf $logFile))

$hist = "{0}  {1}  steps={2}  fail={3}  sessions={4}{5}" -f `
  (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $result, $steps, $failures.Count, $Sessions,
  $(if ($Compress) { '  (含压缩)' } else { '' })
Add-Content -Path $histFile -Value $hist -Encoding UTF8

# 只保留最近 60 份日志，别让 logs 无限长
Get-ChildItem -Path $logDir -Filter 'auto_*.log' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 60 |
  ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

if ($failures.Count -gt 0) { exit 1 } else { exit 0 }
