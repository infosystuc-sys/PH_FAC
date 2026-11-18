# Para continuar: pase a producción (sesión del 18/11/2026)

Documento de traspaso. Lo escribió la sesión del 18/11/2026, que se cortó por el límite de uso. Para retomar, leer esto primero y después [`RETOMAR.md`](RETOMAR.md). Si algo de este documento contradice a `RETOMAR.md`, gana este, que es más nuevo.

## Dónde está todo

- **Código:** `D:\app\ph_fac`, rama `master`. Tiene todo lo hecho. **Los hashes cambiaron el 18/11** al sacar `docs/informes` de la historia: el merge del DNRPA, que era `ac46ad9`, ahora es `efcfc8f`. El respaldo con los hashes viejos está en la rama local `respaldo-antes-de-quitar-informes`.
  - Se mergeó `fix/circuito-oc-factura-remito` (merge directo) y `feat/importar-dnrpa` (con commit de merge).
  - Las dos ramas siguen existiendo, ya mergeadas.
  - Las carpetas auxiliares `PH_FAC_master` y `PH_FAC_dnrpa` se borraron.
- **Push:** hecho el 18/11 a `infosystuc-sys/PH_FAC` (`origin/master` = `master`), sin `docs/informes`. Para actualizar producción desde el repo: [`ACTUALIZAR_PRODUCCION.md`](ACTUALIZAR_PRODUCCION.md).
- **Deploy:** no se hizo.
- **Verificado sobre `master`:**
  - typecheck sin errores;
  - `pnpm test`: 1092 tests pasan, contra la base de desarrollo;
  - `pnpm build` compila.
  - En el medio la suite falló 2 veces sin motivo y pasó al repetirla: es contención con la base cuando hay apps corriendo.
- **App de prueba:** `D:\app\PH_FAC_2026-11-17`, puerto **3013**.
  - Corre `master` (`ac46ad9`, hoy `efcfc8f`), compilada, apuntando a la base de **desarrollo** (`DESKTOP-OLHNIK3\AXSQLSERVER` / `PUNTO_HOGAR_1`).
  - La compilación anterior, que era la de producción (`da19035`), quedó en `.next-da19035` dentro de esa carpeta.
  - La app de la rama del puerto 3014 está apagada.
- **Producción hoy:** commit `da19035`.

## Qué cambió desde producción (`da19035`), para probar

Detalle por funcionalidad: los commits y `docs/informes/correccion_circuito_oc_factura_remito.md`. Pruebas documentadas con fotos de Tango, todas en `docs/informes/pruebas_desarrollo/`:

| Prueba | Carpeta |
|---|---|
| Factura y remito con serie de IMSA, OC 1706 | `prueba_serie_oc1706/` |
| Factura-remito de ZOZZOLI, OC 1707 | `prueba_factura_remito_oc1707/` |
| Remito de NEWSAN sin factura y su factura, OC 1708 | `prueba_remito_oc1708/` |
| Conceptos de producción re-registrados | `resultado_conceptos_2026-11-18.md` |

Lo del 18/11, todo por pedido del usuario:

1. **IMSA (`010337`), artículos con serie:** busca el sinónimo con el código entero (hasta 15) antes que con los 8 primeros caracteres. `src/lib/codigoProveedor.ts`.
2. **Código impreso de más de 15 caracteres:** se busca exacto recortado a 15, antes del respaldo por principio. Es el caso de NEWSAN `CUBQU110BASEAZUL`.
3. **DNRPA opcional en el remito:** sin DNRPA, `COMENTARIO` lleva la serie, como Tango.
4. **Comprobantes ya registrados:** dejan de mostrar avisos falsos ("Ya existe un comprobante igual", "serie ya en stock").
5. **Factura imputada a una OC:** toma la condición de compra de la OC (`CPA35.COND_COMPR`).
6. **Remito sin factura:** la app **propone** las OC que tienen el artículo pendiente de recibir y el operador elige, por renglón o una para todo el remito. No se asigna sola. Se graba como Tango (OC en `STA20`, `CANT_PEND` = cantidad, precio 0, `CPA_OC_REMITO`, contadores de `CPA36`).
7. **Factura cuya OC ya tiene remito:**
   - **Cantidades iguales:** avisa al lado de la OC (tarjeta de renglones) y en "Listo para registrar", y pide el OK al **Confirmar datos**. Al registrar consume el remito (`CPA48`, `CPA_OC_REMITO_FACTURA`, `FALTA_REM`).
   - **Cantidades distintas:** **bloquea** con el detalle. Antes registraba y dejaba el resto en `FALTA_REM`.
8. **Pantalla `/dnrpa`** (pestaña "DNRPA" en la bandeja):
   - Se sube el mail del proveedor (PDF o imagen) y la IA lee chasis y DNRPA.
   - Vista previa; con el OK, graba `COMENTARIO` en `STA06` y en todos los `STA07` de la serie.
   - Solo pisa comentarios vacíos o iguales a la serie; lo demás se muestra y no se toca.
9. **Commit `ba3cfa8`, de otra sesión:** renglones sin OC con artículo que lleva stock quedan con `FALTA_REM` = cantidad. **No lo revisó esta sesión**: solo pasa sus tests.

## Pasos para pasar a producción

1. **Probar en el 3013** lo que haga falta. Es la versión que va a producción, contra la base de desarrollo.
2. **Push** de `master` a `origin`: hecho el 18/11. En el servidor se baja con `git pull` (ver `ACTUALIZAR_PRODUCCION.md`).
3. **Migrar la base de producción antes de arrancar la versión nueva:** `pnpm migrate`, desde una carpeta con el `.env.local` de producción.
   - Agrega columnas a las tablas `PHF_`. Entre otras: `REMITO_SIN_REFERENCIA` y `ARCHIVO_ORIGEN` en `PHF_COMPROBANTE`, `FAC_*` en `PHF_RENGLON` y `COMENTARIO` en la tabla de series del PDF.
   - Es idempotente.
   - **Sin esto la app nueva falla.**
   - Producción tiene además dos columnas que no están en ningún código (`INTENTOS_TRANSITORIOS`, `REINTENTAR_DESDE`). No molestan.
4. **Actualizar la carpeta de producción** a `master` y recompilar: `iniciar-app.bat --recompilar`. Sin `--recompilar`, arranca la compilación vieja.
5. Conviene guardar antes la carpeta `.next` de producción, para poder volver a `da19035`.

## Reglas que puso el usuario (siguen valiendo)

- **Producción, solo lectura.** Ningún INSERT, UPDATE, DELETE ni DDL, ni siquiera con rollback. Los scripts de producción los corre el usuario.
  - **Excepción:** el `pnpm migrate` del paso 3 es parte del pase, y lo hace el usuario.
- **Escrituras solo en desarrollo**, por la app o por los tests. Antes de escribir, verificar `SELECT @@SERVERNAME, DB_NAME()` (`DESKTOP-OLHNIK3\AXSQLSERVER` / `PUNTO_HOGAR_1`).
- **No leer ni usar** el `.env.local` de producción que está en `D:\app\_resguardo\`.
- **Credenciales:** las de SQL de desarrollo no van en archivos que vayan a git.
- **Archivos sin commitear que no son nuestros:** no tocarlos. Son `.env.local.example`, `Implementar.docx`, `docs/informes/evaluacion.pdf` y `docs/informes/tablas.pdf`.
- **Respuestas** en español rioplatense. Commits en español, en imperativo, con `Co-Authored-By`.
- **API key de Anthropic de desarrollo:** el usuario tiene pendiente rotarla, porque se imprimió en una salida de herramienta.

## Pendientes y decisiones abiertas

- **Libro IVA (hallazgos N3 y N4 de `resultado_conceptos_2026-11-18.md`):**
  - Factura C de monotributista: Tango la graba exenta, con `CPA63` al 0% `C9`.
  - Factura de RI solo exenta: Tango agrega `CPA63` al 0% `SIN`.
  - La app no hace ninguna de las dos. Están sin corregir.
- **Otros hallazgos sin corregir:**
  - N1: `CPA04.TIPO_COMPR` (`C` conceptos, `A` artículos).
  - N2: `ESTADO_STK` vacío en conceptos.
  - N5: `CLAS_SIAP` del artículo.
  - F13: cotización y unidades.
- **`CPA36.TIPO_DESVI`:** Tango a veces pone `N` en el renglón de OC recibido completo (1.993) y a veces vacío (4.544). La app lo deja vacío. No hay regla clara.
- **Factura con cantidades distintas a las del remito:** hoy bloquea. Si el usuario prefiere avisar y dejar seguir, es un cambio chico en `src/server/app/remitosDeFactura.ts` (`validarRemitosAVincular`).
- **CUIT 30-64261755-5 en dos proveedores** (`010003` NEWSAN y `010445` NEWSAN SA LG): el operador tiene que elegir el proveedor a mano en cada comprobante.
- **VERTEC (`010155`):** le falta el concepto en `CPA_CONCEPTOS_PROVEEDOR` del Tango de desarrollo.
- **DNRPA en las tablas de la app:** la importación no actualiza `PHF_SERIE`/`PHF_SERIE_PDF`, solo Tango.
- **`CLAUDE.md`:** falta anotar que la app ahora modifica `COMENTARIO` de `STA06`/`STA07` (importación del DNRPA), como están anotadas las demás escrituras en Tango.
- **`RETOMAR.md` y `HISTORIAL.md`:** no se actualizaron con lo del 18/11. Hay que pasar ahí lo de este documento.
- **Script de producción:** sigue pendiente correr `diagnostico_produccion.sql` en producción (de una sesión anterior).

## Herramientas de prueba (en `docs/informes/`)

- **`prueba_final/exportar_csv.ps1 -Sql x.sql -Salida carpeta`:** exporta consultas de solo lectura a CSV. Se niega si no es la base de desarrollo.
- **`prueba_final/extraer_factura_A0000100001705.sql` y `extraer_remito_R0000100001705.sql`:** plantillas para sacar todo lo que un comprobante dejó en Tango. Se cambian el proveedor y el número.
- **`pruebas_desarrollo/comparar_con_tango.mjs <FP>`:** compara una factura de la app con la última del mismo proveedor cargada desde Tango.
- **`pruebas_desarrollo/importar_phf_desarrollo.mjs` y `exportar_phf_produccion.ps1`:** traen comprobantes de producción a desarrollo para re-registrarlos.
