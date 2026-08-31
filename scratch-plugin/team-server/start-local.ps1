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
[Environment]::SetEnvironmentVariable('TEAM_ROLE', 'server', 'Process')

Set-Location $repositoryRoot
pnpm dsh web --port 3081
exit $LASTEXITCODE
