# ============================================================
#  定期识别图片文字（独立任务，不抓取消息、不碰任何备份流程）
# ------------------------------------------------------------
#  这个脚本只做一件事：按计划调用 image_ocr.py 的**增量**识别，
#  把新下载、还没识别过的图片补上文字索引，最后重建一次本地全文检索库
#  （让「搜索备份」也搜得到新文字）。不联网、不登录、不抓取、不压缩、
#  不改任何一份已有备份的消息数据。
#
#  它和「注册定时更新.cmd」注册的是**两个互不相干**的计划任务：
#    私信备份自动更新      → auto_update.ps1（抓取 + 全套索引，含 OCR）
#    私信备份图片文字识别  → 本脚本（只跑 OCR + 重建搜索索引）
#  已经有定时更新的机器，不必再注册本任务；本任务是给
#  「只想要定期补 OCR、不想动抓取」的场景用的独立能力。
#
#  用法：
#    -Register                     注册（默认每周一 08:00）
#    -Register -Daily -At 21:30    改成每天 21:30
#    -Register -DaysOfWeek Monday,Thursday
#    -RunNow                       立刻跑一次（不需要先注册，方便试）
#    -Status                       看任务状态（默认动作）
#    -Unregister                   取消
#    -Sessions weibo,bili          指定会话；不写 = 自动读 sessions.json 里
#                                  所有非 imported 的会话
#
#  ⚠ 导入的他人备份（imported=true）永远跳过 —— 那是只读副本。
# ============================================================
param(
  [switch]$Register,
  [switch]$Unregister,
  [switch]$Status,
  [switch]$RunNow,
  [switch]$Weekly,
  [switch]$Daily,
  [string]$DaysOfWeek = 'Monday',
  [string]$At = '08:00',
  [string]$Sessions = 'auto',
  [string]$TaskName = '私信备份图片文字识别'
)

$ErrorActionPreference = 'Stop'
try {
  & chcp.com 65001 | Out-Null
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$root    = Split-Path -Parent $PSScriptRoot
$scripts = Join-Path $root 'scripts'
$py      = Join-Path $root '.ocr-env\Scripts\python.exe'
$manFile = Join-Path $root 'sessions.json'

function Say([string]$m) { Write-Host $m }
function Ok([string]$m)  { Write-Host ("  [ok] " + $m) }
function Fail([string]$m) { Write-Host ("  [x] " + $m); exit 1 }

function Get-OcrSessions {
  if ($Sessions -and $Sessions -ne 'auto') {
    return @($Sessions.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  }
  if (-not (Test-Path $manFile)) { Fail "找不到 sessions.json：$manFile" }
  $man = Get-Content $manFile -Raw -Encoding UTF8 | ConvertFrom-Json
  return @($man.sessions | Where-Object { -not $_.imported } | ForEach-Object { $_.key })
}

# 与 auto_update.ps1 / webui.ps1 同款找法：优先系统安装目录，再回落 PATH。
# 找不到 node 只是「搜索备份」索引没刷新，OCR 本身不受影响 → 只警告不判失败。
function Find-Node {
  $cands = @('C:\Program Files\nodejs\node.exe')
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# ---------- 真正干活：一次增量 OCR ----------
function Invoke-OcrOnce {
  $logDir = Join-Path $root 'logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $logFile = Join-Path $logDir ("ocr_{0}.log" -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
  function L([string]$m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
    Add-Content -Path $logFile -Value $line -Encoding UTF8
    Say $line
  }

  L "==== 定期图片文字识别开始 ===="
  if (-not (Test-Path $py)) {
    L "跳过：没装 OCR 环境（$py 不存在）。双击「命令/图片与OCR/安装OCR环境.cmd」可启用。"
    L "==== 结束（跳过，不算失败）===="
    return 0
  }

  $keys = Get-OcrSessions
  if ($keys.Count -eq 0) { L "没有可识别的会话（导入的只读备份会跳过）。"; return 0 }

  $env:PYTHONIOENCODING = 'utf-8'
  $env:PYTHONUTF8 = '1'
  $bad = 0
  foreach ($k in $keys) {
    L "识别会话：$k"
    & $py -u (Join-Path $scripts 'image_ocr.py') --set $k --quiet *>&1 |
      ForEach-Object { L ([string]$_) }
    if ($LASTEXITCODE -ne 0) { $bad++; L "[NG] $k 退出码 $LASTEXITCODE" }
    else { L "[ok] $k 完成" }
  }

  # 只跑 OCR 不会自动更新 search/dm_search.db，而「搜索备份」读的正是那个库。
  # 全量重建约 1~2 秒、纯本地 SQLite；node 缺失只警告（查看页读 ocr.js，不受影响）。
  $node = Find-Node
  if ($node) {
    L "重建搜索索引（让「搜索备份」搜到新文字）"
    & $node --disable-warning=ExperimentalWarning (Join-Path $scripts 'build_fts.mjs') *>&1 |
      ForEach-Object { L ([string]$_) }
    if ($LASTEXITCODE -ne 0) { L "[warn] 搜索索引重建失败（退出码 $LASTEXITCODE），可手动双击「重建搜索索引.cmd」" }
    else { L "[ok] 搜索索引已刷新" }
  } else {
    L "[warn] 没找到 node.exe，跳过搜索索引重建；OCR 结果仍可在查看页搜到"
  }

  L "==== 结束：共 $($keys.Count) 个会话，失败 $bad 个 · 日志 $logFile ===="
  if ($bad -gt 0) { return 1 }
  return 0
}

# ---------- 立刻跑一次 ----------
if ($RunNow) { exit (Invoke-OcrOnce) }

# ---------- 状态 ----------
function Show-Status {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) {
    Say "还没有注册「$TaskName」。双击「命令/图片与OCR/定期识别图片文字.cmd」即可。"
    Say "OCR 环境：$(if (Test-Path $py) { '已安装' } else { '未安装' })"
    return
  }
  $i = Get-ScheduledTaskInfo -TaskName $TaskName
  Say "任务：$TaskName（$($t.State)）"
  Say "执行：$($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
  Say "上次：$($i.LastRunTime)　结果码 $($i.LastTaskResult)　下次：$($i.NextRunTime)"
  Say "日志目录：$root\logs"
}
if ($Status -or (-not $Register -and -not $Unregister)) { Show-Status; exit 0 }

# ---------- 取消 ----------
if ($Unregister) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Ok "已删除计划任务「$TaskName」"
  } else { Say "本来就没有这个任务，无需删除。" }
  exit 0
}

# ---------- 注册 ----------
if ($At -notmatch '^\d{1,2}:\d{2}$') { Fail "-At 要写成 HH:mm，例如 21:30（收到的是「$At」）" }
$hh, $mm = $At.Split(':')
$AtNorm = "{0:D2}:{1:D2}" -f [int]$hh, [int]$mm
try { $when = [datetime]::ParseExact($AtNorm, 'HH:mm', $null) }
catch { Fail "-At 的时间不合法：$At" }

if ($Daily) {
  $trigger  = New-ScheduledTaskTrigger -Daily -At $when
  $freqDesc = "每天 $AtNorm"
} else {
  $weekDays = @($DaysOfWeek.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($weekDays.Count -eq 0) { Fail "-DaysOfWeek 不能为空（例如 Monday 或 Monday,Thursday）" }
  $trigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $weekDays -At $when
  $freqDesc = "每周 $($weekDays -join '、') $AtNorm"
}

$argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -RunNow"
if ($Sessions -and $Sessions -ne 'auto') { $argLine += " -Sessions $Sessions" }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $root

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\$env:USERNAME") `
  -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description '只补做图片文字识别（本地 OCR，不抓取消息、不联网）；日志在 logs\ocr_*.log' `
  -Force | Out-Null

Ok "已注册「$TaskName」，$freqDesc 跑一次"
Say "  执行：powershell.exe $argLine"
Say "  OCR 环境：$(if (Test-Path $py) { '已安装' } else { '未安装 —— 先双击「安装OCR环境.cmd」' })"
Say "  想立刻试一次：powershell -ExecutionPolicy Bypass -File scripts\ocr_scheduled.ps1 -RunNow"
Say "  不想用了：双击「命令/图片与OCR/取消定期识别.cmd」"
Say ""
Show-Status
