@echo off
rem Regenerate sessions.js from sessions.json (multi-session manifest).
rem Run this after adding / editing a session in sessions.json.
rem All user-facing text is printed by scripts\build_sessions.mjs (UTF-8).
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

"%NODEEXE%" "scripts\build_sessions.mjs" --mkdir
echo.
pause
