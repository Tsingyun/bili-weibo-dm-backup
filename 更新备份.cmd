@echo off
rem Weibo DM backup - incremental update
rem All user-facing text is printed by scripts\update.ps1 (UTF-8 with BOM).
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" %*
echo.
pause
