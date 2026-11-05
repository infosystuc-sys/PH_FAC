@echo off
setlocal
title PH_FAC - Local (desarrollo)

REM ---------------------------------------------------------------------
REM Levanta PH_FAC solo para esta PC, en modo desarrollo.
REM
REM Distinto de iniciar-app.bat, que corre la version compilada para toda
REM la red: este escucha solo en 127.0.0.1 (nadie de la red entra) y en
REM modo desarrollo, asi que los cambios de codigo se ven al guardar, sin
REM recompilar. Cada pantalla tarda unos segundos la primera vez que se
REM abre, porque se compila en ese momento.
REM
REM Usa otro puerto (3014) para poder correr al mismo tiempo que la app
REM de produccion en el 3013.
REM ---------------------------------------------------------------------

set PUERTO=3014
set URL=http://localhost:%PUERTO%/comprobantes

if "%~1"=="--abrir-navegador" goto ABRIR

cd /d "%~dp0"

REM La carpeta con sus mayusculas reales, no como la tipeo el operador.
REM Windows no distingue "D:\app\ph_fac" de "D:\APP\PH_FAC", pero la
REM compilacion si: desde la ruta en minusculas webpack duplica los modulos
REM de Next y la app compilada no abre ninguna pantalla ("invariant
REM expected layout router to be mounted", 2026-11-05). Hay que salir de la
REM carpeta y volver a entrar: un cd a la misma carpeta no cambia como se
REM escribe.
set RAIZ=
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$d=[IO.DirectoryInfo]((Resolve-Path -LiteralPath '.').Path); $p=@(); while($d.Parent){$p=,($d.Parent.GetDirectories($d.Name)[0].Name)+$p; $d=$d.Parent}; $d.Name.ToUpper()+($p -join '\')"`) do set "RAIZ=%%P"
if defined RAIZ (cd /d "%SystemRoot%" & cd /d "%RAIZ%")

if not exist ".env.local" (
  echo.
  echo   FALTA EL ARCHIVO .env.local
  echo.
  echo   Sin el, la app no puede conectarse a la base de datos.
  echo   Hay que copiar .env.local.example como .env.local y cargar
  echo   ahi las credenciales de SQL Server.
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr ":%PUERTO% " | findstr "LISTENING" >nul
if not errorlevel 1 (
  curl -s -o nul --max-time 5 %URL%
  if not errorlevel 1 (
    echo.
    echo   LA APP LOCAL YA ESTA CORRIENDO en %URL%
    echo.
    start "" %URL%
    timeout /t 4 /nobreak >nul 2>nul
    exit /b 0
  )
  echo.
  echo   EL PUERTO %PUERTO% ESTA OCUPADO POR OTRO PROGRAMA
  echo.
  echo   Hay que cerrar ese programa, o cambiar la variable PUERTO en este
  echo   archivo.
  echo.
  pause
  exit /b 1
)

echo.
echo   Levantando PH_FAC local en %URL%
echo.
echo   Solo se puede abrir desde esta PC. El navegador se abre solo cuando
echo   la app esta lista (la primera vez puede tardar uno o dos minutos).
echo.
echo   Para cerrarla: Ctrl+C en esta ventana, o cerrar la ventana.
echo.

start "PH_FAC navegador" /min "%~f0" --abrir-navegador

REM Carpeta de compilacion propia: no pisa la de iniciar-app.bat (.next).
set PHF_DIST_DIR=.next-dev
call pnpm dev -H 127.0.0.1 -p %PUERTO%

echo.
echo   El servidor se detuvo.
pause
exit /b

REM ---------------------------------------------------------------------
:ABRIR
REM Espera a que el server conteste en vez de adivinar cuanto tarda.
REM 90 intentos cada 2 segundos = 3 minutos de margen.
for /l %%i in (1,1,90) do (
  curl -s -o nul --max-time 3 %URL% && (
    start "" %URL%
    exit /b
  )
  timeout /t 2 /nobreak >nul
)
exit /b
