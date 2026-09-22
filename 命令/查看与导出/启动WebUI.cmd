@echo off
rem Weibo/Bili DM backup - local WebUI launcher
rem Double-click this file. It starts a small local server on 127.0.0.1
rem and opens your browser. Everything stays on this machine.
rem All user-facing text is printed by scripts\webui.ps1 (UTF-8 with BOM).
rem Optional args: -Port 8787   -NoOpen
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
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\webui.ps1" %*
echo.
pause
