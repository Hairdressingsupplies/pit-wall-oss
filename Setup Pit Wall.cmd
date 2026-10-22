@echo off
rem Sets up Pit Wall on this PC (safe to run again). Guide: docs\setup-for-team.html
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it in PowerShell with:  winget install OpenJS.NodeJS & echo Then close this window and double-click Setup Pit Wall.cmd again. & pause & exit /b 1)
node -e "process.exit(+process.versions.node.split('.')[0] >= 24 ? 0 : 1)" || (echo Pit Wall needs Node 24 or newer. Update it in PowerShell with:  winget upgrade OpenJS.NodeJS & pause & exit /b 1)
node src\setup.mjs %*
pause
