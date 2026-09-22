@echo off
rem P0-4 Remove the auto-update scheduled task (also cleans up the old default name).
rem Also use this if you want to change the schedule: remove here, then register again.
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
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\schedule_task.ps1" -Unregister %*
echo.
pause
