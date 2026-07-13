@echo off
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator permission...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Installing Remote Desktop Commander as a background Scheduled Task...
echo This does NOT use the broken service wrapper.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0remote-desktop-commander-task.ps1" -Action install
set "RESULT=%errorlevel%"

echo.
if not "%RESULT%"=="0" (
  echo Install failed with exit code %RESULT%.
  echo.
  echo Check logs under:
  echo ..\runtime\remote-desktop-commander-task\logs
) else (
  echo Install finished.
)

echo.
echo Press any key to close.
pause >nul
exit /b %RESULT%
