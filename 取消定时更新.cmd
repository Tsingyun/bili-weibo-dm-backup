@echo off
rem P0-4 Remove the auto-update scheduled task (also cleans up the old default name).
rem Also use this if you want to change the schedule: remove here, then register again.
rem All user-facing text is printed by scripts\schedule_task.ps1 (UTF-8 with BOM).
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\schedule_task.ps1" -Unregister %*
echo.
pause
