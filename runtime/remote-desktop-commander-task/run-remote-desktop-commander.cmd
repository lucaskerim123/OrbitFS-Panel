@echo off
setlocal
cd /d "F:\OrbitFS Project\OrbitFS-Panel\runtime\remote-desktop-commander-task"
echo ===== started %DATE% %TIME% =====>> "F:\OrbitFS Project\OrbitFS-Panel\runtime\remote-desktop-commander-task\logs\remote-desktop-commander.log"
echo npx: C:\Program Files\nodejs\npx.cmd>> "F:\OrbitFS Project\OrbitFS-Panel\runtime\remote-desktop-commander-task\logs\remote-desktop-commander.log"
"C:\Program Files\nodejs\npx.cmd" --yes @wonderwhy-er/desktop-commander@latest >> "F:\OrbitFS Project\OrbitFS-Panel\runtime\remote-desktop-commander-task\logs\remote-desktop-commander.log" 2>> "F:\OrbitFS Project\OrbitFS-Panel\runtime\remote-desktop-commander-task\logs\remote-desktop-commander.err.log"
echo ===== exited %DATE% %TIME% code %ERRORLEVEL% =====>> "F:\OrbitFS Project\OrbitFS-Panel\runtime\remote-desktop-commander-task\logs\remote-desktop-commander.log"
exit /b %ERRORLEVEL%
