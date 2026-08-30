$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Resolve-Path (Join-Path $pluginRoot '../..')

Get-Content -Encoding UTF8 (Join-Path $pluginRoot '.env.server') | ForEach-Object {
  if ($_ -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
  }
}

Set-Location $repositoryRoot
pnpm dsh web --port 3081
exit $LASTEXITCODE
