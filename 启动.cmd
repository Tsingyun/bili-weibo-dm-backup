@echo off
rem ============================================================
rem  DM backup - single entry launcher (portable package)
rem  ------------------------------------------------------------
rem  Double-click this file. It starts a small local server on
rem  127.0.0.1 and opens your browser. Nothing leaves this machine.
rem
rem  This file is a thin wrapper. All the real work lives in
rem  scripts\webui.ps1 (runtime lookup, version check, server start,
rem  browser open). Keeping one copy of that logic means the banner
rem  and the error messages can never drift apart between the two.
rem
rem  scripts\webui.ps1 is saved as UTF-8 *with BOM* - that is what
rem  makes its Chinese output render correctly in Windows PowerShell
rem  5.1. Do not re-save it as plain UTF-8.
rem
rem  Optional arguments are passed straight through:
rem      -Port 8787      pick a port (default 8787)
rem      -NoOpen         do not open the browser automatically
rem  Example from a terminal:
rem      dm-backup\launcher -NoOpen -Port 9000
rem ============================================================
chcp 65001 >nul

rem Resolve the package root from this file's own location, so it
rem works no matter which folder the shell happens to be in.
cd /d "%~dp0"

if not exist "scripts\webui.ps1" (
  echo [x] scripts\webui.ps1 was not found under:
  echo     %CD%
  echo     This file must stay in the package root; please put it back
  echo     and double-click it again.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\webui.ps1" %*
echo.
pause
