# 私信备份 · 本地 WebUI 启动器
# 用法：powershell -ExecutionPolicy Bypass -File scripts\webui.ps1 [-Port 8787] [-NoOpen] [-OpenPath /viewer]
#   -OpenPath 指定浏览器直接打开哪个路径；高清截图导出要用 /viewer
#   （file:// 下浏览器禁止把本地图片合成进 canvas，走本机 http 就没有这个限制）
# 注意：本文件必须保存为「UTF-8 带 BOM」，否则 Windows PowerShell 5.1 会把中文读成乱码。
param(
  [int]$Port = 8787,
  [switch]$NoOpen,
  [string]$OpenPath = '/'
)
$ErrorActionPreference = 'Continue'
# 保证中文在任意控制台都能正确显示：自己切到 UTF-8，不依赖外部 chcp
try {
  & chcp.com 65001 | Out-Null
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$root = Split-Path -Parent $PSScriptRoot
function Say($m) { Write-Host $m }

function Find-Node {
  # 顺序刻意是「内置优先」：
  #   · 便携包在 runtime\node\ 里自带一份运行时 —— 先用它，才谈得上
  #     「下载即用」且版本可控（不受用户机器上装没装 Node / 装的是哪版影响）。
  #   · 直接 clone 仓库跑的情况没有 runtime\，自然回退到系统 Node，行为不变。
  $builtin = Join-Path $root 'runtime\node\node.exe'
  if (Test-Path $builtin) { $script:NodeSource = '内置'; return $builtin }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $script:NodeSource = '系统'; return $cmd.Source }
  $cands = @(
    'C:\Program Files\nodejs\node.exe'
  )
  foreach ($c in $cands) { if (Test-Path $c) { $script:NodeSource = '系统'; return $c } }
  return $null
}

Say ''
Say '=========================================================='
Say '  私信备份 · 本地 WebUI'
Say '=========================================================='
Say ''

$server = Join-Path $root 'scripts\server.mjs'
$index  = Join-Path $root 'webui\index.html'

if (-not (Test-Path $server) -or -not (Test-Path $index)) {
  Say '[×] 没找到 WebUI 的文件：'
  Say ('    ' + $server)
  Say ('    ' + $index)
  Say ''
  Say '    如果你是从旧版本升级上来的，请先拉取最新代码：'
  Say '        git pull'
  exit 1
}

$node = Find-Node
if (-not $node) {
  Say '[×] 没找到 Node.js。'
  Say ''
  Say '    这个界面是一个本地小程序，需要 Node.js 才能跑（它同时也是抓取脚本的运行时）。'
  Say '    去 https://nodejs.org/ 下载 LTS 版，装完**重新打开**这个窗口再试。'
  Say '    （安装时一路默认即可，不需要勾选任何额外组件）'
  exit 1
}

# 版本门槛：本项目用到 node:string_decoder / 顶层 await 的 ESM，18 以下会直接报语法错。
$ver = (& $node -e "process.stdout.write(process.versions.node)") 2>$null
$major = 0
try { $major = [int]($ver.Split('.')[0]) } catch { $major = 0 }
if ($major -lt 18) {
  Say ('[×] Node.js 版本太低：当前 ' + $ver + '，需要 18 或更高。')
  Say '    去 https://nodejs.org/ 下 LTS 版覆盖安装即可。'
  exit 1
}

Say ('  Node      ' + $ver + '（' + $NodeSource + '）   ' + $node)
Say ('  工作区    ' + $root)
# 中文/空格路径绝大多数情况能跑，但个别环节（浏览器调试端口、命令行传参）
# 历史上真出过问题。这里**只提示不阻断** —— 阻断会把能用的用户挡在门外。
if ($root -match '[^\x00-\x7F]' -or $root.Contains(' ')) {
  Say ''
  Say '  ⚠ 工作区路径里含有中文或空格。'
  Say '    多数情况能正常跑；但万一后面卡住（尤其是登录或抓取那一步），'
  Say '    把整个文件夹挪到 D:\dm-backup 这类纯英文、无空格的路径，再双击一次即可。'
}
Say ''
Say '  正在启动本地服务，马上会自动打开浏览器…'
Say '  ⚠ 这个窗口**不要关**：关掉它就等于关掉服务，网页会连不上。'
Say '    用完想结束时，回到这个窗口按 Ctrl+C。'
Say ''

$nodeArgs = @($server, '--port', "$Port")
# --open 后面跟的路径只有在以 / 开头时才会被 server.mjs 采纳，其余一律回退到首页
if (-not $NoOpen) { $nodeArgs += '--open'; if ($OpenPath -and $OpenPath.StartsWith('/') -and $OpenPath -ne '/') { $nodeArgs += $OpenPath } }

& $node @nodeArgs
$code = $LASTEXITCODE

Say ''
if ($code -ne 0) {
  Say ('[×] 服务退出（退出码 ' + $code + '）。')
  Say '    端口被占用的话，服务端会自己往后找下一个端口，真正的地址看上面那行「地址」。'
} else {
  Say '服务已结束。'
}
exit $code
