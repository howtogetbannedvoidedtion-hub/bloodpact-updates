@echo off
title BloodPact Launcher
color 0C
cd /d "%~dp0"

echo.
echo   ========================================
echo     BloodPact - Starting...
echo   ========================================
echo.

echo %~dp0 | findstr /i /c:".zip\" >nul
if not errorlevel 1 (
  echo   PROBLEM: You are running BloodPact FROM INSIDE THE ZIP.
  echo.
  echo   Fix:
  echo   1. Right-click BloodPact-For-Friend.zip
  echo   2. Click "Extract All"
  echo   3. Open the EXTRACTED folder on your Desktop
  echo   4. Run 2-Open-BloodPact.bat from THERE
  echo.
  echo   Do NOT double-click files while still inside the zip.
  echo.
  pause
  exit /b 1
)

echo   Checking bundled runtimes...

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\ensure-runtime.ps1" -LauncherOnly

if errorlevel 1 (

  echo.

  echo   PROBLEM: Could not set up Node.js for the launcher.

  echo   Check your internet connection and try again.

  echo.

  pause

  exit /b 1

)



set "NODE_EXE="

where node >nul 2>&1

if not errorlevel 1 (

  set "NODE_EXE=node"

) else if exist "%~dp0tools\runtime\node\node.exe" (

  set "NODE_EXE=%~dp0tools\runtime\node\node.exe"

) else (

  for /r "%~dp0tools\runtime\node" %%F in (node.exe) do (

    set "NODE_EXE=%%F"

    goto :node_found

  )

)



:node_found

if "%NODE_EXE%"=="" (

  echo   PROBLEM: Node.js is not available.

  echo   Run 4-Prepare-For-Sharing.bat once with internet, or install Node from https://nodejs.org

  echo.

  pause

  exit /b 1

)



echo   Node.js ready.

echo   First launch may take 1-3 minutes to download launcher files...

echo.



cd launcher

"%NODE_EXE%" bootstrap.js

set ERR=%ERRORLEVEL%



if %ERR% NEQ 0 (

  echo.

  echo   PROBLEM: Launcher failed to start.

  echo   Check the file: launcher\bloodpact-launcher.log

  echo.

  pause

  exit /b %ERR%

)



echo.

echo   BloodPact window should have opened.

echo   If you do not see it, check your taskbar.

echo.

timeout /t 4 >nul

