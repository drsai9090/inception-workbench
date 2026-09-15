param(
  [ValidateSet('start','stop')][string]$Action = 'start',
  [string]$PgBin = 'C:/Program Files/PostgreSQL/18/bin'
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskData = Join-Path $taskRoot 'tmp/postgres'
if (-not (Test-Path -LiteralPath (Join-Path $PgBin 'pg_ctl.exe'))) { throw 'Set -PgBin to an existing PostgreSQL installation. No installation or global changes are performed.' }
if ($Action -eq 'stop') {
  if (-not (Test-Path -LiteralPath (Join-Path $taskData 'PG_VERSION'))) { throw 'This repository has no local PostgreSQL cluster.' }
  & "$PgBin/pg_ctl.exe" -D $taskData -m fast -w stop
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop this repository cluster.' }
  exit
}
$taskEnvFile = Join-Path $taskRoot '.env'
if (-not (Test-Path -LiteralPath $taskEnvFile)) { throw 'Run node scripts/setup.mjs from the repository first.' }
$taskVars = @{}
foreach ($taskLine in Get-Content -LiteralPath $taskEnvFile) {
  if ($taskLine -match '^([A-Z_]+)=(.*)$') { $taskVars[$Matches[1]] = $Matches[2] }
}
$taskDbUrl = [Uri]$taskVars['DATABASE_URL']
if ($taskDbUrl.Host -ne '127.0.0.1' -or $taskDbUrl.Port -ne 55438 -or $taskDbUrl.AbsolutePath -ne '/inception') { throw 'This script requires the isolated 127.0.0.1:55438/inception DATABASE_URL.' }
$taskCredentials = $taskDbUrl.UserInfo.Split(':', 2)
$taskUser = [Uri]::UnescapeDataString($taskCredentials[0])
$taskPassword = [Uri]::UnescapeDataString($taskCredentials[1])
$taskNew = -not (Test-Path -LiteralPath (Join-Path $taskData 'PG_VERSION'))
if ($taskNew) {
  if (Get-NetTCPConnection -LocalPort 55438 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 55438 is in use. Do not change or stop another database.' }
  New-Item -ItemType Directory -Force -Path (Join-Path $taskRoot 'tmp') | Out-Null
  $taskPasswordFile = Join-Path $taskRoot 'tmp/init-password'
  [IO.File]::WriteAllText($taskPasswordFile, $taskPassword)
  try {
    & "$PgBin/initdb.exe" -D $taskData -U $taskUser -A scram-sha-256 "--pwfile=$taskPasswordFile" --encoding=UTF8 --locale=C
    if ($LASTEXITCODE -ne 0) { throw 'Local initdb failed. Existing cluster files were preserved.' }
  } finally { Remove-Item -LiteralPath $taskPasswordFile -ErrorAction SilentlyContinue }
}
& "$PgBin/pg_ctl.exe" -D $taskData status *> $null
if ($LASTEXITCODE -ne 0) {
  & "$PgBin/pg_ctl.exe" -D $taskData -l (Join-Path $taskRoot 'tmp/postgres.log') -o '-p 55438 -h 127.0.0.1' -w start
  if ($LASTEXITCODE -ne 0) { throw 'Could not start the isolated database. Inspect tmp/postgres.log.' }
}
$taskPreviousPassword = $env:PGPASSWORD
try {
  $env:PGPASSWORD = $taskPassword
  foreach ($taskName in @('inception', 'inception_test')) {
    $taskExists = & "$PgBin/psql.exe" -h 127.0.0.1 -p 55438 -U $taskUser -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$taskName'"
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect this isolated cluster.' }
    if ($taskExists -ne '1') {
      & "$PgBin/createdb.exe" -h 127.0.0.1 -p 55438 -U $taskUser $taskName
      if ($LASTEXITCODE -ne 0) { throw "Could not create $taskName in the isolated cluster." }
    }
  }
} finally { $env:PGPASSWORD = $taskPreviousPassword }
Write-Output 'Isolated PostgreSQL ready on 127.0.0.1:55438 (inception and inception_test).'
