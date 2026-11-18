# Actualizar producción desde GitHub

Desde el 18/11/2026 el circuito es:

1. **PC de desarrollo** (`D:\app\ph_fac`): se programa, se prueba contra la base de desarrollo y se hace `git push origin master` a [`infosystuc-sys/PH_FAC`](https://github.com/infosystuc-sys/PH_FAC).
2. **Servidor de producción:** baja `master` del repo, migra la base y recompila.

`docs/informes/` **no va al repo** (está en `.gitignore`). Tiene CSV y consultas con datos reales de Tango, y queda solo en la PC de desarrollo. Los scripts que haya que correr en producción (por ejemplo `diagnostico_produccion.sql`) se pasan a mano.

## Dónde están los datos de producción

Ninguno de estos lugares lo toca el repo: `git clone` y `git pull` no los crean ni los pisan.

| Dato | Dónde | Qué hacer al actualizar |
|---|---|---|
| Comprobantes, renglones, series, auditoría, configuración | Tablas `PHF_*` en la base de producción | Nada. `pnpm migrate` solo agrega lo que falta (tablas, columnas con NULL o DEFAULT, índices). No borra ni modifica filas |
| PDF importados | `PHF_STORAGE_DIR` del `.env.local`. Si no está, `storage\` dentro de la carpeta de la app | Que la versión nueva apunte a la **misma** carpeta |
| Carpeta que escanea la app (`pendientes`, `procesados`, `error`) | Ruta guardada en `PHF_CONFIGURACION`, fuera de la app | Nada |
| Credenciales, API key, CUIT propio | `.env.local` | Copiarlo a la carpeta nueva |

En producción **no** se corren `pnpm seed` ni `pnpm test`: los dos escriben en la base.

## Primera vez: pasar de la carpeta actual a un clon del repo

Si la carpeta de producción no es un clon del repo, no se toca. Se arma una carpeta nueva al lado y la vieja queda intacta para volver atrás.

1. **Backup de la base de producción** (lo hace el usuario o el DBA). La migración no borra nada, pero es el único paso que cambia la base.
2. **Clonar** en una carpeta nueva:
   ```bat
   cd /d D:\app
   git clone https://github.com/infosystuc-sys/PH_FAC.git PH_FAC_nuevo
   cd PH_FAC_nuevo
   pnpm install --frozen-lockfile
   ```
3. **Copiar `.env.local`** de la carpeta vieja a la nueva.
4. **PDF:** si el `.env.local` ya tiene `PHF_STORAGE_DIR`, no hay nada que hacer. Si no lo tiene, agregarle la ruta **absoluta** de la carpeta `storage` vieja, por ejemplo `PHF_STORAGE_DIR=D:\app\PH_FAC\storage`. Así las dos versiones ven los mismos PDF y no hay que copiar nada.
5. **Cerrar la app vieja** (su ventana de `iniciar-app.bat`), cuando nadie esté revisando un comprobante. Los comprobantes a medio procesar quedan en la base y la versión nueva los retoma.
6. **Migrar**, desde la carpeta nueva: `pnpm migrate`.
7. **Arrancar** la nueva: `iniciar-app.bat` (compila la primera vez). Usa el mismo puerto 3013, así que los operadores entran por la misma dirección.
8. Cambiar el acceso directo o la tarea programada que arrancaba la app para que apunte a la carpeta nueva.
9. **Volver atrás:** cerrar la nueva y arrancar `iniciar-app.bat` de la carpeta vieja.

Si el repo pasa a privado, el clon y el `pull` necesitan una deploy key de solo lectura (GitHub → Settings → Deploy keys) o un token.

## Cada actualización

En la carpeta de producción, con la app cerrada (cerrar la ventana de `iniciar-app.bat`):

1. **Guardar la compilación actual**, para poder volver atrás:
   ```bat
   for /f %c in ('git rev-parse --short HEAD') do xcopy /e /i /q .next .next-%c
   ```
2. **Bajar el código:**
   ```bat
   git pull --ff-only origin master
   ```
   Si se niega, alguien cambió archivos en el servidor: `git status` muestra cuáles. No forzar sin mirarlos.
3. **Dependencias**, solo si cambió `package.json` o `pnpm-lock.yaml`:
   ```bat
   pnpm install --frozen-lockfile
   ```
4. **Migrar la base** (idempotente, solo toca tablas `PHF_`). **Antes de arrancar la versión nueva:** sin esto la app falla.
   ```bat
   pnpm migrate
   ```
5. **Recompilar y arrancar:**
   ```bat
   iniciar-app.bat --recompilar
   ```
   Sin `--recompilar` arranca la compilación vieja.

## Volver a la versión anterior

```bat
git checkout <commit anterior>
rmdir /s /q .next
xcopy /e /i /q .next-<commit anterior> .next
iniciar-app.bat
```

La base no se desmigra. Las migraciones de este pase agregan columnas a tablas `PHF_`; no está probado que la versión vieja funcione sobre la base ya migrada. Probarlo en desarrollo antes de depender de esta vuelta atrás. Para volver a seguir `master`: `git checkout master`.
