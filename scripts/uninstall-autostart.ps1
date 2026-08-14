#Requires -Version 7
<#
.SYNOPSIS
  移除 Cursor 远程控制台的开机/登录自启任务。
#>
param(
  [string]$TaskName = "CursorRemoteControl"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding

$StopWatchdog = Join-Path $PSScriptRoot "stop-watchdog.ps1"
if (Test-Path -LiteralPath $StopWatchdog) {
  & $StopWatchdog
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Host "未找到计划任务: $TaskName"
  exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "已移除计划任务: $TaskName"
