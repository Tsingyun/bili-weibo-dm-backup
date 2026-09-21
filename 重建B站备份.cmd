@echo off
rem Bilibili DM backup - full rebuild (re-fetch everything with current rules)
rem Original data is backed up to bili\raw\messages.bak.json before rebuilding.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bili.ps1" -Rebuild %*
echo.
pause
