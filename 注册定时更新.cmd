@echo off
rem P0-4 Register the auto-update scheduled task (Windows Task Scheduler).
rem Double-click this file once. No cloud service is involved.
rem Default: every Monday at 08:00. No arguments needed.
rem Optional args: -Daily   -DaysOfWeek Monday,Thursday   -At 21:30
rem                 -Sessions weibo,bili   -TaskName "my task"
rem All user-facing text is printed by scripts\schedule_task.ps1 (UTF-8 with BOM).
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\schedule_task.ps1" -Register %*
echo.
echo Done. See the summary above (default: every Monday 08:00).
pause
