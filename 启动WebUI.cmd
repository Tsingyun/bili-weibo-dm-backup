@echo off
rem Weibo/Bili DM backup - local WebUI launcher
rem Double-click this file. It starts a small local server on 127.0.0.1
rem and opens your browser. Everything stays on this machine.
rem All user-facing text is printed by scripts\webui.ps1 (UTF-8 with BOM).
rem Optional args: -Port 8787   -NoOpen
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\webui.ps1" %*
echo.
pause
