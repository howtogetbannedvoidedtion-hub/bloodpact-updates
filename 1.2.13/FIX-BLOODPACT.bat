@echo off
title BloodPact - Fix and Play
color 0C
cd /d "%~dp0"

echo.
echo   ========================================
echo     BloodPact - Repair and Play
echo   ========================================
echo.

echo %CD% | findstr /i /c:".zip\" >nul
if not errorlevel 1 (
  echo   PROBLEM: You are running FROM INSIDE THE ZIP.
  echo   Extract All first, then run this from the extracted folder.
  echo.
  pause
  exit /b 1
)

if not exist "%CD%\launcher\bootstrap.js" (
  echo   PROBLEM: Run this from inside your BloodPact folder.
  echo   It must sit next to launcher\ and 2-Open-BloodPact.bat
  echo.
  echo   If you see BloodPact-For-Friend\BloodPact-For-Friend, move
  echo   everything up one folder so you only have ONE BloodPact folder.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\tools\friend-cleanup.ps1" -RepairRoot "%CD%"
if errorlevel 1 (
  echo.
  echo   Repair failed. Read the message above.
  pause
  exit /b 1
)

echo.
echo   Opening BloodPact launcher...
echo.
call "%CD%\2-Open-BloodPact.bat"
