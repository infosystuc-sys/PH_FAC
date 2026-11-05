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

REM Sin .env.local no hay credenciales de SQL Server y la app arranca pero
REM falla en la primera consulta, con un error que no dice que falta esto.
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

REM El puerto se fija a proposito. Sin el flag, Next arranca en el 3000 y
REM salta solo al primero libre si esta ocupado: la URL cambiaria de un dia
REM para el otro sin avisar. Si el 3013 esta tomado preferimos frenar y
REM decirlo, en vez de abrir la app en una direccion distinta.
netstat -ano | findstr ":%PUERTO% " | findstr "LISTENING" >nul
if not errorlevel 1 (
  REM Ocupado no siempre es un problema: lo normal es que sea la propia app
  REM ya levantada --otra ventana de este mismo .bat, o un servidor que
  REM quedo corriendo--. En ese caso lo util es abrir el navegador y no
  REM mandar al operador a averiguar que paso. Se distingue preguntandole
  REM al puerto: si contesta nuestra URL, es la app (2026-10-10).
  curl -s -o nul --max-time 5 %URL%
  if not errorlevel 1 (
    echo.
    echo   LA APP YA ESTA CORRIENDO en %URL%
    echo.
    echo   Se abre el navegador. Esta ventana se puede cerrar: el servidor
    echo   lo levanto otra, y cerrar esta no lo corta.
    echo.
    start "" %URL%
    REM El 2^>nul es para cuando se corre con la entrada redirigida (un
    REM script, no un doble clic): ahi timeout no puede esperar y escribe
    REM un error que no significa nada. Con doble clic espera normal.
    timeout /t 4 /nobreak >nul 2>nul
    exit /b 0
  )
  echo.
  echo   EL PUERTO %PUERTO% ESTA OCUPADO POR OTRO PROGRAMA
  echo.
  echo   Algo esta escuchando en el %PUERTO% pero no es PH_FAC: no
  echo   contesta en %URL%
  echo.
  echo   Hay que cerrar ese programa, o cambiar la variable PUERTO en la
  echo   linea 14 de este archivo.
  echo.
  pause
  exit /b 1
)

echo.
echo   Levantando PH_FAC en %URL%
echo.
echo   Corre la version compilada (produccion): cada pantalla abre al
echo   instante. Si no hay compilacion previa, o se pidio recompilar, la
echo   compilacion tarda uno o dos minutos antes de levantar. El navegador
echo   se abre solo cuando la app esta lista.
echo.
echo   Para cerrarla: Ctrl+C en esta ventana, o cerrar la ventana.
echo.

start "PH_FAC navegador" /min "%~f0" --abrir-navegador

REM Produccion en vez de `pnpm dev`: el modo desarrollo compila cada pantalla
REM la primera vez que se entra (unos 5 segundos por pantalla) y otra vez
REM despues de cada reinicio. Compilado, todas abren sin esa espera.
REM
REM Se compila solo si no hay una compilacion previa o si se ejecuta este
REM archivo con --recompilar. Despues de actualizar el codigo hay que usar
REM --recompilar: sin eso arranca la version anterior.
set COMPILAR=0
if not exist ".next\BUILD_ID" set COMPILAR=1
REM Una compilacion a medias (cortada, o pisada por el modo desarrollo de
REM antes) tiene BUILD_ID pero no este manifiesto, y no arranca.
if not exist ".next\prerender-manifest.json" set COMPILAR=1
if "%~1"=="--recompilar" set COMPILAR=1
if "%COMPILAR%"=="1" (
  echo   Compilando...
  call pnpm build
  if errorlevel 1 (
    echo.
    echo   LA COMPILACION FALLO. Mas arriba esta el detalle.
    pause
    exit /b 1
  )
)

call pnpm start -p %PUERTO%

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
