@echo off
rem P0-4 Register the auto-update scheduled task (Windows Task Scheduler).
rem Double-click this file once. No cloud service is involved.
rem Default: every Monday at 08:00. No arguments needed.
rem Optional args: -Daily   -DaysOfWeek Monday,Thursday   -At 21:30
rem                 -Sessions weibo,bili   -TaskName "my task"
rem All user-facing text is printed by scripts\schedule_task.ps1 (UTF-8 with BOM).
chcp 65001 >nul
rem This launcher sits two levels below the project root.
rem Keep it where it is: scripts\ is resolved relative to the root.
cd /d "%~dp0..\.."
if not exist "scripts\" (
  echo [x] Project root not found under "%CD%".
  echo     Do not move this .cmd file out of its folder; put it back and retry.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\schedule_task.ps1" -Register %*
echo.
echo Done. See the summary above (default: every Monday 08:00).
pause
