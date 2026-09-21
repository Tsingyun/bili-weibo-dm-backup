@echo off
rem P2-15 Export the sticker library as a folder, sorted by usage count.
rem Usage: double-click to export both sessions, or pass options through:
rem   this-file.cmd --session bili --top 100 --with-sent
rem All user-facing text is printed by scripts\export_faces.mjs (UTF-8).
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

"%NODEEXE%" "scripts\export_faces.mjs" %*
echo.
pause
