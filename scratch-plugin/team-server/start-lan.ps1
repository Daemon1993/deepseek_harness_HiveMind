$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

$envFiles = @('.env', '.env.server')
foreach ($envFile in $envFiles) {
  $envPath = Join-Path $pluginRoot $envFile
  if (Test-Path -LiteralPath $envPath) {
    Get-Content -Encoding UTF8 -LiteralPath $envPath | ForEach-Object {
      if ($_ -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
      }
    }
  }
}

if ([string]::IsNullOrWhiteSpace($env:TEAM_SERVER_LAN_HOST)) {
  throw 'TEAM_SERVER_LAN_HOST must be set in .env.server'
}
if ([string]::IsNullOrWhiteSpace($env:TEAM_SERVER_LAN_PORT)) {
  $env:TEAM_SERVER_LAN_PORT = '3082'
}
$lanPort = [int]$env:TEAM_SERVER_LAN_PORT

$listeners = @(Get-NetTCPConnection -LocalAddress $env:TEAM_SERVER_LAN_HOST -LocalPort $lanPort -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
  $isTeamLanProxy = $owner.Name -eq 'node.exe' -and $owner.CommandLine -match 'scripts[\\/]lan-proxy\.ts'
  if (-not $isTeamLanProxy) {
    throw "Port $lanPort is occupied by $($owner.Name) (PID $($listener.OwningProcess)); refusing to stop a non-Team proxy process"
  }
  Write-Host "Stopping previous Team LAN proxy on port $lanPort (PID $($listener.OwningProcess))"
  Stop-Process -Id $listener.OwningProcess -Force
  Wait-Process -Id $listener.OwningProcess -Timeout 5 -ErrorAction SilentlyContinue
}

$proxyScript = Join-Path $pluginRoot 'scripts/lan-proxy.ts'
$proxy = Start-Process -FilePath 'node' -ArgumentList @('--import', 'tsx/esm', $proxyScript) -WorkingDirectory $pluginRoot -NoNewWindow -PassThru
try {
  Start-Sleep -Milliseconds 500
  $proxy.Refresh()
  if ($proxy.HasExited) {
    throw "LAN proxy failed to start with exit code $($proxy.ExitCode)"
  }
  Write-Host "Team LAN URL: http://$($env:TEAM_SERVER_LAN_HOST):$($env:TEAM_SERVER_LAN_PORT)/team/admin"
  & (Join-Path $pluginRoot 'start-local.ps1')
  exit $LASTEXITCODE
} finally {
  if (-not $proxy.HasExited) {
    Stop-Process -Id $proxy.Id
    Wait-Process -Id $proxy.Id -ErrorAction SilentlyContinue
  }
}
