@echo off
setlocal
set PORT=8099
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found on PATH. Install Python or run this app with any other static file server.
  pause
  exit /b 1
)

echo Starting Light Novel Translator at http://localhost:%PORT%
echo Remember to start Ollama with OLLAMA_ORIGINS=http://localhost:%PORT% set first.
echo Press Ctrl+C in this window to stop the server.
echo.

start "" http://localhost:%PORT%
python -m http.server %PORT%
