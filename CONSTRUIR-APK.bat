@echo off
setlocal
title Brainloop - Construir APK
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :nonode

node scripts\construir-apk.mjs %*
echo.
pause
exit /b

:nonode
echo.
echo  [X] No se encuentra Node.js en este PC.
echo.
where winget >nul 2>nul
if errorlevel 1 goto :manual
choice /C SN /M " Instalar Node.js LTS ahora con winget"
if errorlevel 2 goto :manual
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo  Node.js instalado. Cierra esta ventana y vuelve a abrir CONSTRUIR-APK.bat
pause
exit /b 1

:manual
echo  Descarga Node.js LTS desde https://nodejs.org y vuelve a abrir este archivo.
start "" "https://nodejs.org/es/download"
pause
exit /b 1
