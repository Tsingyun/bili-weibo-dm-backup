@echo off
rem P1-10 Export conversations to JSONL (fully local, no cloud).
rem Usage: double-click, or pass options through:
rem   this-file.cmd --session bili --since 2026-01-01 --mask
rem All user-facing text is printed by scripts\export_jsonl.mjs (UTF-8).
chcp 65001 >nul
cd /d "%~dp0"

set "NODEEXE="
where node >nul 2>nul && set "NODEEXE=node"
if not defined NODEEXE if exist "C:\Program Files\nodejs\node.exe" set "NODEEXE=C:\Program Files\nodejs\node.exe"
if not defined NODEEXE (
  echo [x] Node.js not found. Please install Node.js 22 or newer.
  pause
  exit /b 1
)

"%NODEEXE%" "scripts\export_jsonl.mjs" %*
echo.
pause
