@echo off
title Stop Microsoft Rewards GUI Server
chcp 65001 >nul

echo ================================================
echo   正在停止 Microsoft Rewards GUI 服务...
echo ================================================

:: 停止端口配置：需与 start-gui.bat 中的 set PORT 保持一致
set PORT_TO_KILL=3000

:: 按端口精准清理：查找监听 PORT_TO_KILL 的 PID 并强制结束
:: 不用 taskkill /im node.exe（会误杀其他 Node 进程，如你的其他脚本）
for /f "tokens=5" %%i in ('netstat -ano ^| findstr ":%PORT_TO_KILL%" ^| findstr "LISTENING"') do (
    echo [GUI] 结束进程 PID %%i （端口 %PORT_TO_KILL%）
    taskkill /f /pid %%i >nul 2>&1
)

echo.
echo [完成] 已尝试停止端口 %PORT_TO_KILL% 上的服务。
echo       若上方无 "结束进程" 输出，说明服务本就没在运行。
echo       其他 Node 进程不受影响。
pause