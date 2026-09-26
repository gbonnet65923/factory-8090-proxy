@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -File "%~dp0Start-From-Har.ps1"
echo.
echo Proxy stopped. Press any key to close this window.
pause >nul
