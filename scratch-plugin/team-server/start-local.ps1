$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Resolve-Path (Join-Path $pluginRoot '../..')

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

$listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 3081 -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
  $isDshWeb = $owner.Name -eq 'node.exe' -and
    $owner.CommandLine -match 'apps[\\/]cli[\\/]src[\\/]bin\.ts' -and
    $owner.CommandLine -match '(^|[\s\"])(web)([\s\"]|$)'
  if (-not $isDshWeb) {
    throw "Port 3081 is occupied by $($owner.Name) (PID $($listener.OwningProcess)); refusing to stop a non-DSH process"
  }
  Write-Host "Stopping previous DSH Web process on port 3081 (PID $($listener.OwningProcess))"
  Stop-Process -Id $listener.OwningProcess -Force
  Wait-Process -Id $listener.OwningProcess -Timeout 5 -ErrorAction SilentlyContinue
}

Set-Location $repositoryRoot
pnpm dsh web --host 127.0.0.1 --port 3081
exit $LASTEXITCODE
