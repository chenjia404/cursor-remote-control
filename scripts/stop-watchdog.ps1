#Requires -Version 7
<#
.SYNOPSIS
  停止守护进程，不结束已经在跑的 Node 服务。
#>
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $ProjectRoot "data"
$PidFile = Join-Path $LogDir "watchdog.pid"
$StopFile = Join-Path $LogDir "watchdog.stop"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Content -LiteralPath $StopFile -Value "stop" -Encoding UTF8

if (Test-Path -LiteralPath $PidFile) {
  $oldPid = 0
  try {
    $oldPid = [int]((Get-Content -LiteralPath $PidFile -Encoding UTF8 | Select-Object -First 1).Trim())
  } catch {
    $oldPid = 0
  }
  if ($oldPid -gt 0) {
    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($proc) {
      Stop-Process -Id $oldPid -ErrorAction SilentlyContinue
      Write-Host "已结束守护进程 PID=$oldPid"
    }
  }
}

Start-Sleep -Milliseconds 400
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
Write-Host "守护已停止。监听 20267 的服务（若仍在）不会被结束。"
