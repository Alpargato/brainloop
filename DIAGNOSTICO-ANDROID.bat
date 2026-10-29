@echo off
setlocal
title Brainloop - Diagnostico USB
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo  [X] No se encuentra Node.js. Ejecuta antes CONSTRUIR-APK.bat
  pause
  exit /b 1
)
node scripts\diagnostico-android.mjs %*
echo.
pause
