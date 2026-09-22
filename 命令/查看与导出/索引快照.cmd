@echo off
rem P0-2 Index snapshot / rollback (fully local).
rem Make a snapshot BEFORE touching indexes (rebuild / compress / doctor --fix),
rem so a bad run can be rolled back.
rem Usage:
rem   double-click            = make a snapshot of all sessions
rem   this-file.cmd --list    = list snapshots
rem   this-file.cmd --restore <id>   = roll back to a snapshot
rem   this-file.cmd --session bili   = only this session
rem All user-facing text is printed by scripts\snapshot.mjs (UTF-8).
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

rem No args -> default to making a snapshot (the common case when double-clicked).
if "%~1"=="" (
  "%NODEEXE%" "scripts\snapshot.mjs" --make
) else (
  "%NODEEXE%" "scripts\snapshot.mjs" %*
)
echo.
pause
