# B站私信备份 · 启动器 + 更新器
# 用法：powershell -ExecutionPolicy Bypass -File scripts\bili.ps1 [-Full] [-NoImg] [-Rebuild] [-NoVlm] [-Probe]
# 注意：本文件必须保存为「UTF-8 带 BOM」，否则 Windows PowerShell 5.1 会把中文读成乱码。
param(
  [switch]$Full,
  [switch]$NoImg,
  [switch]$Rebuild,
  [switch]$NoVlm,
  [switch]$Probe
)
$ErrorActionPreference = 'Continue'
# 保证中文在任意控制台都能正确显示：自己切到 UTF-8，不依赖外部 chcp
try {
  & chcp.com 65001 | Out-Null
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}
$root    = Split-Path -Parent $PSScriptRoot
$profile = Join-Path $root '.edge-profile'
$port    = 9333
# 聊天页地址由 sessions.json 的 peer.uid 决定 —— 不写死任何 mid，换人只改配置
$peerMid = ''
try {
  $man = Get-Content (Join-Path $root 'sessions.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $s   = $man.sessions | Where-Object { $_.key -eq 'bili' } | Select-Object -First 1
  if ($s -and $s.peer -and $s.peer.uid) { $peerMid = [string]$s.peer.uid }
} catch {}
if ($peerMid) { $chatUrl = 'https://message.bilibili.com/#/whisper/mid' + $peerMid }
else          { $chatUrl = 'https://message.bilibili.com/' }   # 没配就开到消息首页，自己点会话

function Say($m) { Write-Host $m }

function Test-CdpPort([int]$p) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(700)
    if ($ok) {
      try { $c.EndConnect($iar) } catch { $c.Close(); return $false }
      $c.Close(); return $true
    }
    $c.Close(); return $false
  } catch { return $false }
}

function Find-Edge {
  $cands = @(
    'C:\Program Files (x86)\Microsoft\Edge Dev\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge Dev\Application\msedge.exe',
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
  )
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  return $null
}

function Find-Node {
  # 顺序：PATH 上的 node 最优先（换台电脑也能用），再退回常见安装位置，
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cands = @(
    'C:\Program Files\nodejs\node.exe'
  )
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  return $null
}

Say ''
Say '=========================================='
if ($Probe)        { Say '  B站私信备份  —  接口探查（只抓一页）' }
elseif ($Rebuild)  { Say '  B站私信备份  —  全量重建' }
else               { Say '  B站私信备份  —  增量更新' }
Say '=========================================='
Say ''

$node = Find-Node
if (-not $node) { Say '[×] 未找到 Node.js，无法继续。'; exit 1 }

# 1) 确保专用浏览器在运行（带调试端口），并停到 B站私信页
$edge = Find-Edge
if (-not $edge) { Say '[×] 未找到 Edge / Chrome。'; exit 1 }

if (-not (Test-CdpPort $port)) {
  Say '[1/5] 正在启动专用浏览器…'
  Say '      （首次需要在这个窗口里扫码登录 B站，登录一次以后就不用再登了）'
  if (-not (Test-Path $profile)) { New-Item -ItemType Directory -Force -Path $profile | Out-Null }
  $cmdline = '"' + $edge + '" --user-data-dir="' + $profile + '" --remote-debugging-port=' + $port +
             ' --remote-allow-origins=http://127.0.0.1:' + $port + ',http://localhost:' + $port + ' --no-first-run --no-default-browser-check "' + $chatUrl + '"'
  try {
    Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline } | Out-Null
  } catch {
    Start-Process -FilePath $edge -ArgumentList @(
      "--user-data-dir=`"$profile`"", "--remote-debugging-port=$port",
      "--remote-allow-origins=http://127.0.0.1:$port,http://localhost:$port", '--no-first-run', '--no-default-browser-check',
      $chatUrl)
  }
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 1000
    if (Test-CdpPort $port) { $ok = $true; break }
  }
  if (-not $ok) { Say '[×] 浏览器调试端口未能打开，请重试。'; exit 2 }
  Say '      浏览器就绪。'
} else {
  Say '[1/5] 专用浏览器已在运行，复用同一个窗口。'
  if (-not $NoImg -and -not $Probe) {
    # 让浏览器把私信页打开（已运行的实例会复用并新开一个标签页）
    try { Start-Process -FilePath $edge -ArgumentList @($chatUrl) | Out-Null } catch {}
  }
}

# 2) 交给 Node 主流程
Say ''
if ($Probe) {
  Say '[2/5] 探查 B站私信接口（只抓第一页，输出消息类型审计报告）…'
} else {
  Say '[2/5] 开始同步 B站聊天记录…'
}
Say ''
$args2 = @((Join-Path $PSScriptRoot 'bili_update.mjs'))
if ($Full)    { $args2 += '--full' }
if ($NoImg)   { $args2 += '--no-img' }
if ($Rebuild) { $args2 += '--rebuild' }
if ($Probe)   { $args2 += '--probe' }
& $node @args2
$code = $LASTEXITCODE

# 探查模式到此为止：不写正式数据，也不需要表情 / OCR / VLM
if ($Probe) {
  Say ''
  Say '（探查模式结束，未改动正式数据文件）'
  exit $code
}

# 3) 同步 B站表情图（让 [doge] 这类文字表情显示成图片）
if ($code -eq 0 -and -not $NoImg) {
  Say ''
  Say '[3/5] 同步 B站表情图…'
  & $node (Join-Path $PSScriptRoot 'bili_faces.mjs')
}

# 4) 图片文字索引（本地 OCR；没有装环境就自动跳过，不影响其它功能）
if ($code -eq 0 -and -not $NoImg) {
  Say ''
  $ocrPy = Join-Path $root '.ocr-env\Scripts\python.exe'
  if (Test-Path $ocrPy) {
    Say '[4/5] 识别新图片里的文字（在本机进行，图片不外传）…'
    $env:PYTHONIOENCODING = 'utf-8'
    & $ocrPy -u (Join-Path $PSScriptRoot 'image_ocr.py') --set bili
  } else {
    Say '[4/5] 跳过图片文字索引：未安装 OCR 环境（双击「命令/图片与OCR/安装OCR环境.cmd」可启用）。'
  }
}

# 5) 图片内容描述（云端 GLM-4.6V-Flash，仅处理「没有文字的照片」；没配 Key 就跳过）
if ($code -eq 0 -and -not $NoImg -and -not $NoVlm) {
  Say ''
  $ocrPy   = Join-Path $root '.ocr-env\Scripts\python.exe'
  $keyFile = Join-Path $root 'data\glm_key.txt'
  $hasKey  = (Test-Path $keyFile) -or [bool]$env:GLM_API_KEY
  if ((Test-Path $ocrPy) -and $hasKey) {
    Say '[5/5] 为新图片生成内容描述（只上传无文字的照片，免费模型，可能较慢）…'
    $env:PYTHONIOENCODING = 'utf-8'
    & $ocrPy -u (Join-Path $PSScriptRoot 'image_vlm.py') --set bili
  } else {
    Say '[5/5] 跳过图片内容描述：未安装环境或未配置 API Key。'
  }
}

Say ''
if ($code -eq 0) {
  Say '[完成] 刷新（或双击）「查看备份.html」，点顶部的「B站」就能看到最新备份。'
} elseif ($code -eq 3) {
  Say '----------------------------------------------------------'
  Say ' B站登录态已失效。'
  Say ' 请在弹出的浏览器窗口里扫码登录 B站，'
  Say ' 登录成功后再运行一次本程序即可。'
  Say '----------------------------------------------------------'
} elseif ($code -eq 2) {
  Say '----------------------------------------------------------'
  Say ' 还没有 B站登录凭据。'
  Say ' 请在弹出的浏览器窗口里扫码登录 B站（message.bilibili.com），'
  Say ' 登录成功后再运行一次本程序即可。'
  Say '----------------------------------------------------------'
} elseif ($code -eq 4) {
  Say '[请先配置] 还没有填「要备份谁的私信」。按上面的提示改好 sessions.json 后，重新运行一次即可。'
} else {
  Say ('[失败] 退出码 ' + $code + '，请把上面的报错信息保留下来（截图 / 复制），方便排查。')
}
exit $code
