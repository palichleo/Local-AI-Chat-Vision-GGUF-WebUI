@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 ou plus recent est requis.
  pause
  exit /b 1
)
rem The update replaces this file while node runs: the block below is read in one go,
rem so nothing of the new copy is executed by this window.
(
  node "%~dp0scripts\rescue-update.mjs" %* || (
    pause
    exit /b 1
  )
  exit /b 0
)
