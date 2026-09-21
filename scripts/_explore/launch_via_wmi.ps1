# 诊断脚本（一次性排查用）：用 WMI 拉起一个专用 Edge（带独立 user-data-dir + CDP 端口），
# 然后检查进程、DevToolsActivePort 与 node 探测结果。日志写到项目根的**父目录**。
# 用法：powershell -File scripts\_explore\launch_via_wmi.ps1   然后看父目录下的 _launch_wmi.log
$ErrorActionPreference = 'Continue'
$Repo    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$log     = Join-Path (Split-Path -Parent $Repo) '_launch_wmi.log'
$exe     = 'C:\Program Files (x86)\Microsoft\Edge Dev\Application\msedge.exe'
$profile = Join-Path $Repo '.edge-profile'
$node    = 'node'

"=== kill leftovers ===" | Out-File $log -Encoding utf8
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*dm-backup*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 3

$cmdline = '"' + $exe + '" --user-data-dir="' + $profile + '" --remote-debugging-port=9333 --remote-allow-origins=* --no-first-run --no-default-browser-check --disable-features=msEdgeSplashScreen about:blank'
"cmdline=$cmdline" | Out-File $log -Append -Encoding utf8

"=== WMI create ===" | Out-File $log -Append -Encoding utf8
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
"ReturnValue=$($res.ReturnValue)  ProcessId=$($res.ProcessId)" | Out-File $log -Append -Encoding utf8

Start-Sleep -Seconds 12

"=== dedicated procs ===" | Out-File $log -Append -Encoding utf8
(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*dm-backup*' } |
  Select-Object ProcessId,ParentProcessId | Format-Table -AutoSize | Out-String) |
  Out-File $log -Append -Encoding utf8

"=== DevToolsActivePort ===" | Out-File $log -Append -Encoding utf8
Test-Path (Join-Path $profile 'DevToolsActivePort') | Out-File $log -Append -Encoding utf8
(Get-Content (Join-Path $profile 'DevToolsActivePort') -ErrorAction SilentlyContinue) |
  Out-File $log -Append -Encoding utf8

"=== node probe ===" | Out-File $log -Append -Encoding utf8
(& $node (Join-Path $PSScriptRoot 'probe2.mjs') 2>&1) | Out-File $log -Append -Encoding utf8
