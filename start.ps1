# Starts the whole stack on Windows (Docker Desktop must be running):
#   powershell -ExecutionPolicy Bypass -File .\start.ps1
# 1) opens the Cloudflare tunnel and writes its HTTPS URL to .env as WEBHOOK_URL
# 2) starts n8n + worker   3) on first run imports credentials and workflows into n8n
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path .env)) { throw ".env not found - copy .env.example to .env and fill it in." }

function dk {
  $line = 'docker ' + ($args -join ' ') + ' 2>&1'
  cmd /c $line | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { throw "docker $($args -join ' ') failed (exit $LASTEXITCODE)" }
}
function Read-Env {
  $h = @{}
  foreach ($line in [IO.File]::ReadAllLines("$PSScriptRoot\.env")) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $h[$Matches[1]] = $Matches[2].Trim() }
  }
  return $h
}
function Set-EnvValue($key, $value) {
  $lines = [IO.File]::ReadAllLines("$PSScriptRoot\.env")
  $found = $false
  $lines = $lines | ForEach-Object { if ($_ -match "^$key=") { $found = $true; "$key=$value" } else { $_ } }
  if (-not $found) { $lines = @($lines) + "$key=$value" }
  [IO.File]::WriteAllLines("$PSScriptRoot\.env", [string[]]$lines)
}

Write-Host "Starting database, queue and tunnel..."
dk compose up -d --force-recreate cloudflared
dk compose up -d postgres redis

$url = $null
foreach ($i in 1..30) {
  Start-Sleep -Seconds 2
  $log = (cmd /c 'docker compose logs --no-color cloudflared 2>&1' | Out-String)
  $m = [regex]::Matches($log, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($m.Count -gt 0) { $url = $m[$m.Count - 1].Value; break }
}
if (-not $url) { throw "Could not get a tunnel URL. Check: docker compose logs cloudflared" }
Set-EnvValue 'WEBHOOK_URL' "$url/"
Write-Host "Tunnel: $url"

dk compose up -d --force-recreate n8n n8n-worker
Write-Host "Waiting for n8n..."
foreach ($i in 1..60) {
  try { if ((Invoke-WebRequest -UseBasicParsing http://localhost:5678/healthz -TimeoutSec 3).StatusCode -eq 200) { break } } catch {}
  Start-Sleep -Seconds 2
}

if (-not (Test-Path .bootstrapped)) {
  Write-Host "First run: importing credentials and workflows into n8n..."
  $e = Read-Env
  $creds = @(
    @{ id = 'schedPostgres0001'; name = 'Audit Postgres'; type = 'postgres'
       data = @{ host = 'postgres'; port = 5432; database = $e.POSTGRES_DB; user = $e.POSTGRES_USER; password = $e.POSTGRES_PASSWORD; ssl = 'disable' } }
  )
  if ($e.TELEGRAM_BOT_TOKEN) { $creds += @{ id = 'schedTelegram0001'; name = 'Telegram Bot'; type = 'telegramApi'; data = @{ accessToken = $e.TELEGRAM_BOT_TOKEN } } }
  if ($e.OPENAI_API_KEY)     { $creds += @{ id = 'schedOpenAi000001'; name = 'OpenAI'; type = 'openAiApi'; data = @{ apiKey = $e.OPENAI_API_KEY } } }
  if ($e.GOOGLE_CLIENT_ID -and $e.GOOGLE_CLIENT_SECRET) {
    $creds += @{ id = 'schedGoogleCal001'; name = 'Google Calendar OAuth2'; type = 'googleCalendarOAuth2Api'
                 data = @{ clientId = $e.GOOGLE_CLIENT_ID; clientSecret = $e.GOOGLE_CLIENT_SECRET } }
  }
  $tmp = Join-Path $env:TEMP 'sched-creds.json'
  [IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $creds -Depth 5))
  try {
    dk compose cp "`"$tmp`"" n8n:/tmp/creds.json
    dk compose exec -T n8n n8n import:credentials --input=/tmp/creds.json
    dk compose exec -T -u root n8n rm -f /tmp/creds.json
  } finally { Remove-Item $tmp -Force }
  dk compose exec -T n8n n8n import:workflow --input=/workflows/scheduling_pipeline.json
  dk compose exec -T n8n n8n import:workflow --input=/workflows/baseline_single_model.json
  New-Item -ItemType File .bootstrapped | Out-Null
}

Write-Host ""
Write-Host "n8n editor:            http://localhost:5678"
Write-Host "Google redirect URI:   http://localhost:5678/rest/oauth2-credential/callback"
Write-Host "Telegram webhook base: $url"

Write-Host "Telegram webhook status:"
Start-Sleep -Seconds 15
& "$PSScriptRoot\webhook.ps1"
