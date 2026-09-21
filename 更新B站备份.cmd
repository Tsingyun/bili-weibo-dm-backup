@echo off
rem Bilibili DM backup - incremental update
rem All user-facing text is printed by scripts\bili.ps1 (UTF-8 with BOM).
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bili.ps1" %*
echo.
pause
