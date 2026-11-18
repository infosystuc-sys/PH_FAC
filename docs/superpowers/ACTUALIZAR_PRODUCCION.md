# Actualizar producción desde GitHub

Desde el 18/11/2026 el circuito es:

1. **PC de desarrollo** (`D:\app\ph_fac`): se programa, se prueba contra la base de desarrollo y se hace `git push origin master` a [`infosystuc-sys/PH_FAC`](https://github.com/infosystuc-sys/PH_FAC).
2. **Servidor de producción:** baja `master` del repo, migra la base y recompila.

`docs/informes/` **no va al repo** (está en `.gitignore`). Tiene CSV y consultas con datos reales de Tango, y queda solo en la PC de desarrollo. Los scripts que haya que correr en producción (por ejemplo `diagnostico_produccion.sql`) se pasan a mano.

## Primera vez en el servidor

Si la carpeta de producción no es todavía un clon del repo:

```bat
cd /d D:\app
git clone https://github.com/infosystuc-sys/PH_FAC.git PH_FAC_nuevo
```

- Copiar a `PH_FAC_nuevo` el `.env.local` de la carpeta de producción actual. Ese archivo no está en el repo y no tiene que estarlo.
- Si la app guarda archivos en `storage\` (los PDF importados), copiar o mover esa carpeta también: tampoco está en el repo.
- Después, los pasos de "Cada actualización" desde el 3.

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
