@echo off
cd /d "%~dp0"
(
echo === import ===
docker compose exec -T n8n n8n import:workflow --input=/workflows/scheduling_pipeline.json
echo === activate ===
docker compose exec -T n8n n8n update:workflow --id=sched4922e255390 --active=false
docker compose exec -T n8n n8n update:workflow --id=sched4922e255390 --active=true
echo === restart ===
docker compose restart n8n n8n-worker
) > update.log 2>&1
type update.log
pause
