@echo off
cd /d "%~dp0"
(
echo === activate ===
docker compose exec -T n8n n8n update:workflow --id=sched4922e255390 --active=true
echo === restart ===
docker compose restart n8n n8n-worker
) > activate.log 2>&1
type activate.log
echo Done.
timeout /t 5
