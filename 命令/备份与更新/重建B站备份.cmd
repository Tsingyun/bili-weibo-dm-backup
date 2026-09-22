@echo off
rem Bilibili DM backup - full rebuild (re-fetch everything with current rules)
rem Original data is backed up to bili\raw\messages.bak.json before rebuilding.
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
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\bili.ps1" -Rebuild %*
echo.
pause
