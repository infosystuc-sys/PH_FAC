# Estado del proyecto

**Actualizado: 2026-11-03.** Esto es lo que hay que saber para retomar. El detalle de cada funcionalidad (cómo se construyó, cómo se verificó, por qué se decidió lo que se decidió) está en la bitácora, [`HISTORIAL.md`](HISTORIAL.md). Si algo de la bitácora contradice esta página, gana esta página.

**Al terminar una sesión:** actualizá esta página (estado, pendientes, decisiones nuevas) y agregá el detalle en `HISTORIAL.md`, arriba de todo y con fecha. Esta página tiene que seguir entrando en una lectura.

---

## Entorno

| | |
|---|---|
| Base | `PUNTO_HOGAR_1` en `INFOSYS01\AXSQLSERVER` (Tango Gestión, datos reales). Necesita SQL Server Browser corriendo |
| Código | `D:\APP\PH_FAC`, rama `master` |
| PDFs importados | `PHF_STORAGE_DIR` = `C:/APP/PH_FAC/storage` (fuera del repo) |
| App | **Modo producción** en el puerto 3013 (`iniciar-app.bat`: `pnpm build` + `pnpm start -p 3013`) |
| Remoto | `origin` = `git@github.com:infosystuc-sys/PH_FAC.git` por SSH. El push funciona desde este servidor |

- **Todo cambio de código necesita rebuild + restart para que el operador lo vea, y un Ctrl+F5 en su navegador.** Sin el Ctrl+F5 se queda con el bundle viejo; ya generó un falso "no funciona" sobre un cambio que estaba aplicado.
- **Los tests pegan contra la base real.** Los que escriben van en `conRollback`. `migrar()` sin prefijo corre contra las tablas `PHF_*` reales, así que correr la suite aplica las migraciones pendientes en producción (son idempotentes y solo tocan `PHF_*`).
- **Escaneo de carpetas:** se configura en `/configuracion` (fila única de `PHF_CONFIGURACION`). Los PDF van sueltos en la raíz de `articulos/`, `conceptos/` o `tarjeta/`; `procesados/` y `error/` las maneja la app y **nunca se escanean**: un archivo dejado ahí a mano no entra nunca.
- **Base `CENTRAL`** (Tango de una versión anterior, sin remitos `RP`): la lectura se adapta sola (`src/server/tango/esquema.ts`), el registro no está adaptado.
- **El historial de git se reescribió el 2026-11-03** antes del primer push a `PH_FAC`, para sacar la contraseña de SQL Server de tres commits viejos. Los hashes anteriores a esa fecha no coinciden con los de los documentos viejos. El historial original quedó en la rama local `respaldo-antes-de-limpiar` (no se sube). El repo anterior, `infosystuc-sys/factura`, quedó sin tocar.
- Hubo una instalación en `SERVIDORT\AXSQLEXPRESS` (mudanza del 2026-08-31, ver bitácora). La app volvió a `INFOSYS01` el 2026-10-25.

---

## Qué hace la app hoy

**Entrada.** PDF/JPG/PNG por carga manual (hasta 50 de a una vez) o por escaneo periódico de carpetas. Un worker en proceso (`cola.ts`) los toma, Claude extrae los campos y los renglones, y la app resuelve sola lo que puede: proveedor por CUIT, condición de compra aprendida, alícuotas e IIBB aprendidas, punto de venta de tarjeta, duplicados por hash del PDF.

**Cuatro tipos de comprobante** (`src/lib/tipoFactura.ts`):

| Tipo | Se registra como | Notas |
|---|---|---|
| `conceptos` | Factura con concepto (`CPA47`), sin renglones | Condición de compra fija "CONTADO 1 DIA" |
| `articulos` | Factura con renglones (`CPA46`) imputados a una **orden de compra** | Si la OC tiene un remito recibido, la factura lo consume (`CPA48`) |
| `tarjeta` | Liquidación, letra `A` fija, punto de venta aprendido por proveedor | El total se calcula, no se lee |
| `remito` | Movimiento de stock `RP` (`STA14`/`STA20`), entra al depósito 01, contra la OC | Mueve stock y lo pendiente de recibir |

**Estados** (`src/lib/estados.ts`): `procesando`, `leido`, `observacion`, `confirmado`, `registrado`, `existente` (ya estaba en Tango antes de importarlo), `error`. `registrado` y `existente` son terminales y de solo lectura.

**Revisión.** PDF al lado, formulario en dos columnas, tabla de renglones con la OC elegida renglón por renglón, "Vincular" y "Vincular todos" (`CPA15`), cargos del proveedor, equivalencias por talle, "Ver asiento", "Ver cuotas", "Revalidar contra Tango" (sin volver a llamar a la IA), y el panel "Listo para registrar" con los chequeos que bloquean.

**Registro en Tango** (`registrarComprobanteEn`, `src/server/tango/comprobantes.ts`), en una transacción `SERIALIZABLE` con applock: cabecera, impuestos, renglones, vínculo y contadores de la OC, consumo del remito, precio de última compra (`STA12`), cuotas (`CPA54`) y asiento (`ASIENTO_COMPROBANTE_CP`/`ASIENTO_CP`, ya contabilizado; la transferencia a Contabilidad la sigue haciendo el usuario desde Tango).

**Otras pantallas.** `/conciliacion` cruza lo cargado en Tango contra "Mis Comprobantes" de ARCA (CSV o XLSX). `/configuracion` maneja el escaneo de carpetas. La bandeja permite borrar varios comprobantes a la vez.

---

## Pendientes

**Del usuario:**
1. **Rotar la contraseña de SQL Server.** Es de 5 caracteres y estuvo en el historial de git hasta el 2026-11-03. Se pospuso. Si se rota, hay que cambiarla también en el `.env.local` de cada instalación.
2. **Confirmar que el repo `PH_FAC` en GitHub es privado.** No se pudo verificar desde acá (`gh` no está instalado).

**Abiertos, sin urgencia:**
3. **80 remitos `RP` en estado `'P'`** (28 de 2021, 6 de 2025, 46 de 2026). El consumo automático por factura (2026-11-03) corre solo para las facturas nuevas; estos no se corrigen solos. Antes de tocarlos hay que ver cuáles son pendientes de verdad.
4. **Dividir `src/server/app/acciones.ts` (~1.600 líneas) y `src/server/app/cola.ts` (~1.300).** Conviene antes de la próxima funcionalidad grande.
5. **Costo de IA por comprobante sin medir.** `extraerDePdf` ya devuelve los tokens; falta guardarlos en `PHF_COMPROBANTE` y mirar unas semanas de uso real.
6. **`CPA04.UNIDADES`** es la única columna del registro sin fórmula confirmada (hoy va `IMPORTE_TO`). Contrastar contra facturas cargadas a mano si aparece un desvío.
7. **Sin pantalla de "sin conexión a la base".** Si SQL Server cae antes de cargar la revisión, la página da 500 (la base de la app y la de Tango son la misma instancia).
8. **Registrar en `CENTRAL`.** Solo si ese Tango se va a usar en producción.
9. **Qué escribe el "pasar a contabilidad" real** (`LOTE_CN_GENERADO`/`LOTE_CN_GENERADO_COMPROBANTE`, `TRANSFERIDO_CN`). No bloquea nada hoy.
10. **`PHF_COMPROBANTE.NUMERO` tiene dos convenciones:** los de `pnpm seed` lo guardan con el punto de venta (`"0003-00018742"`), los reales por separado. La bandeja y la barra de acciones muestran `NUMERO` solo, por eso.
11. **`buscarProveedorPorCuit` (singular)** ya no tiene callers de producción, solo tests. Candidato a borrar.
12. **Selector manual de remito** en la revisión: hoy el remito que consume una factura se elige solo (el más viejo). Solo si aparecen casos que lo pidan.

---

## Decisiones del usuario que no se deducen del código

Están documentadas junto al código que las aplica: buscá "decisión del usuario" en `src/`. Las que más pesan:

- **Las facturas de artículos se imputan a la orden de compra**, no a un remito (2026-09-06). El remito entra por su lado como comprobante `remito`, y la factura lo consume cuando la OC lo tiene (2026-11-03).
- **Los importes que valen son los de la factura**, no los de la OC (2026-09-15). El precio por renglón se graba neto, con el descuento general ya prorrateado.
- **Si algo no cierra, se bloquea y se reprocesa**: no se inventa un precio, una fecha ni una condición.
- **El asiento se graba contabilizado** (`CONTABILIZADO='S'`, usuario `PHF_WEB`, fecha de la factura) (2026-08-22). La leyenda que carga el operador reemplaza la del modelo.
- **`CPA36`**: `PENDIENTE_FACTURAR_RECIBIDA` y `PENDIENTE_RECIBIR_FACTURADA` siguen la regla de Tango (la diferencia entre recibido y facturado, sin bajar de 0) desde el 2026-11-03; antes se grababa la cantidad facturada.
- **Al consumir un remito, `STA20.CANT_FACTU` no se toca**: solo baja `CANT_PEND` (2026-11-03).
- **El remito de proveedor entra siempre al depósito 01** (2026-10-25). Los cargos del proveedor van al mismo depósito que los artículos de la factura (2026-09-22).
- **La app no graba en ninguna tabla `CTA*`** (2026-11-03): si hace falta el espejo de Tango Central, lo tiene que llenar Tango.
- **El precio de última compra (`STA12`) se pisa al registrar aunque la factura sea más vieja** que la última compra que ya tiene, como hace Tango (2026-09-23).

---

## Datos de la base que costó descubrir

- **Un ingreso de factura de compra toca 11 tablas.** Ver el spec §2 y `registrarComprobanteEn`.
- **Tablas que se pueden tocar:** las de la documentación oficial de Axoft, más las excepciones que lista `CLAUDE.md`. **Ninguna `CTA*` se lee ni se escribe** (el espejo de Tango Central): decisión del usuario, 2026-11-03. Hasta esa fecha el registro grababa `CTA05`/`CTA06`/`CTA07` y `CTA_COMPROBANTE_COMPRAS_CLASIFICACION_IVA`. Tango sí las graba cuando se registra desde su pantalla (3.833 de 3.834 facturas de 2026) y ningún trigger lo hace, así que las facturas de la app quedan sin esas filas. `tests/fronteraCta.test.ts` lo protege.
- **CUIT en `CPA01` con guiones** (`23-23292431-4`). Hay 7 CUIT duplicados: la app pregunta cuál.
- **`TCOMP_IN_C` y `T_COMP` son cosas distintas**: `'FP'` (interno, 2 caracteres) contra `'FAC'` (visible, 3).
- **`CPA04.LEYENDA` es `varchar(30)`** y `ASIENTO_CP.DESC_LEYENDA` es `varchar(100)`.
- **`CPA48.NCOMP_IN_C` es `varchar(8)` alineado a la derecha con espacios** (`'   17774'`), mientras que `CPA04` y `CPA_OC_FACTURA` lo guardan como `float`.
- **`CPA14` son dos maestros en uno**: `TIPO_ALI = 'IV'` son alícuotas de IVA; `IB`/`II`/`OT` son los códigos de `CPA18`.
- **`STA20.CANT_PEND` no se deriva** de las otras columnas: hay que leerla. `STA20.PRECIO` viene en 0 en los remitos; el precio está en `PRECIO_REM`.
- **Condiciones de compra en dos niveles**: `CONDICION_COMPRA` es la cabecera y `CPA49` las cuotas. `CPA01.COND_COMPR = 0` significa "sin condición".
- **`useUTC: false` en el pool es load-bearing**: sin eso las fechas `DATE` se muestran un día antes. Hay un test que lo protege.
- **`requestTimeout` de 60 s**: un `INSERT` en `CPA04` bajo contención llegó a tardar 95 s.
- **`instrumentation.ts` tiene que estar en `src/`**: en la raíz, Next.js no lo ejecuta y no avisa. Hay un test.
- **`SEQUENCE_CPA_CONCEPTOS_PROVEEDOR` estuvo atrasada** (2026-09-04, corregida). Si un `INSERT` en una tabla de Tango da `Violation of PRIMARY KEY`, mirar la secuencia antes que el código.

---

## Documentos

- [`HISTORIAL.md`](HISTORIAL.md): la bitácora, de lo más nuevo a lo más viejo.
- `specs/2026-08-04-importador-facturas-tango-design.md`: el diseño original. Los specs y planes de cada fase están en `specs/` y `plans/`; las funcionalidades posteriores al 2026-08-26 no tienen spec propio, solo su entrada en la bitácora y los comentarios del código.
- `design/README.md`: la disposición de las pantallas.
