@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title OrbitFS Remote Desktop Commander
color 0A

:menu
cls
echo ============================================================
echo   OrbitFS Remote Desktop Commander
echo ============================================================
echo.
echo   1. FIRST LINK / RELINK - run remote setup now
echo   2. Install / repair background task
echo   3. Start background task now
echo   4. Stop background task
echo   5. Restart background task
echo   6. Show status / relink URL / session ID
echo   7. Show logs
echo   8. Uninstall background task
echo   9. Open log folder
echo   0. Exit
echo.
echo First install: press 1 first. After linked, press 2.
echo After VPS restart: use 6 for status or 5 to restart.
echo.
set /p choice=Pick a number then press ENTER: 

if "%choice%"=="1" goto firstlink
if "%choice%"=="2" goto install
if "%choice%"=="3" goto start
if "%choice%"=="4" goto stop
if "%choice%"=="5" goto restart
if "%choice%"=="6" goto status
if "%choice%"=="7" goto logs
if "%choice%"=="8" goto uninstall
if "%choice%"=="9" goto openlogs
if "%choice%"=="0" exit /b 0
goto menu

:admincheck
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo Administrator permission is needed. A new admin window will open.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  echo.
  echo Press any key to close this non-admin window.
  pause >nul
  exit /b
)
exit /b 0

:runps
call :admincheck
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\remote-desktop-commander-task.ps1" -Action %1
echo.
echo Finished. Press any key to return to the menu.
pause >nul
goto menu

:firstlink
cls
echo ============================================================
echo   First link / relink
echo ============================================================
echo.
echo This runs the required interactive command:
echo npx @wonderwhy-er/desktop-commander@latest remote
echo.
echo The output is logged and the session_id is saved if found.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\remote-desktop-commander-first-link.ps1"
echo.
echo First-link command ended. Press any key to return to the menu.
pause >nul
goto menu

:install
call :runps install

:start
call :runps start

:stop
call :runps stop

:restart
call :runps restart

:status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\remote-desktop-commander-task.ps1" -Action verify
echo.
if exist "%~dp0runtime\remote-desktop-commander-task\current-session-id.txt" (
  echo Current saved session ID:
  type "%~dp0runtime\remote-desktop-commander-task\current-session-id.txt"
  echo.
)
if exist "%~dp0runtime\remote-desktop-commander-task\current-add-device-url.txt" (
  echo Current saved add-device URL:
  type "%~dp0runtime\remote-desktop-commander-task\current-add-device-url.txt"
  echo.
)
echo Press any key to return to the menu.
pause >nul
goto menu

:uninstall
call :runps uninstall

:logs
cls
echo ============================================================
echo   Remote Desktop Commander logs
echo ============================================================
echo.
set "LOGDIR=%~dp0runtime\remote-desktop-commander-task\logs"
if not exist "%LOGDIR%" (
  echo No log folder yet.
  echo Run option 1 first.
  echo.
  pause
  goto menu
)
echo FIRST LINK LOG:
echo ------------------------------------------------------------
powershell.exe -NoProfile -Command "if (Test-Path '%LOGDIR%\first-link.log') { Get-Content '%LOGDIR%\first-link.log' -Tail 80 } else { 'No first-link log yet.' }"
echo.
echo BACKGROUND LOG:
echo ------------------------------------------------------------
powershell.exe -NoProfile -Command "if (Test-Path '%LOGDIR%\remote-desktop-commander.log') { Get-Content '%LOGDIR%\remote-desktop-commander.log' -Tail 80 } else { 'No background log yet.' }"
echo.
echo ERROR LOG:
echo ------------------------------------------------------------
powershell.exe -NoProfile -Command "if (Test-Path '%LOGDIR%\remote-desktop-commander.err.log') { Get-Content '%LOGDIR%\remote-desktop-commander.err.log' -Tail 80 } else { 'No error log yet.' }"
echo.
echo Press any key to return to the menu.
pause >nul
goto menu

:openlogs
set "LOGDIR=%~dp0runtime\remote-desktop-commander-task\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
explorer "%LOGDIR%"
goto menu
