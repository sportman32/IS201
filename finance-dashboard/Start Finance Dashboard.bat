@echo off
rem Double-click this file to start the Finance Dashboard and open it in your browser.
title Finance Dashboard
cd /d "%~dp0"

rem Ignore settings that could make Node.js load extra code or skip security checks.
set "NODE_OPTIONS="
set "NODE_TLS_REJECT_UNAUTHORIZED="
set "NODE_EXTRA_CA_CERTS="

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Download the LTS version from https://nodejs.org, install it,
  echo then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo "%~dp0" | find /i "OneDrive" >nul
if not errorlevel 1 (
  echo NOTE: This folder is inside OneDrive, so your encrypted vault will sync to the cloud.
  echo For maximum security, move the folder to %USERPROFILE%\Apps
  echo.
)

echo "%~dp0" | find /i "%USERPROFILE%" >nul
if errorlevel 1 (
  echo NOTE: This folder is outside your user folder, so other accounts on this PC
  echo may be able to change the app's files. For maximum security, move it to %USERPROFILE%\Apps
  echo.
)

echo Starting Finance Dashboard...
echo Keep this window open while you use the app. Close it to stop the app.
echo.
node server.js --open
echo.
pause
