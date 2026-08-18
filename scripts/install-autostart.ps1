#Requires -Version 7
<#
.SYNOPSIS
  注册 Windows 计划任务：登录后启动守护进程；守护退出后也会被再次拉起。
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
$LogDir = Join-Path $ProjectRoot "data"
$NodePathFile = Join-Path $LogDir "autostart-node-path.txt"
$ServerEntry = Join-Path $ProjectRoot "dist\src\server.js"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Resolve-RealNodeExe {
  param([string]$Candidate)
  if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate)) {
    return $null
  }
  $resolved = (Resolve-Path -LiteralPath $Candidate).Path
  if ($resolved -match '[\\/]shims[\\/]node\.exe$') {
    try {
      $real = & $resolved -p "process.execPath" 2>$null | Select-Object -First 1
      if ($real -and (Test-Path -LiteralPath $real)) {
        return (Resolve-Path -LiteralPath $real).Path
      }
    } catch {
      # 继续使用 shim
    }
  }
  return $resolved
}

function Resolve-NodeExe {
  param([string]$Preferred)
  $found = Resolve-RealNodeExe -Candidate $Preferred
  if ($found) {
    return $found
  }
  $fromPath = Get-Command node -ErrorAction SilentlyContinue
  $found = Resolve-RealNodeExe -Candidate ($fromPath?.Source)
  if ($found) {
    return $found
  }
  $candidates = @(
    "C:\soft\mise\data\shims\node.exe",
    (Join-Path $env:USERPROFILE "AppData\Local\mise\shims\node.exe"),
    (Join-Path $env:LOCALAPPDATA "mise\shims\node.exe")
  )
  foreach ($candidate in $candidates) {
    $found = Resolve-RealNodeExe -Candidate $candidate
    if ($found) {
      return $found
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

# 计划任务必须走系统自带的 powershell.exe。
# Store 版 pwsh 的 WindowsApps 版本目录会随升级消失，写死 7.x.y 路径会报 0x80070002，守护再也拉不起来。
$launcher = Join-Path $PSScriptRoot "launch-watchdog.ps1"
$winPs = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $winPs)) {
  throw "未找到系统 Windows PowerShell：$winPs"
}
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "未找到守护启动器：$launcher"
}

# 触发器延迟启动；脚本本身 DelaySeconds=0，避免重复等待
$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -DelaySeconds 0 -NodePath `"$resolvedNode`""
$action = New-ScheduledTaskAction -Execute $winPs -Argument $argument -WorkingDirectory $ProjectRoot

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logonTrigger.Delay = "PT${DelaySeconds}S"

# 仅 AtLogOn 时：电脑长期不注销，守护进程一旦退出就不会再起来。
# 每分钟补拉一次；已在运行则 IgnoreNew，不会重复开守护。
$repeatTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddSeconds(15)) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger @($logonTrigger, $repeatTrigger) `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

try {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "已立即启动计划任务: $TaskName"
} catch {
  Write-Host "计划任务已注册，但立即启动失败: $($_.Exception.Message)"
}

Write-Host "已注册计划任务: $TaskName"
Write-Host "触发条件: 用户 $env:USERNAME 登录后延迟 ${DelaySeconds}s；守护退出后每 1 分钟补拉"
Write-Host "启动脚本: $launcher → watchdog.ps1（守护进程，服务挂了会自动拉起）"
Write-Host "取消自启: pnpm autostart:uninstall"
Write-Host "立即挂上守护（不停现有服务）: pnpm autostart:watch"
