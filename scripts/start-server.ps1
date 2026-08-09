#Requires -Version 7
<#
.SYNOPSIS
  启动 Cursor 远程控制台（独立后台进程，可延迟）。
.PARAMETER DelaySeconds
  启动前等待秒数，默认 0。
.PARAMETER NodePath
  可选，指定 node.exe 绝对路径；未指定时自动探测。
#>
param(
  [int]$DelaySeconds = 0,
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Port = 20267
$LogDir = Join-Path $ProjectRoot "data"
$StdoutLog = Join-Path $LogDir "server.log"
$StderrLog = Join-Path $LogDir "server.err.log"
$NodePathFile = Join-Path $LogDir "autostart-node-path.txt"
$ServerEntry = Join-Path $ProjectRoot "dist\src\server.js"

function Test-PortListening {
  param([int]$LocalPort)
  return [bool](Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue)
}

function Resolve-NodeExe {
  param([string]$Preferred)

  if ($Preferred -and (Test-Path -LiteralPath $Preferred)) {
    return (Resolve-Path -LiteralPath $Preferred).Path
  }

  if (Test-Path -LiteralPath $NodePathFile) {
    $saved = (Get-Content -LiteralPath $NodePathFile -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($saved -and (Test-Path -LiteralPath $saved)) {
      return (Resolve-Path -LiteralPath $saved).Path
    }
  }

  $fromPath = Get-Command node -ErrorAction SilentlyContinue
  if ($fromPath -and $fromPath.Source) {
    return $fromPath.Source
  }

  $candidates = @(
    "C:\soft\mise\data\shims\node.exe",
    (Join-Path $env:USERPROFILE "AppData\Local\mise\shims\node.exe"),
    (Join-Path $env:LOCALAPPDATA "mise\shims\node.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "未找到 node.exe。请先安装 Node，或在安装自启时传入 -NodePath。"
}

if ($DelaySeconds -gt 0) {
  Write-Host "延迟 ${DelaySeconds}s 后启动..."
  Start-Sleep -Seconds $DelaySeconds
}

if (Test-PortListening -LocalPort $Port) {
  Write-Host "端口 $Port 已在监听，跳过启动。"
  exit 0
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$node = Resolve-NodeExe -Preferred $NodePath

if (-not (Test-Path -LiteralPath $ServerEntry)) {
  Write-Host "未找到构建产物，尝试 pnpm build..."
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if (-not $pnpm) {
    throw "缺少 $ServerEntry，且当前环境找不到 pnpm，请先手动执行 pnpm build。"
  }
  Push-Location $ProjectRoot
  try {
    & pnpm build
  } finally {
    Pop-Location
  }
  if (-not (Test-Path -LiteralPath $ServerEntry)) {
    throw "构建后仍未找到 $ServerEntry"
  }
}

# 轮转过大日志，避免无限增长
foreach ($logFile in @($StdoutLog, $StderrLog)) {
  if ((Test-Path -LiteralPath $logFile) -and ((Get-Item -LiteralPath $logFile).Length -gt 5MB)) {
    Move-Item -LiteralPath $logFile -Destination ($logFile + ".old") -Force
  }
}

Write-Host "使用 Node: $node"
Write-Host "工作目录: $ProjectRoot"
Start-Process -FilePath $node `
  -ArgumentList "`"$ServerEntry`"" `
  -WorkingDirectory $ProjectRoot `
  -RedirectStandardOutput $StdoutLog `
  -RedirectStandardError $StderrLog `
  -WindowStyle Hidden

# 等待端口就绪
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline) {
  if (Test-PortListening -LocalPort $Port) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
      Write-Host ("服务已启动: " + ($health | ConvertTo-Json -Compress))
      exit 0
    } catch {
      # 端口已开但健康检查稍晚
    }
  }
  Start-Sleep -Milliseconds 400
}

Write-Host "进程已拉起，但 $Port 尚未就绪，请检查 data/server.log / data/server.err.log"
exit 0
