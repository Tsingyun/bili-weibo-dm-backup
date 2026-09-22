# 诊断脚本（一次性排查用）：清理残留 Edge → WMI 拉起专用 Edge → 跑 step1 探测 → 复查存活。
# 日志写到项目根的**父目录**。
# 用法：powershell -File scripts\_explore\run_step1.ps1   然后看父目录下的 _step1_run.log
$ErrorActionPreference = 'Continue'
$Repo    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$log     = Join-Path (Split-Path -Parent $Repo) '_step1_run.log'
$exe     = 'C:\Program Files (x86)\Microsoft\Edge Dev\Application\msedge.exe'
$profile = Join-Path $Repo '.edge-profile'
$node    = 'node'

"=== 1. cleanup leftovers ===" | Out-File $log -Encoding utf8
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*dm-backup*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 3

"=== 2. WMI launch ===" | Out-File $log -Append -Encoding utf8
$cmdline = '"' + $exe + '" --user-data-dir="' + $profile + '" --remote-debugging-port=9333 --remote-allow-origins=http://127.0.0.1:9333,http://localhost:9333 --no-first-run --no-default-browser-check about:blank'
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
"ReturnValue=$($res.ReturnValue) ProcessId=$($res.ProcessId)" | Out-File $log -Append -Encoding utf8

Start-Sleep -Seconds 10
"=== 3. alive check ===" | Out-File $log -Append -Encoding utf8
"dedicated_pid_count=" + ((Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*dm-backup*' } | Measure-Object).Count) |
  Out-File $log -Append -Encoding utf8

"=== 4. navigate + capture ===" | Out-File $log -Append -Encoding utf8
(& $node (Join-Path $PSScriptRoot 'step1_explore.mjs') 2>&1) | Out-File $log -Append -Encoding utf8

"=== 5. alive after ===" | Out-File $log -Append -Encoding utf8
"dedicated_pid_count=" + ((Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*dm-backup*' } | Measure-Object).Count) |
  Out-File $log -Append -Encoding utf8
