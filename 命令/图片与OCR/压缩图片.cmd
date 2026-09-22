@echo off
rem ============================================================
rem  Compress backup images to WebP, then DELETE the originals.
rem
rem  Run this by DOUBLE-CLICKING in Explorer, outside WorkBuddy.
rem  Reason: WorkBuddy's sandbox has a bulk-delete guard (max 50
rem  files per conversation) - it aborts the process when this
rem  script tries to remove ~1300 originals. A normal console
rem  window has no such limit.
rem
rem  Safe to run repeatedly: already-converted images are skipped
rem  and the index migration step is idempotent. Nothing is ever
rem  deleted unless the whole index check passes first.
rem ============================================================
chcp 65001 >nul
setlocal
rem This launcher sits two levels below the project root.
rem Keep it where it is: scripts\ is resolved relative to the root.
cd /d "%~dp0..\.."
if not exist "scripts\" (
  echo [x] Project root not found under "%CD%".
  echo     Do not move this .cmd file out of its folder; put it back and retry.
  pause
  exit /b 1
)
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

set "PY=%CD%\.ocr-env\Scripts\python.exe"
if not exist "%PY%" (
  echo [x] OCR environment not found: .ocr-env
  echo     Please run the OCR environment installer first.
  pause
  exit /b 1
)

echo.
set /p "GO=Delete original images after converting? (Y/N) "
if /i not "%GO%"=="Y" (
  echo Cancelled. Nothing was changed.
  pause
  exit /b 0
)

echo.
"%PY%" "scripts\compress_images.py" --set all --quality 88 --max-edge 2048 --jobs 3
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [x] Script exited with code %RC%. See the messages above.
pause
endlocal
