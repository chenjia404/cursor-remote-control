# Scheduled task entry: system Windows PowerShell 5.1 locates current pwsh 7.
# Store pwsh version folders change on upgrade; a hardcoded path yields 0x80070002.
param(
  [int]$DelaySeconds = 0,
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"
$Watchdog = Join-Path $PSScriptRoot "watchdog.ps1"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Resolve-PwshExe {
  $msi = Join-Path $env:ProgramFiles "PowerShell\7\pwsh.exe"
  if (Test-Path -LiteralPath $msi) {
    return $msi
  }

  $pkg = Get-AppxPackage -Name Microsoft.PowerShell -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if ($pkg -and $pkg.InstallLocation) {
    $fromStore = Join-Path $pkg.InstallLocation "pwsh.exe"
    if (Test-Path -LiteralPath $fromStore) {
      return $fromStore
    }
  }

  $cmd = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) {
    $item = Get-Item -LiteralPath $cmd.Source -ErrorAction SilentlyContinue
    # Store execution alias is a 0-byte stub and often fails in Task Scheduler
    if ($item -and $item.Length -gt 0) {
      return $cmd.Source
    }
  }

  throw "PowerShell 7 (pwsh) not found."
}

$pwsh = Resolve-PwshExe
$argList = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", $Watchdog,
  "-DelaySeconds", "$DelaySeconds"
)
if ($NodePath) {
  $argList += @("-NodePath", $NodePath)
}

Set-Location -LiteralPath $ProjectRoot
& $pwsh @argList
if ($null -eq $LASTEXITCODE) {
  exit 0
}
exit $LASTEXITCODE
