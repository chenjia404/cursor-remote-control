#Requires -Version 7
<#
.SYNOPSIS
  注册 Windows 登录后自动启动守护进程（服务挂了会再拉起）。
.PARAMETER DelaySeconds
  登录后延迟多少秒再启动，默认 60。
.PARAMETER NodePath
  可选，指定 node.exe；默认自动探测并写入 data/autostart-node-path.txt。
#>
param(
  [int]$DelaySeconds = 60,
  [string]$NodePath = "",
  [string]$TaskName = "CursorRemoteControl"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding

if ($DelaySeconds -lt 0) {
  throw "DelaySeconds 不能为负数"
}

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StartScript = Join-Path $PSScriptRoot "watchdog.ps1"
$LogDir = Join-Path $ProjectRoot "data"
$NodePathFile = Join-Path $LogDir "autostart-node-path.txt"
$ServerEntry = Join-Path $ProjectRoot "dist\src\server.js"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Resolve-NodeExe {
  param([string]$Preferred)
  if ($Preferred -and (Test-Path -LiteralPath $Preferred)) {
    return (Resolve-Path -LiteralPath $Preferred).Path
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
  throw "未找到 node.exe，请用 -NodePath 指定。"
}

$resolvedNode = Resolve-NodeExe -Preferred $NodePath
Set-Content -LiteralPath $NodePathFile -Value $resolvedNode -Encoding UTF8
Write-Host "已记录 Node 路径: $resolvedNode"

if (-not (Test-Path -LiteralPath $ServerEntry)) {
  Write-Host "构建产物不存在，执行 pnpm build..."
  Push-Location $ProjectRoot
  try {
    & pnpm build
  } finally {
    Pop-Location
  }
}

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $pwsh) {
  throw "未找到 PowerShell 7 (pwsh)。请先安装后再注册自启。"
}

# 触发器延迟启动；脚本本身 DelaySeconds=0，避免重复等待
$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$StartScript`" -DelaySeconds 0 -NodePath `"$resolvedNode`""
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $argument -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT${DelaySeconds}S"

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Write-Host "已注册计划任务: $TaskName"
Write-Host "触发条件: 用户 $env:USERNAME 登录后延迟 ${DelaySeconds}s"
Write-Host "启动脚本: $StartScript（守护进程，服务挂了会自动拉起）"
Write-Host "取消自启: pnpm autostart:uninstall"
Write-Host "立即挂上守护（不停现有服务）: pnpm autostart:watch"
