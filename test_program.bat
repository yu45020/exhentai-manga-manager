cd /d "%~dp0"

:: Start the server
start "" cmd /c "npm run dev"

:: Run the Electron application
npx electron .