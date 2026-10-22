@echo off
rem Starts Pit Wall in the background (if it isn't already running) and opens it in the browser.
cd /d "%~dp0"
powershell -NoProfile -Command "try { Invoke-WebRequest http://127.0.0.1:4040/ -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  wscript //nologo "%~dp0start-hidden.vbs"
  timeout /t 3 /nobreak >nul
)
start "" http://127.0.0.1:4040/
