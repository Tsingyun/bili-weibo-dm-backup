@echo off
rem Rebuild the local full-text search index (SQLite FTS5, fully local).
rem Run this after the backups have been updated, then use the search launcher.
rem Optional args: --session bili  /  --check  /  --info
rem All user-facing text is printed by scripts\build_fts.mjs (UTF-8).
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

set "NODEEXE="
where node >nul 2>nul && set "NODEEXE=node"
if not defined NODEEXE if exist "C:\Program Files\nodejs\node.exe" set "NODEEXE=C:\Program Files\nodejs\node.exe"
if not defined NODEEXE (
  echo [x] Node.js not found. Please install Node.js 22 or newer.
  pause
  exit /b 1
)

"%NODEEXE%" --disable-warning=ExperimentalWarning "scripts\build_fts.mjs" %*
echo.
pause
