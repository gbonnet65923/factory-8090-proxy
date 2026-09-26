@echo off
rem Starts the Factory 8090 proxy with the built-in dashboard.
rem Drop a .har file next to this script or paste credentials at
rem http://127.0.0.1:18090/ once it is running.
cd /d "%~dp0"
node server.mjs
pause
