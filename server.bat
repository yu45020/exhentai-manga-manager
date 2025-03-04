@echo off
:: Check if running as administrator
:: net session >nul 2>&1
:: if %errorlevel% neq 0 (
::     echo Requesting administrator privileges...
::     powershell -Command "Start-Process '%~f0' -Verb RunAs"
::     exit /b
:: )

:: Move to the directory where your project resides
cd /d "%~dp0"

npm run dev

pause 