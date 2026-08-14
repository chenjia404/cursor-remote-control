#Requires -Version 7
<#
.SYNOPSIS
  守护远程控制台：发现 20267 没有在听，就调用 start-server.ps1 拉起。
  不会结束已在运行的服务，适合在当前会话还活着时先挂上。
#>
param(
  [int]$IntervalSeconds = 15,
  [int]$DelaySeconds = 0,
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StartScript = Join-Path $PSScriptRoot "start-server.ps1"
$LogDir = Join-Path $ProjectRoot "data"
$LogFile = Join-Path $LogDir "watchdog.log"
$PidFile = Join-Path $LogDir "watchdog.pid"
$StopFile = Join-Path $LogDir "watchdog.stop"
$Port = 20267

if ($IntervalSeconds -lt 5) {
  $IntervalSeconds = 5
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-WatchdogLog {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  Write-Host $line
}

function Test-PortListening {
  param([int]$LocalPort)
  try {
    return [bool](Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return $false
  }
}

function Test-OtherWatchdog {
  if (-not (Test-Path -LiteralPath $PidFile)) {
    return $false
  }
  $oldPid = 0
  try {
    $oldPid = [int]((Get-Content -LiteralPath $PidFile -Encoding UTF8 | Select-Object -First 1).Trim())
  } catch {
    return $false
  }
  if ($oldPid -le 0 -or $oldPid -eq $PID) {
    return $false
  }
  $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  return [bool]$proc
}

function Rotate-WatchdogLog {
  if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt 2MB)) {
    Move-Item -LiteralPath $LogFile -Destination ($LogFile + ".old") -Force
  }
}

if (Test-Path -LiteralPath $StopFile) {
  Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
}

if (Test-OtherWatchdog) {
  Write-WatchdogLog "已有守护进程在运行，本次退出以免重复拉起。"
  exit 0
}

Set-Content -LiteralPath $PidFile -Value $PID -Encoding UTF8
if ($DelaySeconds -gt 0) {
  Write-WatchdogLog "延迟 ${DelaySeconds}s 后开始监护"
  Start-Sleep -Seconds $DelaySeconds
}
Write-WatchdogLog "守护已启动 PID=$PID interval=${IntervalSeconds}s port=$Port"

$pwsh = (Get-Command pwsh).Source
$failCount = 0
try {
  while ($true) {
    if (Test-Path -LiteralPath $StopFile) {
      Write-WatchdogLog "收到停止标记，守护退出。"
      break
    }

    Rotate-WatchdogLog

    if (Test-PortListening -LocalPort $Port) {
      $failCount = 0
      Start-Sleep -Seconds $IntervalSeconds
      continue
    }

    Write-WatchdogLog "端口 $Port 未监听，尝试启动服务。"
    $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $StartScript, "-DelaySeconds", "0")
    if ($NodePath) {
      $args += @("-NodePath", $NodePath)
    }

    $p = Start-Process -FilePath $pwsh `
      -ArgumentList $args `
      -WorkingDirectory $ProjectRoot `
      -Wait `
      -PassThru `
      -WindowStyle Hidden

    Start-Sleep -Seconds 2
    if (Test-PortListening -LocalPort $Port) {
      Write-WatchdogLog "服务已恢复监听 $Port（start-server exit=$($p.ExitCode)）。"
      $failCount = 0
      Start-Sleep -Seconds $IntervalSeconds
      continue
    }

    $failCount += 1
    $backoff = [Math]::Min(300, [Math]::Max($IntervalSeconds, 15 * [Math]::Pow(2, [Math]::Min($failCount, 4))))
    Write-WatchdogLog "启动后仍未监听，第 ${failCount} 次失败，${backoff}s 后重试。"
    Start-Sleep -Seconds $backoff
  }
} finally {
  if ((Test-Path -LiteralPath $PidFile) -and ((Get-Content -LiteralPath $PidFile -Encoding UTF8 | Select-Object -First 1).Trim() -eq [string]$PID)) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
}
