@echo off
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator permission...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Installing OrbitFS Remote Desktop Commander service...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0remote-desktop-commander-service.ps1" -Action install
set "RESULT=%errorlevel%"

echo.
if not "%RESULT%"=="0" (
  echo Installation failed with exit code %RESULT%.
) else (
  echo Installation finished.
)

echo.
echo Press any key to close this window.
pause >nul
exit /b %RESULT%
