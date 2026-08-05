# Importador de facturas con IA → Tango — Diseño

**Fecha:** 2026-08-04
**Estado:** aprobado
**Origen:** prototipo `Importador de Facturas.dc.html` + README de handoff (Claude Design)

---

## 1. Qué se construye

Aplicación web de escritorio para cuentas a pagar. El operador importa comprobantes de compra en PDF, Claude extrae los campos, el operador revisa contra el PDF original, y el comprobante se graba en el ERP Tango Gestión.

Volumen objetivo: 20 a 100 comprobantes por día y por usuario. Eso condiciona el diseño: la revisión tiene que ser rápida, con PDF y campos visibles a la vez.

El prototipo es referencia de diseño de alta fidelidad. Se recrea, no se porta: usa un runtime propio (`<x-dc>`) que no va a producción.

---

## 2. Entorno verificado

Todo lo de esta sección fue comprobado contra el servidor, no supuesto.

| Ítem | Valor |
|---|---|
| Servidor | `INFOSYS01\AXSQLSERVER` — SQL Server 2019 Developer Edition (15.0.2000.5) |
| Credenciales | usuario `Axoft` / contraseña `<ver .env.local>` |
| Base | `PUNTO_HOGAR_1` — 3.102 tablas (Tango Gestión) |
| Node | 22.20.0 |
| .NET | 9.0.305 (no se usa) |
| sqlcmd | 15.0.2000.5 |

La PC de desarrollo tiene una copia de la misma base que producción. Se escribe directo, sin modo simulación. La migración al servidor productivo es un paso posterior fuera de este spec.

### Volumen actual de datos

| Tabla | Filas | Qué es |
|---|---|---|
| `CPA01` | 666 | Maestro de proveedores |
| `CPA04` | 25.602 | Cabecera de comprobantes de compra |
| `CPA04` (solo `T_COMP='FAC'`) | 15.625 | Facturas de compra |
| `CPA46` | 14.089 renglones de factura | Renglones de artículos de comprobantes de compra |
| `CPA06` | 0 | **Vacía en toda la base.** No se usa |
| `CTA09` | 140.915 | Cabecera de movimientos de stock (incluye remitos de proveedor) |
| `CTA11` | 332.312 | Renglones de movimientos de stock |

### Cómo se cargan hoy las facturas

| Patrón | Facturas | % |
|---|---|---|
| Solo cabecera, sin renglones de artículos | 11.977 | 77% |
| Con renglones en `CPA46` | 3.648 | 23% |

De los 14.089 renglones de factura, **13.849 (98,3%) están atados a un renglón de remito** vía `CPA48`. El stock ya se movió cuando entró el remito del proveedor; la factura solo se le asocia. Solo 240 renglones (1,7%) mueven stock desde la propia factura.

En 2026: 1.006 facturas, 270 con renglones (27%).

**Consecuencia de diseño:** la app no intenta matchear renglones del PDF contra el maestro de artículos ni mover stock. Copia renglones de un remito existente que el operador elige, o graba solo cabecera.

### Comprobante de referencia

`FAC A0011800063576`, proveedor `010246`, emitida 18/05/2026, total 484.344,26.
Claves internas: `TCOMP_IN_C = 'FP'`, `NCOMP_IN_C = 16591`, `NRO_SUCURS = 0`, `ESTADO_STK = 'R'`.

Filas que generó, por tabla:

| Tabla | Filas | Contenido |
|---|---|---|
| `CPA04` | 1 | Cabecera |
| `CPA46` | 1 | Artículo `106817`, depósito `01`, cant. 4, precio 80.745,57, neto 322.982,28, `ID_STA11 = 8775` |
| `CPA48` | 1 | Link al renglón 1 del remito `RP 00003805` |
| `CPA18` | 2 | Impuestos: `COD_IMPUES=60` → 8.074,56; `COD_IMPUES=40` → 75.771,67 |
| `CPA63` | 1 | `CLAS_SIAP='SIN'`, importe 67.826,28, alícuota 21% |
| `CPA54` | 1 | Vencimiento de cuenta corriente |
| `CTA05` | 1 | Espejo de `CPA04` |
| `CTA06` | 2 | Espejo de `CPA18` |
| `CTA07` | 1 | Espejo de `CPA46` |
| `CTA_COMPROBANTE_COMPRAS_CLASIFICACION_IVA` | 1 | Clasificación IVA |
| `ASIENTO_COMPROBANTE_CP` | 1 | Asiento contable — **fuera de alcance** |

El remito referido vive en `CTA09`: `REM R0008400341136`, `NCOMP_IN_S = 00003805`, `TCOMP_IN_S = 'RP'`, proveedor `010246`, sucursal 1001, `ESTADO_MOV = 'F'` (facturado), cargado por usuario `DRIVERO` desde terminal `COMPRASPH`.

`CTA05` / `CTA06` / `CTA07` replican fila por fila a `CPA04` / `CPA18` / `CPA46` y tienen columna `NRO_SUCURS`. La lectura es que son el espejo para consolidación entre sucursales; se confirma en fase 4 antes de escribirlas.

### Numeración interna

`NCOMP_IN_C` es una secuencia por `TCOMP_IN_C`:

| `TCOMP_IN_C` | Máximo | Filas |
|---|---|---|
| `FP` (factura de proveedor) | 16.597 | 15.623 |
| `CP` | 16.583 | 673 |
| `DP` | 15.950 | 41 |
| `OP` | 9.263 | 9.263 |
| `FS` | 997 | 2 |

No existe tabla de contadores en la base. La app calcula `MAX(NCOMP_IN_C) + 1` dentro de la transacción.

---

## 3. Decisiones

| Punto | Decisión | Motivo |
|---|---|---|
| Stack | Next.js 15 + TypeScript, App Router | Un solo proyecto y un solo comando de arranque |
| Acceso a datos | `mssql` (node-mssql), SQL explícito | Un ORM sobre 3.102 tablas legacy de Tango agrega ceremonia sin dar nada |
| Extracción | Claude API real | Devuelve valor + confianza por campo |
| API key | `.env.local`, cargada por el usuario | La key no pasa por el chat ni por git |
| Login | Sin login; usuario = usuario de Windows | Red interna. Da trazabilidad real sin infraestructura de auth |
| Alcance del INSERT | Cabecera + asociación a remito existente | Cubre el 77% + el 98% del 23% restante |
| Asiento contable | Fuera de alcance | Tango contabiliza después con su proceso normal |
| PDFs | Carpeta en disco | No infla la base ni sus backups |
| Empresa | `PUNTO_HOGAR_1` fija | Sin selector |
| Resaltado en PDF | Capa de texto de pdf.js | Coste cero por comprobante y precisión exacta. Claude no devuelve bounding boxes confiables sobre PDF |
| Proveedor sin match por CUIT | Bloquea el registro | No se escribe el maestro de proveedores del ERP |
| Consulta a ARCA para CAE | Fuera de alcance | — |

**Ubicación:** el proyecto va en `D:\APP\PH_FAC`. El prototipo se mueve a `D:\APP\PH_FAC\design\` como referencia.

---

## 4. Arquitectura

Tres capas con frontera explícita:

### `src/server/tango/`

Único módulo que toca tablas del ERP. Expone:

- **Lectura:** proveedores por CUIT y por razón social, remitos pendientes de facturar por proveedor, condiciones de compra, alícuotas de IVA, códigos de impuesto.
- **Escritura:** una sola función, `registrarComprobante(comprobanteId)`.

Ningún otro módulo emite SQL contra tablas `CPA*` / `CTA*` / `STA*`. La frontera existe para que un cambio de versión de Tango, o una migración futura a la API de Delta, se resuelva reescribiendo esta carpeta sola.

### `src/server/app/`

Las tablas propias `PHF_*`. No conoce Tango. Expone el CRUD de comprobantes, campos, renglones y auditoría.

### `src/app/`

Rutas y UI. Consume server actions, nunca SQL directo.

- `/comprobantes` — bandeja
- `/comprobantes/[id]` — revisión

---

## 5. Esquema propio

Cuatro tablas en `PUNTO_HOGAR_1`, prefijo `PHF_` para no chocar con las 3.102 existentes.

### `PHF_COMPROBANTE`

Una fila por PDF importado.

- Identidad: `ID`, `ARCHIVO_NOMBRE`, `ARCHIVO_RUTA`, `ARCHIVO_HASH`
- Estado: `ESTADO`, `MOTIVO_OBSERVACION`, `NOTA_OBSERVACION`
- Campos de negocio desnormalizados para la bandeja: `TIPO`, `PUNTO_VENTA`, `NUMERO`, `FECHA_EMISION`, `RAZON_SOCIAL`, `CUIT`, `TOTAL`, `CONFIANZA_PROMEDIO`
- Resolución: `COD_PROVEE` (el proveedor de Tango que se asoció)
- Registro: `TANGO_NCOMP_IN_C`, `TANGO_T_COMP`, `TANGO_N_COMP`, `FECHA_REGISTRO`
- Auditoría: `FECHA_ALTA`, `USUARIO_ALTA`, `FECHA_MODIF`, `USUARIO_MODIF`

`TANGO_NCOMP_IN_C` no nulo significa "ya grabado en Tango" y es la clave de la idempotencia.

### `PHF_CAMPO`

Una fila por campo extraído. Es lo que permite medir después la precisión del modelo.

`ID`, `COMPROBANTE_ID`, `CLAVE`, `VALOR_IA`, `CONFIANZA`, `VALOR_FINAL`, `CORREGIDO_POR_USUARIO`

`VALOR_FINAL` prevalece sobre `VALOR_IA`. `CORREGIDO_POR_USUARIO` se marca cuando el operador edita.

### `PHF_RENGLON`

Renglones detectados por la IA, más el link opcional al renglón de remito que el operador eligió.

`ID`, `COMPROBANTE_ID`, `ORDEN`, `CODIGO_IA`, `DESCRIPCION_IA`, `CANTIDAD_IA`, `PRECIO_UNITARIO_IA`, `IMPORTE_IA`, `REMITO_NCOMP_IN_S`, `REMITO_N_RENGL_S`

Los campos `REMITO_*` nulos significan que ese renglón no se graba en Tango.

### `PHF_AUDITORIA`

`ID`, `COMPROBANTE_ID`, `FECHA`, `TEXTO`, `USUARIO`

Una fila por transición de estado. `USUARIO` es `'Sistema'` para las entradas automáticas.

---

## 6. Modelo de estados

| Estado | Label en UI | Significado | Transiciones |
|---|---|---|---|
| `procesando` | Procesando IA | PDF subido, extracción en curso | → `leido`, → `error` |
| `leido` | Pendiente de revisión | IA terminó, espera revisión | → `confirmado`, → `observacion` |
| `observacion` | En observación | Bloqueado por un motivo | → `confirmado`, → `observacion` |
| `confirmado` | Confirmado | Validado, listo para grabar | → `registrado` |
| `registrado` | Registrado en Tango | Grabado en el ERP. **Terminal** | ninguna |
| `error` | Error de lectura | PDF ilegible o extracción fallida | → `leido`, → borrado |

Reglas:

- `registrado` es terminal e inmutable.
- Solo `confirmado` habilita "Registrar en Tango".
- `observacion` requiere motivo de una lista cerrada de cinco, y admite nota libre.
- Cada transición escribe una fila en `PHF_AUDITORIA`.

---

## 7. Extracción con Claude

Al subir el PDF: se guarda en disco, se crea el `PHF_COMPROBANTE` en estado `procesando`, y se encola la extracción.

El request manda el PDF como documento y pide salida estructurada con, por cada campo: valor y confianza (0 a 1). También pide los renglones detectados.

Campos a extraer, agrupados como en la UI:

- **Comprobante:** tipo, punto de venta, número, fecha de emisión, CAE, vencimiento del CAE, moneda, cotización, orden de compra
- **Proveedor:** razón social, CUIT, condición IVA, condición de pago, vencimiento
- **Importes:** neto gravado 21%, IVA 21%, IVA 10,5%, no gravado / exento, percepción IVA, percepción IIBB, total
- **Renglones:** código, descripción, cantidad, precio unitario, importe

El resultado se escribe en `PHF_CAMPO` y `PHF_RENGLON`, se desnormalizan los campos de bandeja en `PHF_COMPROBANTE`, y el estado pasa a `leido`. Si falla, pasa a `error` con el mensaje.

**Reprocesar** vuelve el estado a `procesando` y descarta las correcciones manuales. La UI lo advierte antes.

### Resaltado en el PDF

Al enfocar un input, se busca el `VALOR_FINAL` de ese campo dentro de la capa de texto del PDF (pdf.js) y se resalta la coincidencia. Al desenfocar se apaga.

Si el PDF no tiene capa de texto (escaneado), el campo no resalta. No es un error: la app funciona igual.

---

## 8. Validaciones

Las cuatro se resuelven server-side y se recalculan al abrir la revisión y antes de confirmar.

1. **Proveedor existe en Tango** — match exacto por CUIT contra `CPA01.N_CUIT`. Sin coincidencia: **error bloqueante**, y la UI ofrece un buscador por razón social para asociarlo a mano. Si el proveedor no existe, hay que darlo de alta en Tango.
2. **Sin duplicados** — no existe otra factura del mismo proveedor con el mismo `T_COMP` + `N_COMP`, ni en `CPA04` ni en `PHF_COMPROBANTE`. **Error bloqueante.**
3. **Totales cuadran** — neto + IVAs + percepciones = total leído. **Advertencia** con la diferencia exacta.
4. **CAE** — formato válido y no vencido. **Advertencia.** Sin consulta a ARCA.

"Confirmar datos" se bloquea si hay alguna validación en error.

---

## 9. Registro en Tango

Una transacción `SERIALIZABLE`. El número interno se protege con `sp_getapplock` sobre un recurso propio.

1. Verificar idempotencia: si `PHF_COMPROBANTE.TANGO_NCOMP_IN_C` no es nulo, devolver el registro existente sin insertar nada.
2. `NCOMP_IN_C = MAX(NCOMP_IN_C) + 1` sobre `CPA04` para `TCOMP_IN_C = 'FP'`.
3. `INSERT CPA04` (cabecera) + `INSERT CTA05` (espejo).
4. `INSERT CPA18` (percepciones) + `INSERT CTA06` (espejo).
5. `INSERT CPA63` (alícuotas de IVA) + `INSERT CTA_COMPROBANTE_COMPRAS_CLASIFICACION_IVA`.
6. `INSERT CPA54` (vencimientos), derivados de la condición de compra del proveedor.
7. **Solo si hay remito asociado:** `INSERT CPA46` (renglones copiados del remito) + `INSERT CTA07` (espejo) + `INSERT CPA48` (link factura↔remito) + `UPDATE CTA11.FALTA_REM` y `UPDATE CTA09.ESTADO_MOV`.
8. `CONTABILIZ = 0`. No se escribe `ASIENTO_COMPROBANTE_CP`.
9. Escribir `TANGO_NCOMP_IN_C` en `PHF_COMPROBANTE`, estado `registrado`, y la entrada de auditoría.

Si cualquier paso falla, `ROLLBACK` completo y el estado **no** cambia. El error se muestra en la UI.

Cada `INSERT` replica el patrón de columnas de la factura de referencia (`NCOMP_IN_C = 16591`), no una interpretación de la documentación de Tango.

### Asociación de remitos

En la pantalla de revisión, si el proveedor resuelto tiene remitos pendientes de facturar, la app los lista con sus renglones. El operador tilda cuáles corresponden a esta factura. Los renglones de `PHF_RENGLON` que quedan sin remito no se graban en Tango.

Un remito pendiente es una cabecera en `CTA09` con `TCOMP_IN_S = 'RP'` del proveedor, cuyos renglones en `CTA11` tienen cantidad no facturada.

---

## 10. UI

Se recrea el prototipo fielmente. El README de handoff (`design/README.md`) es la fuente de verdad de colores, tipografía, espaciado y copy — no las capturas, que se tomaron en un viewport angosto.

Puntos que valen la pena repetir acá:

- **Tipografía:** IBM Plex Sans para UI, IBM Plex Mono para todo dato que el operador coteja contra el PDF (importes, CUIT, CAE, números, fechas, timestamps). Se sirven self-hosted, no desde Google Fonts: la app corre en red interna.
- **Bandeja:** título + importar, 4 KPIs, tabs de filtro + buscador, tabla, pie. Búsqueda server-side con debounce de 250 ms sobre proveedor + CUIT + número.
- **Revisión:** grid de dos paneles con scroll independiente. Izquierda el PDF, derecha el formulario en 4 grupos. Los headers y la barra de acciones nunca scrollean.
- **Indicador de conexión** en el header: refleja el estado real de la conexión a SQL Server. Si está caída, bloquea "Registrar en Tango".
- **Autosave** con debounce al editar un campo, marcando `CORREGIDO_POR_USUARIO`.
- **Atajos:** `Ctrl+Enter` confirmar, `Ctrl+O` observación, `J`/`K` comprobante anterior/siguiente. Con 100 comprobantes por día valen mucho.
- **Diseñado para ≥1280px.** Sin diseño mobile.

---

## 11. Testing

- **Vitest** para el mapeo de campos extraídos → columnas de Tango, y para las cuatro validaciones. Son funciones puras sobre datos de entrada conocidos.
- **Un test de integración** que corre el registro completo contra la base real dentro de una transacción con `ROLLBACK` forzado, y verifica que se insertaron las filas esperadas en cada tabla. Es la única forma honesta de saber que el INSERT está bien armado.

---

## 12. Fases

1. Proyecto Next.js + esquema `PHF_*` + capa de lectura de Tango + bandeja funcionando contra la base.
2. Importación de PDFs + extracción con Claude + pantalla de revisión con resaltado.
3. Validaciones + observación + confirmación + auditoría.
4. Registro en Tango + asociación de remitos.

---

## 13. Riesgos asentados

- **`NCOMP_IN_C` por MAX+1.** Correcto mientras la app sea el único proceso grabando en ese instante. Si alguien carga desde Tango en simultáneo, el `sp_getapplock` no lo cubre: Tango no lo respeta. El riesgo real es bajo (una colisión requiere concurrencia en el mismo segundo) pero existe, y la consecuencia sería un número interno duplicado.
- **Códigos de percepción.** La factura de referencia usa `COD_IMPUES` 40 y 60. Hay que identificar qué son antes de mapearlos; se resuelve leyendo la tabla de impuestos de Tango durante la fase 4.
- **`NRO_SUCURS`.** Vale 0 en `CPA04` pero 1001 en el remito asociado. Se replica el patrón de la factura de referencia; si aparece inconsistencia, se resuelve en fase 4.
- **Escritura directa sobre tablas del ERP.** Es la decisión tomada y el entorno es de desarrollo, pero cada versión nueva de Tango puede cambiar el esquema. La frontera de `src/server/tango/` existe para acotar el costo de ese día.

---

## 14. Fuera de alcance

- Asiento contable (`ASIENTO_COMPROBANTE_CP`) y contabilización.
- Renglones de artículos sin remito, y movimiento de stock desde la factura.
- Alta de proveedores desde la app.
- Consulta a ARCA para validar CAE.
- Selector de empresa o de sucursal.
- Buzón de email o portal de proveedores como origen de PDFs.
- Segundo aprobador entre `confirmado` y `registrado`.
- Diseño mobile.
- Despliegue en el servidor de producción.
