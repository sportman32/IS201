@echo off
rem Double-click this file to start the Finance Dashboard and open it in your browser.
title Finance Dashboard
cd /d "%~dp0"

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
  echo For maximum security, move the folder somewhere like C:\Apps
  echo.
)

echo Starting Finance Dashboard...
echo Keep this window open while you use the app. Close it to stop the app.
echo.
node server.js --open
echo.
pause
