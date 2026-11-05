@echo off
rem Remove the standalone scheduled OCR task.
rem The normal "auto update" task is NOT affected.
chcp 65001 >nul
cd /d "%~dp0..\.."
if not exist "scripts\" (
  echo [x] Project root not found. Put this .cmd back in its folder.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\ocr_scheduled.ps1" -Unregister
echo.
pause
