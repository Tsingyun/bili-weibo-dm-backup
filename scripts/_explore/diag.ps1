# 诊断脚本（一次性排查用）：确认 node 能跑、专用浏览器是否活着、CDP 探测与抓取能否执行。
# 位置：scripts\_explore\ → 项目根 = 往上两级；日志与临时产物写到项目根的**父目录**。
# 用法：powershell -File scripts\_explore\diag.ps1   然后看父目录下的 _diag.log
$Repo   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Parent = Split-Path -Parent $Repo
$log    = Join-Path $Parent '_diag.log'
$alive  = Join-Path $Parent '_node_alive.txt'
$node   = 'node'

"=== node exists ===" | Out-File $log -Encoding utf8
[bool](Get-Command $node -ErrorAction SilentlyContinue) | Out-File $log -Append -Encoding utf8

"=== trivial node run ===" | Out-File $log -Append -Encoding utf8
(& $node -e "require('fs').writeFileSync(process.argv[1],'alive')" $alive 2>&1) | Out-File $log -Append -Encoding utf8
"node_exit=$LASTEXITCODE" | Out-File $log -Append -Encoding utf8
"file_created=" + (Test-Path $alive) | Out-File $log -Append -Encoding utf8

"=== dedicated browser alive ===" | Out-File $log -Append -Encoding utf8
"count=" + ((Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*dm-backup*' } | Measure-Object).Count) |
  Out-File $log -Append -Encoding utf8

"=== cdp probe ===" | Out-File $log -Append -Encoding utf8
(& $node (Join-Path $PSScriptRoot 'probe2.mjs') 2>&1) | Out-File $log -Append -Encoding utf8
"probe_exit=$LASTEXITCODE" | Out-File $log -Append -Encoding utf8

"=== run step2 with full capture ===" | Out-File $log -Append -Encoding utf8
(& $node (Join-Path $PSScriptRoot 'step2_contacts.mjs') 2>&1) | Out-File $log -Append -Encoding utf8
"step2_exit=$LASTEXITCODE" | Out-File $log -Append -Encoding utf8
"step2_log_exists=" + (Test-Path (Join-Path $Repo 'data\raw\step2.log')) | Out-File $log -Append -Encoding utf8
