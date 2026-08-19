@echo off
title Microsoft Rewards GUI Server
cd /d "%~dp0"

:: Port: read from gui-settings.json (set in GUI Settings page), default 3000
:: PowerShell reads the port value without parentheses to stay valid inside for /f
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "Get-Content -Raw '%~dp0gui-settings.json' -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue | Select-Object -ExpandProperty port"`) do set "PORT=%%p"
if "%PORT%"=="" set PORT=3000

if not exist "server.js" (
    echo [ERROR] server.js not found. Current directory: %cd%
    pause
    exit /b 1
)

echo ================================================
echo   Starting Microsoft Rewards Script Console...
echo   Port: http://localhost:%PORT%
echo ================================================
echo.

:: 1. Open the browser asynchronously (auto-open localhost:%PORT% after 3 seconds)
start "" powershell -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:%PORT%'"

:: 2. Run the Node server in the current window, logs print here
node server.js

pause