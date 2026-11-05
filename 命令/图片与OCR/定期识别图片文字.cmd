@echo off
rem Register a STANDALONE scheduled task that only runs local image OCR.
rem It never fetches messages and does not touch the existing backup task.
rem Double-click once = every Monday 08:00.
rem Optional args: -Daily -At 21:30   -DaysOfWeek Monday,Thursday
rem                -Sessions weibo,bili   -TaskName "my ocr task"
rem All user-facing text is printed by scripts\ocr_scheduled.ps1 (UTF-8 with BOM).
chcp 65001 >nul
cd /d "%~dp0..\.."
if not exist "scripts\" (
  echo [x] Project root not found. Put this .cmd back in its folder.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\ocr_scheduled.ps1" -Register %*
echo.
echo Done. To remove it later, double-click the Unregister launcher in this folder.
pause
