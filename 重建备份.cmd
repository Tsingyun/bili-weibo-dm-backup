@echo off
rem Weibo DM backup - full rebuild (re-fetch everything with current rules)
rem Original data is backed up to data\raw\messages.bak.json before rebuilding.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" -Rebuild %*
echo.
pause
