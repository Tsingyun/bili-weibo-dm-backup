@echo off
rem P1-6 Missing-message audit (read-only online check).
rem Compares what is on the server against what you have locally, so a
rem silently skipped page is noticed instead of leaving a hole forever.
rem Usage:
rem   double-click        = audit all sessions (needs a valid login)
rem   this-file.cmd --offline = local-only check, no network at all
rem   this-file.cmd --session bili = only this session
rem NOTE: local seqno "gaps" are informational only - Bilibili seqno carries
rem bit-fields, so neighbouring messages often differ by ~4096 by design.
rem All user-facing text is printed by scripts\audit_gaps.mjs (UTF-8).
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

"%NODEEXE%" "scripts\audit_gaps.mjs" %*
echo.
pause
