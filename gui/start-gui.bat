@echo off
title Microsoft Rewards GUI Server (port 3000)
cd /d "%~dp0"

:: Port config: edit here if port 3000 is in use (server.js reads the PORT env variable)
set PORT=3001

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