@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File .\webhook.ps1 > webhook.log 2>&1
type webhook.log
timeout /t 5
