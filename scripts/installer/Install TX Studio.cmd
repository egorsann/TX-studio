@echo off
rem Installs TX Studio for this Windows user (no admin rights) and creates shortcuts.
rem Run it again to update to a newer version.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\install.ps1"
if errorlevel 1 (
  echo.
  echo Installation failed - see the message above.
  pause
  exit /b 1
)
rem short pause so the summary can be read (works without a console, unlike timeout)
ping -n 5 127.0.0.1 >nul
