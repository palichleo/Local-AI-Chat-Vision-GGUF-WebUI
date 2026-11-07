@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 ou plus recent est requis.
  pause
  exit /b 1
)
node server.mjs --open
if errorlevel 1 pause
