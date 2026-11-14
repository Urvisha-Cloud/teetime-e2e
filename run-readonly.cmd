@echo off
rem Daily scheduled run of the read-only E2E checks (no bookings created).
rem Registered in Windows Task Scheduler as "TeeTime E2E daily readonly". Output: logs\scheduled-readonly.log
cd /d "%~dp0"
if not exist logs mkdir logs
echo. >> logs\scheduled-readonly.log
echo ==== %date% %time% ==== >> logs\scheduled-readonly.log
rem Runs Playwright directly (not "npm run test:readonly", which opens a visible Chrome window) so the
rem unattended daily run stays in the background.
call npx playwright test --grep-invert @creates-booking >> logs\scheduled-readonly.log 2>&1
echo exit code %errorlevel% >> logs\scheduled-readonly.log
