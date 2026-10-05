Set-Location $PSScriptRoot
$e = @{}; foreach ($l in [IO.File]::ReadAllLines("$PSScriptRoot\.env")) { if ($l -match '^([A-Za-z0-9_]+)=(.*)$') { $e[$Matches[1]] = $Matches[2].Trim() } }
"=== containers ==="; cmd /c 'docker compose ps --format "table {{.Service}}\t{{.Status}}" 2>&1'
"=== WEBHOOK_URL ==="; $e.WEBHOOK_URL
"=== telegram getMe ==="; try { (Invoke-RestMethod "https://api.telegram.org/bot$($e.TELEGRAM_BOT_TOKEN)/getMe").result | Select-Object username, can_read_all_group_messages | Format-List } catch { "ERROR: $($_.Exception.Message)" }
"=== telegram webhook ==="; try { (Invoke-RestMethod "https://api.telegram.org/bot$($e.TELEGRAM_BOT_TOKEN)/getWebhookInfo").result | Select-Object url, pending_update_count, last_error_message, last_error_date | Format-List } catch { "ERROR: $($_.Exception.Message)" }
"=== openai key ==="; try { (Invoke-RestMethod "https://api.openai.com/v1/models/gpt-4o-mini" -Headers @{ Authorization = "Bearer $($e.OPENAI_API_KEY)" }).id } catch { "ERROR: $($_.Exception.Message)" }
"=== workflows ==="; cmd /c 'docker compose exec -T n8n n8n list:workflow --active=true 2>&1' | Select-String -NotMatch 'Postgres 16|migration lock'
"=== recent audit rows ==="; cmd /c "docker compose exec -T postgres psql -U $($e.POSTGRES_USER) -d $($e.POSTGRES_DB) -c ""select created_at,chat_id,status,intent,latency_ms,stage3_attempts from scheduling_audit order by id desc limit 10"" 2>&1"
"=== n8n log tail ==="; cmd /c 'docker compose logs --no-color --tail 25 n8n n8n-worker 2>&1' | Select-String -NotMatch 'Postgres 16'
