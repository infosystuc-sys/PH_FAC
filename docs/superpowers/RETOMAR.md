# Estado del proyecto

**Última actualización:** 2026-08-04
**Rama:** `master` (ojo: se llama `master`, no `main` — `git init` la creó así)

---

## Fase 1: completa e integrada

Las 8 tareas de la Fase 1 están terminadas, revisadas e integradas a `master` en el merge `3d56303`. **60 tests en verde.**

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

**Antes de arrancar la Fase 2** hay que cargar la API key de Anthropic en `D:\APP\PH_FAC\.env.local`, en la variable `ANTHROPIC_API_KEY`, que hoy está vacía.

---

## Tres cosas que hay que arrastrar a las fases siguientes

Salieron de la revisión final de la Fase 1 y no están resueltas. Anotarlas acá es la única forma de que no se pierdan.

### 1. Siete CUIT duplicados en `CPA01`, uno de ellos en cuatro filas

Verificado contra la base. `buscarProveedorPorCuit` ya es determinístico —ordena por `COD_PROVEE`— así que hoy no hay comportamiento aleatorio. Pero elegir "el primero" sigue siendo una decisión arbitraria.

La resolución real es de la **Fase 3**: cuando el CUIT matchea más de un proveedor, la app tiene que mostrarle las coincidencias al operador para que elija. Si no se hace, la Fase 4 termina imputando una factura a la cuenta corriente del proveedor equivocado, en el ERP real, y sin ningún síntoma visible: la razón social que muestra la pantalla es la del proveedor que la app eligió, así que se ve coherente.

### 2. El spec declara cinco lecturas de Tango y solo se implementó una

El spec §4 pide: proveedores por CUIT y razón social, **remitos pendientes de facturar por proveedor**, **condiciones de compra**, **alícuotas de IVA** y **códigos de impuesto**. El plan de la Fase 1 angostó eso a solo proveedores y nadie lo dejó asentado en su momento.

La Fase 2 no puede arrancar suponiendo que la capa de lectura de Tango está terminada. Son cuatro consultas más contra tablas del ERP que hay que descubrir, verificar contra la base y testear.

### 3. La contraseña de SQL Server está en el historial de git

La saqué de todos los archivos trackeados, pero estuvo commiteada en los commits anteriores a `37d6a9b`. **No hay remoto configurado, así que nunca salió de este disco.**

Si en algún momento se publica el repo, hay que rotar la contraseña del usuario `Axoft` en SQL Server, o reescribir el historial antes de publicar. Es una decisión que queda pendiente y hay que tomarla **antes** del primer push, no después.

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
