# ============================================================
# P0-4 · 注册 / 查看 / 删除「定时自动更新」计划任务
# ============================================================
# 用 Windows 自带的计划任务（Task Scheduler），不依赖任何云服务、不装任何东西。
# 任务内容是调用 scripts\auto_update.ps1（静默跑完自己退出，日志在 logs\）。
#
# ⚠ 注册计划任务属于「改系统状态」，有的受控环境（沙箱 / 只读磁盘）会直接拦掉。
#     所以最稳的做法：由你双击一次「注册定时更新.cmd」手动注册。
#     （如果之前已经用命令行注册成功过，就不用再双击了：双击 -Status 可查看。
#      实测本机 2026-09-21 用命令行注册是成功的。）
#
# ⚠ 任务只在**你已登录**时运行：抓取要靠本机浏览器，服务会话里没有桌面。
#
# ⚠ 本文件必须保存为「UTF-8 带 BOM」，否则 Windows PowerShell 5.1 会把中文读成乱码。
#
# 用法：
#   -Register  [-DaysOfWeek Monday] [-At 08:00] [-Sessions weibo,bili]
#              [-Daily]（改成每天跑；默认每周）
#   -Unregister [-TaskName ...]
#   -Status     [-TaskName ...]
#   -RunNow     [-TaskName ...]
#
# 默认（不带频率参数）= 每周一 08:00 跑一次。
# ============================================================
param(
  [switch]$Register,
  [switch]$Unregister,
  [switch]$Status,
  [switch]$RunNow,
  # 每周跑一次（默认行为：不传 -Daily 就是它）
  [switch]$Weekly,
  # 每天跑一次（和默认的「每周」二选一）
  [switch]$Daily,
  # -Weekly 时生效：星期几。多个用逗号分隔，例如 Monday 或 Monday,Thursday
  [string]$DaysOfWeek = 'Monday',
  # 几点跑，24 小时制 HH:mm（默认早上 8 点）
  [string]$At = '08:00',
  # 跑哪些会话（传给 auto_update.ps1 -Sessions）
  [string]$Sessions = 'weibo,bili',
  # 额外传给 auto_update.ps1 的参数，例如 '-Compress' 或 '-SkipIndex'
  [string]$ExtraArgs = '',
  [string]$TaskName = '私信备份自动更新'
)

$ErrorActionPreference = 'Stop'
try {
  & chcp.com 65001 | Out-Null
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$root    = Split-Path -Parent $PSScriptRoot
$autoPs1 = Join-Path $PSScriptRoot 'auto_update.ps1'

function Fail([string]$m) { Write-Host "[x] $m" -ForegroundColor Red; exit 1 }
function Ok([string]$m)   { Write-Host "[ok] $m" -ForegroundColor Green }
function Info([string]$m) { Write-Host "     $m" }

if (-not (Test-Path $autoPs1)) { Fail "找不到 $autoPs1" }

$hasCmdlet = [bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)
if (-not $hasCmdlet) {
  Fail "这台机器上没有 Register-ScheduledTask（需要 Windows 8 / Server 2012 以上）"
}

function Get-Task { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

# 旧版本用过的默认任务名（改名前的）。取消时顺手清掉，
# 免得留下一个还在按老时间跑的僵尸任务。
$LegacyTaskNames = @('私信备份每日自动更新') | Where-Object { $_ -ne $TaskName }

function Show-Status {
  $t = Get-Task
  if (-not $t) {
    Write-Host "当前没有名为「$TaskName」的计划任务。"
    Write-Host "双击「注册定时更新.cmd」可以创建。"
    return
  }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "任务名：$TaskName"
  Write-Host ("状态：{0}" -f $t.State)
  $trg = $t.Triggers | Select-Object -First 1
  if ($trg -and $trg.DaysOfWeek) {
    Write-Host ("触发器：每周 {0} {1}" -f $trg.DaysOfWeek, $trg.StartBoundary)
  } else {
    Write-Host ("触发器：每天 {0}" -f $trg.StartBoundary)
  }
  Write-Host ("执行：{0} {1}" -f $t.Actions[0].Execute, $t.Actions[0].Arguments)
  Write-Host ("上次运行：{0}　结果码：{1}" -f $info.LastRunTime, $info.LastTaskResult)
  Write-Host ("下次运行：{0}" -f $info.NextRunTime)
  Write-Host ""
  Write-Host "结果码 0 = 成功；其它值说明 auto_update.ps1 里有步骤失败，去看 logs\auto_*.log"
}

if ($Status -or (-not $Register -and -not $Unregister -and -not $RunNow)) {
  Show-Status
  exit 0
}

if ($Unregister) {
  $removed = 0
  foreach ($n in (@($TaskName) + $LegacyTaskNames)) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      Ok "已删除计划任务「$n」"
      $removed++
    }
  }
  if ($removed -eq 0) { Write-Host "本来就没有这个任务，无需删除。"; exit 0 }
  exit 0
}

if ($RunNow) {
  $t = Get-Task
  if (-not $t) { Fail "任务不存在，先注册：-Register" }
  Start-ScheduledTask -TaskName $TaskName
  Ok "已触发一次，稍后看 logs\auto_*.log"
  exit 0
}

# ---------- 注册 ----------
if ($At -notmatch '^\d{1,2}:\d{2}$') { Fail "-At 要写成 HH:mm，例如 20:30（收到的是「$At」）" }
$hh, $mm = $At.Split(':')
$AtNorm = "{0:D2}:{1:D2}" -f [int]$hh, [int]$mm
try {
  $when = [datetime]::ParseExact($AtNorm, 'HH:mm', $null)
} catch {
  Fail "-At 的时间不合法：$At"
}

$argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$autoPs1`" -Sessions $Sessions"
if ($ExtraArgs.Trim()) { $argLine += " $($ExtraArgs.Trim())" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $root

# 频率：默认「每周」，由 -DaysOfWeek 指定星期几；带了 -Daily 就是「每天」。
# -At 传进去的是最近一次的时间点，触发器会按上面的频率重复。
if ($Daily) {
  $trigger  = New-ScheduledTaskTrigger -Daily -At $when
  $freqDesc = "每天 $AtNorm"
} else {
  $weekDays = @($DaysOfWeek.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($weekDays.Count -eq 0) { Fail "-DaysOfWeek 不能为空（例如 Monday 或 Monday,Thursday）" }
  $trigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $weekDays -At $when
  $freqDesc = "每周 $($weekDays -join '、') $AtNorm"
}

# StartWhenAvailable：错过了（比如关机）下次开机补跑一次
# ExecutionTimeLimit：跑满 3 小时就掐掉，避免卡死挂到第二天
# MultipleInstances IgnoreNew：上一次还没跑完就别再起一个（两个抓取脚本会抢同一个浏览器）
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 3)

# 用当前用户注册（Interactive），这样才有桌面会话给浏览器用；不存密码
$principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\$env:USERNAME") `
  -LogonType Interactive -RunLevel Limited

$desc = "本机私信备份自动更新（纯本地，无云服务）。调用 scripts\auto_update.ps1，日志写在 logs\ 目录。"

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description $desc -Force | Out-Null

Ok "已注册计划任务「$TaskName」，$freqDesc 自动跑一次"
Info "执行：powershell.exe $argLine"
Info "只在当前用户已登录时运行（抓取需要本机浏览器）"
Info "日志目录：$root\logs"
Info "想立刻试一次：powershell -ExecutionPolicy Bypass -File scripts\schedule_task.ps1 -RunNow"
Info "想改成每天跑：注册定时更新.cmd -Daily -At 21:30"
Info "改星期几 / 改时间：注册定时更新.cmd -DaysOfWeek Monday,Thursday -At 09:30"
Info "不想用了：双击「取消定时更新.cmd」"
Write-Host ""
Show-Status
