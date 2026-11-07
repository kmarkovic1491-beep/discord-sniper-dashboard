@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install the LTS version from https://nodejs.org/en/download
  echo Then double-click this file again.
  pause
  exit /b 1
)
echo Starting SNIPERS OG...
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node server.js
echo.
echo SNIPERS OG has stopped.
pause
