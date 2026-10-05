# Resets the Telegram webhook: deletes it, restarts n8n so that n8n re-registers it itself
# (n8n signs the webhook with a secret token; a hand-made setWebhook gets 403 from n8n).
# Then prints the registration. start.ps1 and update.bat call this.
Set-Location $PSScriptRoot
$e = @{}; foreach ($l in [IO.File]::ReadAllLines("$PSScriptRoot\.env")) { if ($l -match '^([A-Za-z0-9_]+)=(.*)$') { $e[$Matches[1]] = $Matches[2].Trim() } }
$api = "https://api.telegram.org/bot$($e.TELEGRAM_BOT_TOKEN)"
"deleteWebhook: " + (Invoke-RestMethod -Method Post "$api/deleteWebhook?drop_pending_updates=false").description
cmd /c 'docker compose restart n8n 2>&1' | Out-Null
foreach ($i in 1..40) { Start-Sleep -Seconds 3; $r = (Invoke-RestMethod "$api/getWebhookInfo").result; if ($r.url) { break } }
$r | Select-Object url, allowed_updates, pending_update_count, last_error_message | Format-List
