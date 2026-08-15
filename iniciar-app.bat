@echo off
setlocal
title PH_FAC - Importador de comprobantes

REM ---------------------------------------------------------------------
REM Levanta PH_FAC. La app es un solo proceso Next.js: la UI y la conexion
REM a Tango corren juntas, no hay backend y frontend separados.
REM
REM Doble clic en este archivo y listo. Deja la ventana abierta mientras
REM uses la app: si la cerras, se corta el servidor.
REM ---------------------------------------------------------------------

set PUERTO=3013
set URL=http://localhost:%PUERTO%/comprobantes

REM Este mismo archivo se relanza con --abrir-navegador para esperar en
REM paralelo a que el server conteste. Ver el bloque :ABRIR al final.
if "%~1"=="--abrir-navegador" goto ABRIR

cd /d "%~dp0"

REM Sin .env.local no hay credenciales de SQL Server y la app arranca pero
REM falla en la primera consulta, con un error que no dice que falta esto.
if not exist ".env.local" (
  echo.
  echo   FALTA EL ARCHIVO .env.local
  echo.
  echo   Sin el, la app no puede conectarse a la base PUNTO_HOGAR_1.
  echo   Hay que copiar .env.local.example como .env.local y cargar
  echo   ahi las credenciales de SQL Server.
  echo.
  pause
  exit /b 1
)

REM El puerto se fija a proposito. Sin el flag, Next arranca en el 3000 y
REM salta solo al primero libre si esta ocupado: la URL cambiaria de un dia
REM para el otro sin avisar. Si el 3013 esta tomado preferimos frenar y
REM decirlo, en vez de abrir la app en una direccion distinta.
netstat -ano | findstr ":%PUERTO% " | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo   EL PUERTO %PUERTO% YA ESTA OCUPADO
  echo.
  echo   Puede ser que la app ya este corriendo en otra ventana. Para
  echo   comprobarlo, entrar a %URL%
  echo.
  echo   Si es otro programa, cerrarlo o cambiar la variable PUERTO en la
  echo   linea 14 de este archivo.
  echo.
  pause
  exit /b 1
)

echo.
echo   Levantando PH_FAC en %URL%
echo.
echo   La primera compilacion tarda entre 20 y 40 segundos. El navegador
echo   se abre solo cuando la app esta lista.
echo.
echo   Para cerrarla: Ctrl+C en esta ventana, o cerrar la ventana.
echo.

start "PH_FAC navegador" /min "%~f0" --abrir-navegador

call pnpm dev -p %PUERTO%

REM Solo se llega aca si pnpm termino. Con Ctrl+C es lo esperado; si fue un
REM error de arranque, la pausa deja leer el mensaje antes de que la
REM ventana se cierre.
echo.
echo   El servidor se detuvo.
pause
exit /b

REM ---------------------------------------------------------------------
:ABRIR
REM Espera a que el server conteste de verdad en vez de adivinar cuanto
REM tarda de compilar: con un timeout fijo, el navegador abre en "no se
REM puede acceder a este sitio" cada vez que la compilacion tarda de mas.
REM 60 intentos cada 2 segundos = 2 minutos de margen.
for /l %%i in (1,1,60) do (
  curl -s -o nul --max-time 3 %URL% && (
    start "" %URL%
    exit /b
  )
  timeout /t 2 /nobreak >nul
)
exit /b
