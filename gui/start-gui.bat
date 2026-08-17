@echo off
title Microsoft Rewards GUI Server (port 3001)
cd /d "%~dp0"

:: 端口配置：若 3000 被占用请修改此处（server.js 会读取 PORT 环境变量）
set PORT=3001

if not exist "server.js" (
    echo [错误] 未找到 server.js，当前目录: %cd%
    pause
    exit /b 1
)

echo ================================================
echo   正在启动 Microsoft Rewards Script 控制台...
echo   端口: http://localhost:%PORT%
echo ================================================
echo.

:: 1. 异步唤起浏览器（3秒后自动打开 localhost:%PORT%）
start "" powershell -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:%PORT%'"

:: 2. 直接在当前窗口运行 Node 服务，日志直接在当前窗口输出
node server.js

pause