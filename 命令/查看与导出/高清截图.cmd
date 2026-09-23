@echo off
rem HD screenshot export - open the viewer over a LOCAL http server.
rem
rem Why not just double-click the .html file: a file:// page is not allowed to
rem composite local images into a canvas (the canvas gets "tainted" and the
rem export throws SecurityError). Over http://127.0.0.1 the images are composited
rem normally, so the exported screenshots contain real pictures at 2x / 3x.
rem
rem Double-click this file, then in the page: click "Screenshot export" in the
rem sidebar, tick the messages you want (Shift+click selects a range), and press
rem export. Long selections are split into several images automatically.
rem
rem Everything stays on this machine. The server only listens on 127.0.0.1.
rem Optional: -Port 18787 (default 8787)
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

rem -OpenPath /viewer makes the browser land directly on the viewer page
rem instead of the WebUI home page.
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\webui.ps1" -OpenPath /viewer %*
echo.
pause
