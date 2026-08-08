# Fase 4 — Registro en Tango y asociación de remitos

**Fecha:** 2026-08-08
**Estado:** aprobado, pendiente de plan de implementación
**Depende de:** `2026-08-04-importador-facturas-tango-design.md` (diseño general, especialmente §2 y §9), `2026-08-07-fase3-validaciones-observacion-toasts-design.md`, Fase 3 integrada en `master`

---

## 1. Qué se construye

El registro real de un comprobante `confirmado` en Tango Gestión (ERP real, escritura directa contra SQL Server), más la asociación de remitos pendientes de facturar cuando la factura tiene renglones. Es la última pieza del circuito: **importar → extraer con IA → revisar → confirmar → registrar en Tango**.

Al terminar la fase, un comprobante puede llegar a `registrado`: grabado en Tango con la confianza de que las cuatro validaciones de Fase 3 pasaron, que la imputación (proveedor, condición de compra, percepciones) está completa y no vacía por default silencioso, y que si tenía renglones, quedaron asociados al remito correcto o deliberadamente sin asociar.

No se separa en dos fases (cabecera por un lado, remitos por otro) — se mantiene como un solo bloque, igual que lo definía el diseño general, para no dejar un estado intermedio donde la app registra en Tango pero ignora el 23% de facturas que sí tienen remito.

---

## 2. Decisiones

| Punto | Decisión | Motivo |
|---|---|---|
| Alcance de la fase | Cabecera + remitos en un solo bloque | Evita un estado intermedio donde el 23% de facturas con renglones queda sin cubrir |
| Percepción IIBB | Campo nuevo `codpercibb` (select), poblado con `listarCodigosImpuesto()` filtrado a tipo `IB` | Punto Hogar recibe facturas de varias jurisdicciones — un código fijo se rompería en silencio con la primera factura de otra provincia |
| Impuesto interno | Código fijo (40, tipo `II`, el mismo de la factura de referencia) | En la práctica siempre es el mismo para las facturas que le llegan a Punto Hogar |
| `condcompra` vacío | Bloquea "Registrar en Tango" | Los vencimientos de `CPA54` se derivan de la condición de compra — un default silencioso desde `CPA01.COND_COMPR` (0 en 640 de 666 proveedores, "sin condición") generaría vencimientos mal calculados sin ningún aviso |
| `codpercibb` vacío con `perciibb` cargado | Bloquea "Registrar en Tango" | Mismo criterio que `condcompra`: no se inserta una fila de `CPA18` con un código adivinado |
| Formato de `N_COMP` al escribir | Nueva validación bloqueante: punto de venta ≤5 dígitos, número ≤8 dígitos | La revisión final de Fase 3 encontró una fila real (`A1326200252367`) que no calza con el formato `letra + ptovta(5) + nro(8)` que usa el chequeo de duplicados — sin esta validación, un valor mal leído se escribiría truncado en Tango sin aviso |
| Asociación de remitos | Vive en la pantalla de revisión normal, junto a Renglones | Es parte de revisar el comprobante, no un paso separado al registrar — mismo criterio que las validaciones de Fase 3 |
| "Ver asiento en Tango" | Queda deshabilitado en esta fase | Tango genera el asiento contable (`ASIENTO_COMPROBANTE_CP`) por su propio proceso; la app no lo toca ni lo muestra — coincide con "fuera de alcance" del spec general §14 |
| Indicador de conexión (ya existe desde Fase 1, `header-global.tsx`) | Si está caído, deshabilita "Registrar en Tango" | Recién se cablea a esa acción en esta fase — antes no había ninguna escritura a Tango que proteger |
| Correcciones al spec general | §9 paso 7: `UPDATE STA20.CANT_FACTU/CANT_PEND` + `STA14.ESTADO_MOV`, no `CTA11.FALTA_REM`/`CTA09.ESTADO_MOV`. §266: remito pendiente se define sobre `STA14`, no `CTA09` | El código de lectura (`remitos.ts`, Fase 1) ya usa las tablas correctas — es el texto del spec el que quedó desactualizado |
| `NCOMP_IN_C` por `MAX+1` + `sp_getapplock` | Se mantiene tal cual lo definía el spec general | El riesgo (colisión si Tango escribe en simultáneo) ya está asentado y aceptado ahí — no se revisita en esta fase |
| Migración de base | Ninguna nueva | `PHF_CAMPO` es clave/valor genérico — `codpercibb` es una fila más del catálogo, mismo mecanismo que `condcompra` en Fase 3. `PHF_RENGLON.REMITO_NCOMP_IN_S`/`REMITO_N_RENGL_S` ya existen desde Fase 1, sin usar hasta ahora |

---

## 3. Arquitectura

Respeta la frontera ya establecida. Piezas nuevas o extendidas:

- **`src/server/tango/comprobantes.ts`** (ya existe desde Fase 3, ahí vive la lectura de duplicados) — se le agrega la única función de escritura de esta fase: `registrarComprobante(comprobanteId): Promise<{ ncompInC: number; tComp: string; nComp: string }>`. Es la única función de todo el proyecto que hace `INSERT`/`UPDATE` contra tablas del ERP.
- **`src/server/app/validaciones.ts`** — se le agrega una segunda función de orquestación, `validarListoParaRegistrar`, con las validaciones nuevas de esta fase (condición de compra elegida, código de percepción IIBB si corresponde, formato de N_COMP). No se mezcla con `validarComprobante` de Fase 3 — son gates de transiciones distintas (`leido→confirmado` vs. `confirmado→registrado`).
- **`src/server/app/acciones.ts`** — se agrega `asignarRemito(renglonId, remitoNcompInS, remitoNRenglS)` (o `null` para desasignar) y `registrarComprobante(id)` (wrapper de server action sobre la función de `src/server/tango/`).
- **`src/lib/validaciones.ts`** — se agregan las reglas puras de formato de N_COMP y de las dos validaciones nuevas, mismo patrón que las cuatro de Fase 3.
- **`src/lib/campos.ts`** — nuevo campo `codpercibb` (tipo `select`, grupo `importes`, junto a `perciibb`).
- **`src/components/revision/`** — panel nuevo "Listo para registrar" (mismo shell visual que el panel de validaciones de Fase 3), sección nueva "Remitos pendientes" junto a Renglones, y el botón "Registrar en Tango" pasa de deshabilitado a funcional en `barra-acciones.tsx`.

---

## 4. El registro en Tango — la transacción

**Trigger:** botón "Registrar en Tango", visible solo en estado `confirmado`. Habilitado solo si el indicador de conexión está en verde y el panel "Listo para registrar" no tiene ningún ítem bloqueante.

**La transacción**, dentro de `registrarComprobante`:

1. `conTransaccion(fn, sql.ISOLATION_LEVEL.SERIALIZABLE)` + `sp_getapplock` sobre un recurso propio (ej. `'PHF_registro_tango'`).
2. Idempotencia: `SELECT TANGO_NCOMP_IN_C FROM PHF_COMPROBANTE WHERE ID=@id`. Si no es null, devolver el registro existente sin insertar nada más — cubre doble click y reintento tras un error de red ya commiteado.
3. Re-chequeo defensivo dentro de la transacción: `codprovee` sigue existiendo en `CPA01`, y las cuatro validaciones bloqueantes de Fase 3 siguen en ok. `SERIALIZABLE` protege contra otra transacción de esta misma app corriendo en simultáneo, pero no contra que alguien haya tocado `CPA01` desde Tango directamente entre la confirmación y el registro.
4. `NCOMP_IN_C = MAX(NCOMP_IN_C) + 1` sobre `CPA04` para `TCOMP_IN_C = 'FP'`.
5. `INSERT CPA04` (cabecera) + `INSERT CTA05` (espejo).
6. `INSERT CPA18` (percepciones) + `INSERT CTA06` (espejo): una fila para `perciibb` (código = `codpercibb`) si `perciibb` tiene valor, una fila para `impint` (código fijo 40) si `impint` tiene valor. Ninguna de las dos es obligatoria — no todas las facturas tienen percepciones.
7. `INSERT CPA63` (alícuotas de IVA) + `INSERT CTA_COMPROBANTE_COMPRAS_CLASIFICACION_IVA`, una fila por cada par `porcivaN`/`impivaN` con valor (hasta 5).
8. `INSERT CPA54` (vencimientos), derivados de la `condcompra` elegida por el operador.
9. **Solo si hay renglones con remito asignado:** por cada `PHF_RENGLON` con `REMITO_NCOMP_IN_S`/`REMITO_N_RENGL_S` no nulos, `INSERT CPA46` (copiando código de artículo, depósito y precio **del renglón de remito**, no de lo que leyó la IA) + `INSERT CTA07` (espejo) + `INSERT CPA48` (link factura↔remito) + `UPDATE STA20.CANT_FACTU/CANT_PEND` + `UPDATE STA14.ESTADO_MOV` si el remito queda completamente facturado.
10. `CONTABILIZ = 0`. No se escribe `ASIENTO_COMPROBANTE_CP`.
11. `UPDATE PHF_COMPROBANTE` con `TANGO_NCOMP_IN_C`/`TANGO_T_COMP`/`TANGO_N_COMP`/`FECHA_REGISTRO`, `ESTADO = 'registrado'`, más la entrada de auditoría "Registrado en Tango: {tComp} {nComp}".

Si cualquier paso falla: rollback completo, el estado no cambia, toast de error con el mensaje — mismo patrón que confirmar/observación de Fase 3. El operador puede reintentar; el paso 2 asegura que un reintento después de un fallo real (nada commiteado) simplemente vuelve a intentar desde cero.

Cada `INSERT` replica el patrón de columnas de la factura de referencia (`NCOMP_IN_C = 16591`, spec general §2), no una interpretación de la documentación de Tango — mismo criterio que ya usó el spec general.

---

## 5. Asociación de remitos

**Dónde:** sección nueva "Remitos pendientes" en la pantalla de revisión, junto a Renglones. Visible solo cuando el proveedor está resuelto y hay al menos un renglón extraído por la IA (23% de los casos).

**Cómo:** por cada `PHF_RENGLON`, un select que lista los renglones pendientes de todos los remitos del proveedor (`buscarRemitosPendientes`, ya existe desde Fase 1), agrupados por remito. El operador elige a cuál corresponde el renglón de la factura, o lo deja sin asignar. `asignarRemito` guarda `REMITO_NCOMP_IN_S`/`REMITO_N_RENGL_S` — mismo patrón de click deliberado + `router.refresh()` que `elegirProveedor` de Fase 3, no autosave de tecleo. Un renglón de remito ya asignado a otro renglón de la misma factura no vuelve a aparecer en la lista de opciones.

Los renglones de `PHF_RENGLON` sin remito asignado no se graban en Tango — quedan como dato de la app, visible en la pantalla, pero invisibles para el `INSERT CPA46`.

**Fuera de alcance:** dividir un renglón de factura entre dos remitos, o matching automático por código de artículo — el operador siempre elige a mano, como ya decía el spec general.

---

## 6. Validaciones adicionales antes de registrar

Panel nuevo "Listo para registrar", visible solo en estado `confirmado`, con el mismo shell visual que el panel de validaciones de Fase 3 (línea 138 de `design/README.md`):

1. **Condición de compra elegida** (bloqueante). `condcompra` no puede estar vacío.
2. **Código de percepción IIBB** (bloqueante, condicional). Si `perciibb` tiene un valor no nulo, `codpercibb` no puede estar vacío. Si `perciibb` está vacío, esta validación no aplica.
3. **Formato de N_COMP** (bloqueante). `ptovta` ≤5 dígitos y `nro` ≤8 dígitos — mismo formato que ya usa el chequeo de duplicados de Fase 3 (`nComp()` en `src/lib/validaciones.ts`), reusado acá para validar antes de escribir en vez de solo para comparar.

Las cuatro validaciones de Fase 3 (proveedor, duplicados, totales, CAE) no se repiten en este panel — ya bloquearon la transición a `confirmado`, y se vuelven a chequear server-side dentro de la propia transacción de registro (paso 3 de la sección 4).

---

## 7. Testing

- `tests/lib/validaciones.test.ts` (extiende el de Fase 3) — las 3 reglas nuevas como funciones puras: formato de N_COMP válido/inválido, condición de compra vacía, percepción IIBB sin código.
- `tests/server/tango/comprobantes.test.ts` (ya existe desde Fase 3) — el test central: `registrarComprobante` contra la base real dentro de `conRollback`, verificando que se insertó la fila esperada en cada tabla tocada (`CPA04`, `CTA05`, `CPA18`, `CTA06`, `CPA63`, `CPA54`, y si corresponde `CPA46`/`CTA07`/`CPA48`), usando como referencia la factura de ejemplo del spec general.
- Mismo archivo: test de idempotencia — llamar `registrarComprobante` dos veces sobre el mismo comprobante no duplica nada, la segunda devuelve el mismo `TANGO_NCOMP_IN_C`.
- Test de remitos: asignar un renglón a un remito real con `CANT_PEND` conocido, registrar, verificar que `STA20.CANT_FACTU`/`CANT_PEND` y `STA14.ESTADO_MOV` cambiaron como corresponde.
- Panel "Listo para registrar", sección de remitos, e indicador de conexión bloqueando el botón: verificación manual en navegador — sin infraestructura de test de componentes en el proyecto, mismo criterio que el resto de la app.

---

## 8. Fuera de alcance

Heredado del spec general, sin cambios: asiento contable y contabilización (`ASIENTO_COMPROBANTE_CP`), alta de proveedores desde la app, consulta a ARCA para validar CAE, selector de empresa o sucursal, segundo aprobador entre `confirmado` y `registrado`, diseño mobile, despliegue en el servidor de producción.

Específico de esta fase: dividir un renglón de factura entre remitos, matching automático de artículos por código, y cualquier funcionalidad detrás de "Ver asiento en Tango" — el botón queda deshabilitado, para una fase futura sin fecha definida.
