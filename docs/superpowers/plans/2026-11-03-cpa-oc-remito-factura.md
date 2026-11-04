# Vínculo OC ↔ remito ↔ factura como lo graba Tango (`CPA_OC_REMITO_FACTURA`)

**Fecha:** 2026-11-03. **Estado:** las dos etapas se aprobaron y se hicieron el 2026-11-04 (ver `HISTORIAL.md`).

**Origen:** el usuario cargó en Tango un caso de referencia y pasó la captura: la OC `0000100001701`, el remito `RP 00004209` y la factura `FP 17774` del proveedor `010000`. Pidió replicar cómo graba Tango la relación entre las tres. Todo lo de abajo sale de consultas de solo lectura sobre `PUNTO_HOGAR_1`.

---

## 1. El caso de referencia

OC `0000100001701` (talonario 20), dos renglones. Remito `00004209` (1 unidad por renglón). Factura `17774`: 1 unidad en el renglón 1 y **2** en el renglón 2, o sea una unidad más de la que entró por remito.

| Tabla | Qué guarda | Filas del caso |
|---|---|---|
| `CPA_OC_REMITO` | renglón de OC ↔ renglón de remito | 2 (las grabó el remito) |
| `CPA_OC_FACTURA` | renglón de OC ↔ renglón de factura | 2: cantidad 1 y **2** |
| `CPA48` | renglón de factura ↔ renglón de remito | 2: cantidad 1 y **1** (`NCOMP_IN_C = '   17774'`) |
| **`CPA_OC_REMITO_FACTURA`** | **las tres puntas juntas**: renglón de OC + renglón de factura + renglón de remito | 2: cantidad 1 y **1** |
| `CPA46` | renglones de la factura | renglón 2: `CANTIDAD = 2`, **`FALTA_REM = 1`** |
| `STA20` / `STA14` | remito | `CANT_PEND = 0` en los dos renglones, `CANT_FACTU = 0`, `ESTADO_MOV = 'F'` |

`CPA_OC_REMITO` no cambia al facturar: `CANT_DEV` y `CANTIDAD_2` quedan en 0.

## 2. Lo que la app ya hace igual que Tango

Desde el 2026-11-03 (`src/server/tango/remitosFactura.ts`), la factura de artículos contra una OC con remito recibido:

- inserta `CPA_OC_FACTURA` (ya lo hacía desde 2026-09-06);
- inserta `CPA48`, con `NCOMP_IN_C` en 8 caracteres alineado a la derecha;
- baja `STA20.CANT_PEND` sin tocar `CANT_FACTU` y pasa `STA14.ESTADO_MOV` a `'F'`;
- graba `CPA46.FALTA_REM` = lo que ningún remito cubrió.

Coincide con el caso de referencia en todo, **salvo en `CPA_OC_REMITO_FACTURA`: la app no la graba.**

## 3. `CPA_OC_REMITO_FACTURA`: estructura y reglas

**Documentación:** figura en [Tablas de Compras de Axoft](https://ayudas.axoft.com/21ar/documentos/operacion/tablas_oper/tablascompras_oper/) como "Relación orden de compra guía de despacho - factura". No es una excepción a la regla de `CLAUDE.md`.

**Estructura:**

| Columna | Tipo | Valor |
|---|---|---|
| `ID_CPA_OC_REMITO_FACTURA` | int IDENTITY | no se especifica |
| `CANTIDAD` | DECIMAL_TG | ver regla 3 |
| `CANTIDAD_2` | DECIMAL_TG | 0 (en las 10.249 filas) |
| `TALONARIO_OC`, `N_ORDEN_CO`, `N_RENGL_OC` | ENTERO_TG, varchar(14), T_D_RENGLON | los mismos del `CPA_OC_FACTURA` de ese renglón |
| `TCOMP_IN_C`, `NCOMP_IN_C`, `N_RENGL_C` | varchar(2), **ENTEROXL_TG** (número, no texto), T_D_RENGLON | la factura. `NCOMP_IN_C` va como número, como en `CPA04`, y **no** con el relleno de 8 caracteres de `CPA48` |
| `TCOMP_IN_S`, `NCOMP_IN_S`, `N_RENGL_S` | varchar(2), varchar(8), T_D_RENGLON | el remito (`'RP'`) |

Tiene índice único sobre las nueve columnas de clave (OC + remito + factura). No tiene triggers ni claves foráneas, así que nada la completa sola.

**Reglas, medidas sobre las 10.248 filas `FP`/`RP` reales (2021–2026):**

1. **Una fila por cada fila de `CPA48` cuyo renglón de factura está imputado a una OC.** Las 10.248 tienen su `CPA48` (0 sin par). Al revés, de todos los `CPA48` con OC de la historia solo 3 no tienen fila (uno por año entre 2021 y 2023). Si un renglón de factura cubre dos remitos, lleva dos filas (40 casos).
2. **La OC es la del vínculo de la factura y la del remito.** Coincide con `CPA_OC_FACTURA` y con `CPA_OC_REMITO` en todas las filas menos 4 y 6, respectivamente, todas de 2022 o antes. Por ejemplo, la factura 7394 apunta a un renglón de OC que el remito `00001688` no tiene en `CPA_OC_REMITO`.
3. **`CANTIDAD` = la cantidad del `CPA48`, salvo que supere lo imputado a la OC.** Es igual en 10.228 filas. En las otras 14, el remito y la factura traían más de lo pedido (por ejemplo, 24 contra 20 de la OC), y la fila lleva solo lo imputado: el `CPA_OC_FACTURA.CANTIDAD`, que a su vez es igual a `CPA_OC_REMITO.CANT_OC`. En la app ese caso no se da, porque la factura se imputa a la OC por la cantidad facturada y el reparto entre remitos (`repartirEntreRemitos`) no pasa de ella. De todos modos, conviene grabar `min(parte del remito, imputado a la OC que falta asignar)`.

## 4. Hallazgo: Tango también relaciona al revés, y ahí la app grabó mal `FALTA_REM`

Cuando el remito entra en Tango **después** de una factura ya registrada, Tango lo relaciona con ella: escribe `CPA48` y `CPA_OC_REMITO_FACTURA`, deja el remito en `'F'` con `CANT_PEND = 0` y **le resta lo recibido al `CPA46.FALTA_REM` de la factura**.

Eso les pasó a facturas que grabó la app en septiembre y octubre. Por ejemplo, la `17537` se registró el 15/09 y su remito `00004134` entró el 17/09. La app había grabado `FALTA_REM = 0` (antes del 2026-11-03 no lo calculaba), así que Tango lo dejó en **−35**.

La regla de Tango, `FALTA_REM = CANTIDAD − Σ CPA48.CANTIDAD del renglón`, medida en renglones de facturas de 2026 con OC:

| Origen | Cumplen | No cumplen | `FALTA_REM` negativo |
|---|---|---|---|
| Tango | 1.508 | 0 | 12 |
| App | 0 | 146 | 108 (24 facturas) |

Además, hay 38 renglones de 9 facturas de la app que siguen con `FALTA_REM = 0` y sin remito: cuando entre su remito, Tango los va a dejar negativos.

Desde el 2026-11-03 la app graba bien `FALTA_REM` en las facturas nuevas. Lo que queda mal son esos **146 renglones históricos grabados por la app**. Corregirlos entra en el alcance, porque son datos que grabó la app, pero es una corrección sobre `CPA46` y la decide el usuario.

## 5. Plan

### Etapa 1 — Grabar `CPA_OC_REMITO_FACTURA` al consumir un remito (el pedido)

1. **`consumirRemitosEn`** (`src/server/tango/remitosFactura.ts`): por cada parte, después del `INSERT` en `CPA48`, insertar en `CPA_OC_REMITO_FACTURA`:
   - `TALONARIO_OC`, `N_ORDEN_CO`, `N_RENGL_OC`: los mismos que se acaban de grabar en `CPA_OC_FACTURA`. Hay que pasarlos como parámetros nuevos de la función; hoy solo recibe la factura y las partes.
   - `TCOMP_IN_C`, `NCOMP_IN_C` como número (`sql.Float`, igual que en `CPA_OC_FACTURA`) y `N_RENGL_C`.
   - `TCOMP_IN_S = 'RP'`, `NCOMP_IN_S`, `N_RENGL_S` de la parte.
   - `CANTIDAD = min(parte.cantidad, imputado a la OC que falta asignar)`, `CANTIDAD_2 = 0`.
2. **`registrarComprobanteEn`** (`src/server/tango/comprobantes.ts`, línea ~736): pasarle a `consumirRemitosEn` la OC del renglón y la cantidad imputada.
3. **Tests**, dentro de `conRollback` y contra una línea de base:
   - `tests/server/tango/remitosFactura.test.ts`: una fila por parte, con la OC y la cantidad correctas, y `NCOMP_IN_C` numérico; dos remitos para un renglón generan dos filas.
   - `tests/server/tango/comprobantes.test.ts`: el registro de punta a punta reproduce el caso de referencia (renglón con 2 facturados y 1 recibido: `CPA48` = 1, `CPA_OC_REMITO_FACTURA` = 1, `FALTA_REM` = 1); sin remito, no graba ninguna fila.
4. **Documentación**: en `CLAUDE.md`, sumar `CPA_OC_REMITO_FACTURA` a la nota del 2026-11-03 de la factura contra remito; el comentario de cabecera de `remitosFactura.ts`; `RETOMAR.md` y `HISTORIAL.md`.

Riesgo bajo: es un `INSERT` más dentro de la transacción del registro, que ya es `SERIALIZABLE` con applock. El índice único garantiza que una doble grabación falle en lugar de duplicar.

### Etapa 2 — Corregir el `FALTA_REM` de las facturas que grabó la app (requiere decisión del usuario)

1. Script `scripts/corregir-falta-rem.ts`, con el estilo de `backfill-precios-compra.ts`. Por defecto **muestra** y no graba; graba solo con `--aplicar`.
2. Alcance: los renglones de `CPA46` de comprobantes en `PHF_COMPROBANTE` con `ESTADO = 'registrado'` (solo lo que grabó la app) e imputados a una OC, donde `FALTA_REM ≠ CANTIDAD − Σ CPA48.CANTIDAD`. Hoy son 146 renglones.
3. Fija `FALTA_REM = CANTIDAD − Σ CPA48.CANTIDAD`: los negativos vuelven a 0 o al saldo real, y los 38 que siguen esperando remito pasan a su cantidad, para que el remito que llegue después los deje en 0.
4. Una transacción, con un listado previo de factura, renglón, valor anterior y valor nuevo.

### Fuera de este plan

- Las 3 filas de `CPA48` sin `CPA_OC_REMITO_FACTURA` y las 10 que no coinciden con la OC (2021–2023) son datos de Tango: no se tocan (decisión del usuario, 2026-11-03).
- El selector manual de remito sigue pendiente (punto 12 de `RETOMAR.md`).

## 6. Decisiones para el usuario

1. **¿Se implementa la Etapa 1?** Es lo que se pidió. Agrega `CPA_OC_REMITO_FACTURA` a las tablas en las que escribe la app.
2. **¿Se corrigen los 146 renglones de la Etapa 2?** Son facturas que grabó la app, pero el cambio toca `CPA46` de comprobantes ya registrados.
