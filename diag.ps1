Set-Location $PSScriptRoot
$e = @{}; foreach ($l in [IO.File]::ReadAllLines("$PSScriptRoot\.env")) { if ($l -match '^([A-Za-z0-9_]+)=(.*)$') { $e[$Matches[1]] = $Matches[2].Trim() } }
"=== webhook info ==="; (Invoke-RestMethod "https://api.telegram.org/bot$($e.TELEGRAM_BOT_TOKEN)/getWebhookInfo").result | ConvertTo-Json -Compress
"=== executions (last 10) ==="
cmd /c "docker compose exec -T postgres psql -U n8n -d n8n -c ""select id, status, mode, \""startedAt\"", \""stoppedAt\"" from execution_entity order by id desc limit 10"" 2>&1"
"=== last error executions ==="
cmd /c "docker compose exec -T postgres psql -U n8n -d n8n -At -c ""select e.id || ' :: ' || left(regexp_replace(d.data, '\s+', ' ', 'g'), 2500) from execution_entity e join execution_data d on d.\""executionId\""=e.id where e.status in ('error','crashed') order by e.id desc limit 2"" 2>&1"
"=== last execution data (any) ==="
cmd /c "docker compose exec -T postgres psql -U n8n -d n8n -At -c ""select e.id || ' ' || e.status || ' :: ' || left(regexp_replace(d.data, '\s+', ' ', 'g'), 3000) from execution_entity e join execution_data d on d.\""executionId\""=e.id order by e.id desc limit 1"" 2>&1"
"=== audit ==="
cmd /c "docker compose exec -T postgres psql -U n8n -d n8n -c ""select created_at,chat_id,status,intent from scheduling_audit order by id desc limit 5"" 2>&1"
"=== pending ==="
cmd /c "docker compose exec -T postgres psql -U n8n -d n8n -c ""select id,created_at,status,chat_id from pending_actions order by id desc limit 5"" 2>&1"
"=== n8n log tail ==="
cmd /c 'docker compose logs --no-color --tail 60 n8n n8n-worker 2>&1' | Select-String -NotMatch 'Postgres 16|deprecat|N8N_|WEBHOOK_URL|webhooks\.|version\.|Set it|https://docs|^\s*$'
