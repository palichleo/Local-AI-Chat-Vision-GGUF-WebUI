@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 ou plus recent est requis.
  pause
  exit /b 1
)
node "%~dp0scripts\launch.mjs" --open %*
set "ATELIER_EXIT=%errorlevel%"
if not "%ATELIER_EXIT%"=="0" pause
exit /b %ATELIER_EXIT%
