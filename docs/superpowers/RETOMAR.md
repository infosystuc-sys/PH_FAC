# Estado del proyecto

**Última actualización:** 2026-08-05 (capa de lectura de Tango completa; spec de la Fase 2 escrito)
**Rama:** `master` (ojo: se llama `master`, no `main` — `git init` la creó así)

---

## Fase 1: completa e integrada

Las 8 tareas de la Fase 1 están terminadas, revisadas e integradas a `master` en el merge `3d56303`. Con las cuatro lecturas de Tango que faltaban, **88 tests en verde.**

Lo que quedó funcionando:

- Proyecto Next.js 15 + TypeScript con los design tokens del prototipo, fuentes IBM Plex self-hosted.
- Conexión a `INFOSYS01\AXSQLSERVER`, base `PUNTO_HOGAR_1`, con pool y helpers de transacción.
- Cuatro tablas propias `PHF_COMPROBANTE`, `PHF_CAMPO`, `PHF_RENGLON`, `PHF_AUDITORIA`, creadas por una migración idempotente y atómica.
- Lectura del maestro de proveedores de Tango (`CPA01`).
- Bandeja de comprobantes en `/comprobantes`: KPIs, tabs de filtro, buscador con debounce, tabla y paginación.

Para verificar que todo sigue en pie:

```bash
cd /d/APP/PH_FAC && git status --short && pnpm test
```

---

## Lo que sigue

**Fase 2** — importación de PDFs, extracción con Claude, pantalla de revisión con resaltado por capa de texto de pdf.js.
**Fase 3** — las cuatro validaciones, modal de observación, confirmación, auditoría, toasts, atajos de teclado.
**Fase 4** — registro en Tango y asociación de remitos.

Cada fase lleva su propio plan. El diseño completo está en `docs/superpowers/specs/2026-08-04-importador-facturas-tango-design.md`.

**La Fase 2 ya tiene su spec propio:** `docs/superpowers/specs/2026-08-05-fase2-importacion-extraccion-revision-design.md`. Ojo con dos cosas que salieron de ahí: el alcance de la fase se amplió para incluir confirmar y auditoría (sin eso no se puede probar con el operador), y **hay que agregar cuatro columnas a `PHF_COMPROBANTE` y enseñarle a la migración a agregar columnas**, que hoy solo sabe crear tablas y reparar índices.

La API key de Anthropic ya está cargada en `ANTHROPIC_API_KEY`, en `D:\APP\PH_FAC\.env.local` (verificado el 2026-08-04). La Fase 2 no tiene bloqueos.

---

## Tres cosas que hay que arrastrar a las fases siguientes

Salieron de la revisión final de la Fase 1 y no están resueltas. Anotarlas acá es la única forma de que no se pierdan.

### 1. Siete CUIT duplicados en `CPA01`, uno de ellos en cuatro filas

Verificado contra la base. `buscarProveedorPorCuit` ya es determinístico —ordena por `COD_PROVEE`— así que hoy no hay comportamiento aleatorio. Pero elegir "el primero" sigue siendo una decisión arbitraria.

La resolución real es de la **Fase 3**: cuando el CUIT matchea más de un proveedor, la app tiene que mostrarle las coincidencias al operador para que elija. Si no se hace, la Fase 4 termina imputando una factura a la cuenta corriente del proveedor equivocado, en el ERP real, y sin ningún síntoma visible: la razón social que muestra la pantalla es la del proveedor que la app eligió, así que se ve coherente.

### 2. ~~El spec declara cinco lecturas de Tango y solo se implementó una~~ — CERRADO

Resuelto el 2026-08-05. Las cinco lecturas del spec §4 están implementadas y testeadas contra la base. Ver "La capa de lectura de Tango" más abajo.

### 3. La contraseña de SQL Server está en el historial de git

La saqué de todos los archivos trackeados, pero estuvo commiteada en los commits anteriores a `37d6a9b`. **No hay remoto configurado, así que nunca salió de este disco.**

Si en algún momento se publica el repo, hay que rotar la contraseña del usuario `Axoft` en SQL Server, o reescribir el historial antes de publicar. Es una decisión que queda pendiente y hay que tomarla **antes** del primer push, no después.

---

## La capa de lectura de Tango

Las cinco lecturas del spec §4 están completas, en `src/server/tango/`, con **28 tests** contra la base real.

| Módulo | Función | Tablas |
|---|---|---|
| `proveedores.ts` | `buscarProveedorPorCuit`, `buscarProveedoresPorRazonSocial` | `CPA01` |
| `condicionesCompra.ts` | `listarCondicionesCompra`, `buscarCondicionCompra` | `CONDICION_COMPRA`, `CPA49` |
| `impuestos.ts` | `listarAlicuotasIva`, `listarCodigosImpuesto` | `CPA14` |
| `remitos.ts` | `buscarRemitosPendientes` | `STA14`, `STA20`, `STA11` |

### Qué tablas se pueden tocar

La documentación oficial de Axoft lista las tablas por módulo. Son la referencia:

- Compras — <https://ayudas.axoft.com/21ar/documentos/operacion/tablas_oper/tablascompras_oper/>
- Stock — <https://ayudas.axoft.com/21ar/documentos/operacion/tablas_oper/tablastock_oper/>

**`CTA09` y `CTA11` no figuran en ningún módulo.** Son tablas de Tango Central, el espejo para consolidación entre sucursales, igual que `CTA05`/`CTA06`/`CTA07` respecto de `CPA04`/`CPA18`/`CPA46`. No son la fuente de verdad y no hay que leerlas ni escribirlas. La primera versión de `remitos.ts` se escribió contra `CTA09`/`CTA11` y se rehízo contra `STA14`/`STA20`.

### Dos correcciones al spec

1. **§9 paso 7 dice `UPDATE CTA11.FALTA_REM`. Está mal por partida doble:** `CTA11` no tiene ninguna columna `FALTA_REM`, y no es la tabla que hay que actualizar. Lo que Tango mantiene son `STA20.CANT_FACTU` y `STA20.CANT_PEND`, más `STA14.ESTADO_MOV`. Hay que corregirlo antes de la Fase 4.
2. **§266 define el remito pendiente sobre `CTA09`.** La definición correcta es sobre `STA14`: cabecera con `TCOMP_IN_S = 'RP'` y `ESTADO_MOV = 'P'`, con al menos un renglón de `STA20` con `CANT_PEND > 0`.

---

## Convenciones del proyecto

- Todas las tablas propias llevan prefijo `PHF_`. Ninguna otra tabla se crea en `PUNTO_HOGAR_1`, que tiene 3.102 tablas del ERP Tango con datos reales.
- Ningún módulo fuera de `src/server/tango/` puede emitir SQL contra tablas `CPA*`, `CTA*`, `STA*`, `GVA*` o `SBA*`. Es la frontera que acota el costo de un futuro cambio de versión de Tango.
- Toda consulta va parametrizada con `.input(...)` de `mssql`.
- IBM Plex Sans para la UI, IBM Plex Mono para todo dato que el operador cotejá contra el PDF. Self-hosted, nunca Google Fonts.
- Sin Tailwind: CSS Modules y medidas exactas en píxeles. Diseñado para ≥1280px, sin diseño mobile.
- Copy en español rioplatense, sobrio y técnico.

---

## Datos de la base que costó descubrir

- Los CUIT en `CPA01` están guardados **con** guiones (`23-23292431-4`). La columna de razón social es `NOM_PROVEE`.
- `CPA06` está vacía en toda la base. Los renglones de factura viven en `CPA46`.
- Un ingreso de factura de compra en Tango toca **11 tablas**, no una. Están listadas en el spec §2.
- El 77% de las facturas se cargan solo con cabecera. De las que tienen renglones, el 98,3% están atadas a un remito previo: el stock ya se movió cuando entró el remito, la factura solo se le asocia.
- `useUTC: false` en la config de `mssql` es load-bearing: sin eso, una columna `DATE` vuelve como UTC y todas las fechas se muestran un día antes. Hay un test que lo protege.

Lo que salió de implementar las cuatro lecturas que faltaban:

- **`CPA14` es un solo maestro para dos cosas.** La documentación lo llama "Códigos de impuestos". La partición es `TIPO_ALI`: `IV` son las alícuotas que van en los cinco slots de IVA de la cabecera (`CPA04.COD_IVA1..5`), y `IB`/`II`/`OT` son los códigos que van en `CPA18`. Verificado: `CPA18` usa 15 códigos distintos, `CPA14` tiene exactamente 15 filas no-`IV`, y ninguna fila de `CPA18` apunta a una `IV`. Los códigos 40 y 60 de la factura de referencia son `IMP INT` (`II`) y `PERCEPCION IIBB TUC` (`IB`).
- **`STA20.CANT_PEND` no se puede derivar.** `CANTIDAD - CANT_FACTU - CANT_DEV` da distinto en 380 renglones de `RP`. Hay que leer la columna.
- **`STA20.PRECIO` viene en 0 en los 13.933 renglones de remito de proveedor.** El precio real está en `PRECIO_REM`.
- **`STA14` y `CTA09` no son intercambiables.** `STA14` tiene 11.877 filas y `NRO_SUCURS = 0` en todos los `RP`, sin números repetidos. `CTA09` tiene 140.915, dos sucursales (1001 y 1002) y 56 `NCOMP_IN_S` repetidos entre ellas: ahí el join necesita `NRO_SUCURS`, y `CPA48` —que no tiene esa columna— no alcanza para desambiguar.
- **Condiciones de compra en dos niveles.** `CONDICION_COMPRA` es la cabecera (36 filas, una por condición); `CPA49` son los renglones de cuotas (68). `CPA01.COND_COMPR` vale 0 en 640 de los 666 proveedores y no hay condición con ese código: 0 significa "sin condición".
- **Hoy hay 13 remitos pendientes de facturar, de 10 proveedores.** Los tests descubren el proveedor en `beforeAll` en vez de hardcodearlo, porque esos remitos se van a facturar.
