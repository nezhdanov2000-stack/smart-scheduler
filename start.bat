@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { .\start.ps1 *>&1 | Tee-Object -FilePath start.log }"
echo.
echo Done. Log saved to start.log
pause
