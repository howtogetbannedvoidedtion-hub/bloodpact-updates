@echo off
title BloodPact - Apply Repair Files
color 0C
cd /d "%~dp0"

echo.
echo   ========================================
echo     BloodPact - Apply Repair Files
echo   ========================================
echo.

if exist "%CD%\BloodPact-Repair\launcher\bootstrap.js" (
  echo   Found BloodPact-Repair subfolder — merging into this folder...
  echo.
  xcopy "%CD%\BloodPact-Repair\*" "%CD%\" /E /Y /I >nul
  if errorlevel 1 (
    echo   Could not merge repair files.
    pause
    exit /b 1
  )
  echo   Repair files merged.
  echo.
)

if not exist "%CD%\launcher\bootstrap.js" (
  echo   PROBLEM: launcher\bootstrap.js is missing.
  echo   Copy the repair zip contents into this folder first.
  echo.
  pause
  exit /b 1
)

call "%CD%\FIX-BLOODPACT.bat"
