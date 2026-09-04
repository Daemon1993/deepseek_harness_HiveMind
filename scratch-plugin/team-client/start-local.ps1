$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Resolve-Path (Join-Path $pluginRoot '../..')

$envClient = Join-Path $pluginRoot '.env.client'
if (-not (Test-Path -LiteralPath $envClient)) {
  $example = Join-Path $pluginRoot '.env.client.example'
  throw @"
Missing $envClient

.gitignore excludes .env.client, so a rebase/checkout that removes scratch-plugin/ also deletes it.
Copy the example and set TEAM_SERVER_URL to the LAN proxy (port 3082), for example:
  Copy-Item '$example' '$envClient'
"@
}

Get-Content -Encoding UTF8 -LiteralPath $envClient | ForEach-Object {
  if ($_ -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
  }
}

$listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
  $isDshClient = $owner.Name -eq 'node.exe' -and
    $owner.CommandLine -match 'apps[\\/]cli[\\/]src[\\/]bin\.ts' -and
    $owner.CommandLine -match '(^|[\s"])(web)([\s"]|$)' -and
    $owner.CommandLine -match '(^|[\s"])(3080)([\s"]|$)'
  if (-not $isDshClient) {
    throw "Port 3080 is occupied by $($owner.Name) (PID $($listener.OwningProcess)); refusing to stop a non-DSH process"
  }
  Write-Host "Stopping previous HiveMind Client on port 3080 (PID $($listener.OwningProcess))"
  Stop-Process -Id $listener.OwningProcess -Force
  Wait-Process -Id $listener.OwningProcess -Timeout 5 -ErrorAction SilentlyContinue
}

Set-Location $repositoryRoot
pnpm dsh web --port 3080
exit $LASTEXITCODE
