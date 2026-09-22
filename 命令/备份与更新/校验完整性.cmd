@echo off
rem P0-1 Integrity manifest (fully local).
rem Writes a sha256 manifest per session, then later checks files against it:
rem detects silent corruption / accidental deletion / half-written files.
rem Usage:
rem   double-click          = verify all sessions against the manifest
rem   this-file.cmd --build = (re)write the manifest - run this right after a full backup
rem   this-file.cmd --full  = hash EVERY file (slow but exhaustive; default samples)
rem   this-file.cmd --session bili = only this session
rem All user-facing text is printed by scripts\integrity.mjs (UTF-8).
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

rem No args -> verify (the common case when double-clicked).
if "%~1"=="" (
  "%NODEEXE%" "scripts\integrity.mjs" --verify
) else (
  "%NODEEXE%" "scripts\integrity.mjs" %*
)
echo.
pause
