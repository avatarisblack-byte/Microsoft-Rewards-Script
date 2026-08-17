' ===== 静默启动 Microsoft Rewards GUI 服务 =====
' 用 WScript.Shell 以隐藏窗口（窗口模式参数 0）运行 start-gui.bat
' 双击本文件即可在后台无黑框启动服务，浏览器会自动打开面板

Set shell = CreateObject("WScript.Shell")

' 窗口模式参数 0 = 隐藏窗口（不弹出 CMD 黑框）
' False = 不等待 bat 执行完成即返回
shell.Run "start-gui.bat", 0, False

Set shell = Nothing