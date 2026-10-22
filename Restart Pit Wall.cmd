@echo off
rem Restarts Pit Wall once no chat is mid-reply. Safe to double-click at any time.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart.ps1"
echo.
pause
