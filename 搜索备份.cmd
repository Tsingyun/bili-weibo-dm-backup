@echo off
rem P2-16 Local full-text search over the backups (fully local, no cloud).
rem Double-click = interactive mode (type a keyword, Enter; empty line to quit).
rem The interactive loop lives in Node on purpose: cmd.exe mangles non-ASCII
rem console input, while Node reads stdin as UTF-8 correctly.
rem You can also pass options through:
rem   this-file.cmd --session bili --sender peer --context 1
rem All user-facing text is printed by scripts\search.mjs (UTF-8).
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

rem --disable-warning: node:sqlite is flagged experimental and would print a
rem warning line before the results. Node 22 supports this flag.
if "%~1"=="" (
  "%NODEEXE%" --disable-warning=ExperimentalWarning "scripts\search.mjs" --interactive
) else (
  "%NODEEXE%" --disable-warning=ExperimentalWarning "scripts\search.mjs" %*
)
echo.
pause
