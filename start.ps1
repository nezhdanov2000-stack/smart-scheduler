# Smart Scheduler - start everything on one Windows laptop, no Docker.
#   powershell -ExecutionPolicy Bypass -File .\start.ps1             # normal start
#   powershell -ExecutionPolicy Bypass -File .\start.ps1 -Reimport   # also re-import workflows/*.json
#
# 1) opens a Cloudflare quick tunnel and writes its HTTPS URL into .env (WEBHOOK_URL)
# 2) loads .env into the environment
# 3) first run (or -Reimport): imports credentials and workflows with the n8n CLI
# 4) runs n8n in this window (Ctrl+C stops n8n and the tunnel)
param([switch]$Reimport)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path .env)) { throw ".env not found - copy .env.example to .env and fill it in." }

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

# --- prerequisites -----------------------------------------------------------
foreach ($tool in 'node', 'n8n') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "'$tool' not found. See README.md (Node.js 22 LTS, then: npm install n8n -g)." }
}
$cloudflared = if (Test-Path "$PSScriptRoot\cloudflared.exe") { "$PSScriptRoot\cloudflared.exe" }
               elseif (Get-Command cloudflared -ErrorAction SilentlyContinue) { 'cloudflared' }
               else { throw "cloudflared not found. Run 'winget install Cloudflare.cloudflared' or put cloudflared.exe in this folder." }
$nodeVersion = (node -v).TrimStart('v')
if ([version]$nodeVersion -lt [version]'20.19' -or [version]$nodeVersion -ge [version]'25.0') {
  Write-Warning "Node.js $nodeVersion - n8n supports 20.19 to 24.x. Node 22 LTS is recommended."
}

# --- 1. tunnel ----------------------------------------------------------------
$e = Read-Env
$tunnel = $null
if ($e.WEBHOOK_URL -and $e.WEBHOOK_URL -notmatch 'trycloudflare\.com') {
  Write-Host "Using fixed WEBHOOK_URL from .env: $($e.WEBHOOK_URL)"
} else {
  Write-Host "Opening Cloudflare quick tunnel..."
  $log = "$PSScriptRoot\.n8n\cloudflared.log"
  New-Item -ItemType Directory -Force "$PSScriptRoot\.n8n" | Out-Null
  Remove-Item $log -ErrorAction SilentlyContinue
  $tunnel = Start-Process $cloudflared -ArgumentList 'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://localhost:5678' `
            -RedirectStandardError $log -WindowStyle Hidden -PassThru
  $url = $null
  foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    if (Test-Path $log) {
      $m = [regex]::Matches((Get-Content $log -Raw), 'https://[a-z0-9-]+\.trycloudflare\.com')
      if ($m.Count -gt 0) { $url = $m[$m.Count - 1].Value; break }
    }
  }
  if (-not $url) { if ($tunnel) { Stop-Process $tunnel -Force }; throw "Could not get a tunnel URL. See $log" }
  Set-EnvValue 'WEBHOOK_URL' "$url/"
  Write-Host "Tunnel: $url"
  $e = Read-Env
}

# --- 2. environment for n8n -----------------------------------------------------
foreach ($k in $e.Keys) { Set-Item -Path "Env:$k" -Value $e[$k] }
$env:N8N_USER_FOLDER     = "$PSScriptRoot\.n8n"      # SQLite DB, encryption key, logs - all inside the project folder
$env:N8N_EDITOR_BASE_URL = 'http://localhost:5678'   # Google OAuth redirect stays on localhost
$env:N8N_WEBHOOK_URL     = $e.WEBHOOK_URL            # Telegram webhooks come through the tunnel
$env:WEBHOOK_URL         = $e.WEBHOOK_URL
$env:GENERIC_TIMEZONE    = $e.TIMEZONE
$env:TZ                  = $e.TIMEZONE
$env:N8N_DIAGNOSTICS_ENABLED = 'false'
$env:N8N_PERSONALIZATION_ENABLED = 'false'
$env:N8N_RUNNERS_ENABLED = 'false'
$env:EXECUTIONS_DATA_PRUNE = 'true'
$env:EXECUTIONS_DATA_MAX_AGE = '336'                 # hours (14 days)

# --- 3. first run: credentials + workflows -----------------------------------------
$marker = "$PSScriptRoot\.n8n\.imported"
if ($Reimport -or -not (Test-Path $marker)) {
  if (-not (Test-Path $marker)) {
    Write-Host "First run: importing credentials into n8n's encrypted vault..."
    $creds = @()
    if ($e.TELEGRAM_BOT_TOKEN) { $creds += @{ id = 'schedTelegram0001'; name = 'Telegram Bot'; type = 'telegramApi'; data = @{ accessToken = $e.TELEGRAM_BOT_TOKEN } } }
    if ($e.OPENAI_API_KEY)     { $creds += @{ id = 'schedOpenAi000001'; name = 'OpenAI'; type = 'openAiApi'; data = @{ apiKey = $e.OPENAI_API_KEY } } }
    if ($e.GOOGLE_CLIENT_ID -and $e.GOOGLE_CLIENT_SECRET) {
      $creds += @{ id = 'schedGoogleCal001'; name = 'Google Calendar OAuth2'; type = 'googleCalendarOAuth2Api'
                   data = @{ clientId = $e.GOOGLE_CLIENT_ID; clientSecret = $e.GOOGLE_CLIENT_SECRET } }
    }
    $tmp = Join-Path $env:TEMP "sched-creds-$PID.json"
    try {
      [IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $creds -Depth 5))
      n8n import:credentials --input="$tmp"
    } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  }
  Write-Host "Importing workflows..."
  n8n import:workflow --input="$PSScriptRoot\workflows\scheduling_pipeline.json"
  n8n import:workflow --input="$PSScriptRoot\workflows\baseline_single_model.json"
  $wfId = (Get-Content "$PSScriptRoot\workflows\scheduling_pipeline.json" -Raw | ConvertFrom-Json).id
  try { n8n publish:workflow --id=$wfId } catch { n8n update:workflow --id=$wfId --active=true }

  New-Item -ItemType File -Force $marker | Out-Null
}

# --- 4. run n8n ------------------------------------------------------------------
Write-Host ""
Write-Host "n8n editor:            http://localhost:5678"
Write-Host "Google redirect URI:   http://localhost:5678/rest/oauth2-credential/callback"
Write-Host "Telegram webhook base: $($e.WEBHOOK_URL)"
Write-Host "Press Ctrl+C to stop."
Write-Host ""
try {
  n8n start
} finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process $tunnel -Force }
}
