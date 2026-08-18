' ===== Silent start of Microsoft Rewards GUI service =====
' Runs start-gui.bat via WScript.Shell with a hidden window (window mode 0).
' Double-click this file to start the service without a CMD black box;
' the browser will open automatically.
' NOTE: comments are ASCII-only so this file is encoding-independent.

Set shell = CreateObject("WScript.Shell")

' Window mode 0 = hidden (no CMD console window)
' False = do not wait for the bat to finish before returning
shell.Run "start-gui.bat", 0, False

Set shell = Nothing
