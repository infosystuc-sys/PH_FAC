# Estado del proyecto

**Última actualización:** 2026-08-07 (Fase 3 EN CURSO — ver sección siguiente, es lo primero que hay que leer)
**Rama actual:** `fase-3-validaciones-observacion-toasts` (creada desde `master` en el commit `628425e`). `master` se llama así, no `main` — `git init` la creó así.
**Fase 2:** completa e integrada. Se mergeó a `master` (fast-forward, sin conflictos) el 2026-08-06; la rama `fase-2-importacion-extraccion-revision` ya no existe (se borró después del merge). Ver la sección "Fase 2" más abajo para el detalle.

---

## Fase 3 — EN CURSO: validaciones, observación, toasts y atajos

**Leé esto antes que nada más en este archivo.** Esta sección es un handoff completo para retomar en una conversación nueva sin perder nada. Se escribió a mitad de la Task 5 de 9, cuando el usuario pidió cambiar de conversación.

### Documentos de referencia (leer en este orden)

1. **Spec:** `docs/superpowers/specs/2026-08-07-fase3-validaciones-observacion-toasts-design.md` — qué se construye y por qué, ya aprobado por el usuario.
2. **Plan:** `docs/superpowers/plans/2026-08-07-fase3-validaciones-observacion-toasts.md` — las 9 tareas con código completo. **Este archivo tuvo 4 correcciones durante la implementación** (ver "Bugs del plan encontrados" más abajo) — la versión en el repo ya las tiene, no hace falta volver a aplicarlas.
3. **Ledger del SDD (la fuente de verdad del progreso, más detallada que esta sección):** `.superpowers/sdd/2026-08-07-fase3-validaciones-observacion-toasts/progress.md`. Ahí está, tarea por tarea, cada implementación, cada revisión, cada fix round, con SHAs exactos. **Leer este archivo completo antes de continuar** — esta sección de RETOMAR.md es un resumen, el ledger es el detalle.
4. El proceso que se está siguiendo es **`superpowers:subagent-driven-development`** (invocar el skill con ese nombre para continuar) — implementador fresco por tarea, revisión de spec+calidad después de cada una, fix loop de hasta 5 rondas si hace falta, revisión final de rango al terminar las 9 tareas.

### Estado exacto del código ahora mismo

```bash
cd /d/APP/PH_FAC
git branch --show-current   # fase-3-validaciones-observacion-toasts
git log --oneline -1        # 5c29a4c Bloquear "Confirmar datos" si hay validaciones en error
git status --short          # debería estar limpio
```

Si `git status` no está limpio, alguien (humano o agente) dejó algo a medias — revisar antes de seguir, no descartar sin mirar.

### Qué está terminado (Tasks 1-5 de 9)

| Task | Qué hace | Estado |
|---|---|---|
| 1 | `src/lib/validaciones.ts` — las 4 validaciones puras + `letraComprobante`/`nComp` | ✅ completa, review clean |
| 2 | `buscarProveedoresPorCuit` (plural) + `src/server/tango/comprobantes.ts` (lectura de duplicados en CPA04) | ✅ completa, review clean |
| 3 | `src/server/app/validaciones.ts` — orquesta detalle + Tango + PHF_COMPROBANTE en `validarComprobanteEn`/`validarComprobante` | ✅ completa, review clean tras 1 fix round (truncar `tipo` a 10 chars antes de bindear a `VarChar(10)`) |
| 4 | Panel de validaciones (`validaciones.tsx`) + selector manual de proveedor (`selector-proveedor.tsx`) + `elegirProveedorEn`/`elegirProveedor`/`buscarProveedores` en `acciones.ts` | ✅ completa, review clean tras 1 fix round (carrera de resultados obsoletos en el buscador) |
| 5 | `confirmarComprobante` re-valida y rechaza si `bloqueante`; "Confirmar datos" se deshabilita en el cliente | ⚠️ **implementada y commiteada (`5c29a4c`), pero la revisión de Task 5 TODAVÍA NO SE DESPACHÓ** — es el próximo paso, ver abajo |

### Próximo paso inmediato: despachar la revisión de Task 5

No se llegó a generar el paquete de revisión ni a despachar el reviewer. Hacerlo así:

```bash
cd /d/APP/PH_FAC
bash "$(find ~/.claude -path '*subagent-driven-development/scripts/review-package' 2>/dev/null | head -1)" \
  docs/superpowers/plans/2026-08-07-fase3-validaciones-observacion-toasts.md 46ce7dc 5c29a4c
```

(Si el `find` no encuentra el script, buscar `scripts/review-package` dentro de la instalación del plugin `superpowers` — en esta máquina estaba en `C:\Users\USUARIO\.claude\plugins\cache\claude-plugins-official\superpowers\6.2.0\skills\subagent-driven-development\scripts\review-package`.)

Eso imprime la ruta de un archivo de diff. Despachar un subagente de revisión (modelo `sonnet` alcanza, es una task chica) con el prompt de `task-reviewer-prompt.md` del mismo skill, apuntando a:
- Brief: `.superpowers/sdd/2026-08-07-fase3-validaciones-observacion-toasts/task-5-brief.md`
- Reporte del implementer: `.superpowers/sdd/2026-08-07-fase3-validaciones-observacion-toasts/task-5-report.md`
- El diff que acaba de imprimir el comando de arriba

**Verificación manual en navegador — quedó a medias, terminarla como parte de cerrar Task 5 (no es bloqueante para despachar la revisión, pero hay que completarla antes de dar la task por cerrada):**
- ✅ Ya confirmado: en `/comprobantes/743` (CUIT sin match → validación de proveedor en error) el botón primario muestra "Resolvé las validaciones en error antes de confirmar" y está deshabilitado.
- ❌ Falta confirmar: en un comprobante SIN errores bloqueantes (advertencias de totales/CAE están bien, no cuentan) el botón dice "Confirmar datos" y está habilitado. Estaba por chequear `/comprobantes/4158` cuando se cortó — probar ese u otro similar.

El dev server ya está corriendo en `localhost:3011` (`.claude/launch.json`, config `ph-fac-dev`) — usar `preview_start` con `{name: "ph-fac-dev"}` para reengancharse al Browser pane en vez de levantarlo de nuevo.

### Qué falta después de Task 5 (Tasks 6-9, sin empezar)

6. **Modal de observación** — `marcarObservacion` en `acciones.ts` + `modal-observacion.tsx` + habilitar el botón "Marcar en observación" en `barra-acciones.tsx` (hoy deshabilitado con `title="Llega en la Fase 3"`).
7. **Sistema de toasts** — `ToastProvider`/`useToast` + wiring en confirmar/observación/importar. Ojo: el plan de Task 9 asume que `BarraAcciones` ya tiene `useToast()` montado desde Task 7 — si se reordena el trabajo, revisar esa dependencia.
8. **`condcompra` de texto libre a select** — nuevo tipo `'select'` en `src/lib/campos.ts`, soporte en `Campo`/`Formulario`, opciones desde `listarCondicionesCompra()` (ya existe, Fase 1).
9. **Atajos de teclado + navegación J/K** — `obtenerVecinosEn`/`obtenerVecinos` en `comprobantes.ts`, hook `useAtajos`, reemplazo completo de `barra-acciones.tsx` consolidando todo lo de las Tasks 5-7-9 en un solo archivo final (el plan ya trae el código completo de esa versión consolidada).

Después de la Task 9: revisión final de rango completo (`5a40f7f..HEAD` no, ojo — el rango de ESTA fase es desde donde arrancó la rama: usar `git merge-base master fase-3-validaciones-observacion-toasts` para el `MERGE_BASE`, que debería dar `628425e`), con el modelo más capaz disponible. Si hay hallazgos: un solo fix dispatch + una re-revisión, no uno por hallazgo. Al quedar limpia: borrar el workspace del SDD (`rm -rf .superpowers/sdd/2026-08-07-fase3-validaciones-observacion-toasts`) e invocar `superpowers:finishing-a-development-branch` para decidir con el usuario qué hacer con la rama (mergear a `master`, como se hizo con la Fase 2).

### Bugs del plan encontrados durante la implementación (ya corregidos en el plan y en el código)

El plan lo escribí yo (el agente) antes de empezar a implementar, y salieron 4 defectos reales al ejecutarlo — documentados acá para que quien retome sepa que **el plan ya fue parcheado sobre la marcha** y no hay que desconfiar de él, pero sí vale la pena tenerlos presentes:

1. **Task 1** — un fixture de `validarTotales` tenía mal la aritmética (`neto: '100,00'` con `total: '112.480,00'` no da una diferencia de `12.480,00`). El implementer lo detectó solo y lo corrigió a `neto: '100.000,00'`; el plan quedó actualizado.
2. **Task 3** — el plan decía "Expected: PASS (6 tests)" pero el bloque de código tiene 5 `it()`. Era un error de conteo mío, no un test faltante (el implementer no inventó un sexto test, y el reviewer confirmó independientemente que 5 es cobertura adecuada). Plan corregido.
3. **Task 3** — `.input('tipo', sql.VarChar(10), valores.tipo ?? null)` en la query de duplicado contra `PHF_COMPROBANTE` no truncaba el valor antes de bindearlo (puede tener 24+ caracteres reales, ej. "FACTURA A 0011-00063576"). Se corrigió con `.slice(0, 10)`, seteado ya sobre el precedente que sienta `cola.ts:135` para el mismo problema con el mismo campo.
4. **Task 4** — la versión original de `elegirProveedor` usaba `getPool()` (conexión real) directo. El test la llama sobre un comprobante insertado dentro de `conRollback` (transacción sin commitear) — la fila queda con lock exclusivo hasta que el test termina, y el `UPDATE` de `elegirProveedor` desde la conexión separada queda esperando ese lock para siempre: deadlock real, no hipotético (se reprodujo dos veces con timeout de 20s). Se corrigió separando en `elegirProveedorEn(e: Ejecutor, ...)` (testeable con cualquier conexión) + `elegirProveedor(...)` (wrapper de producción sobre el pool real) — mismo patrón que ya usa `guardarCampoEn`/`guardarCampo` y `obtenerDetalleEn`/`obtenerDetalle`. **Si alguna task futura (6-9) necesita testear una función que combine "usa el pool real" + "el test inserta datos vía `conRollback`", aplicar el mismo patrón `_En`/wrapper desde el vamos, no esperar a que un test cuelgue para descubrirlo.**

**Dato de infraestructura verificado y relevante para lo anterior:** la base de datos tiene `READ_COMMITTED_SNAPSHOT` **activado** (`is_read_committed_snapshot_on: true`). Esto significa que una **lectura** (`SELECT`) desde una conexión separada NO se bloquea contra una fila con una transacción de escritura sin commitear — lee la última versión commiteada (o simplemente no ve la fila si nunca se commiteó). Por eso Task 5 (que hace una lectura vía `validarComprobante` dentro de `confirmarComprobante`, no una escritura) **no** tuvo el mismo problema que Task 4: se verificó esto explícitamente antes de despachar la Task 5 para no perder tiempo con otro deadlock. La regla práctica: **escrituras** (`UPDATE`/`INSERT`/`MERGE`) desde el pool real SÍ pueden colgarse contra un `conRollback` que insertó la fila; **lecturas** (`SELECT`) no.

### Interrupciones por límite MENSUAL de gasto de la API (distinto de los límites de sesión/semanales)

Pasó dos veces en esta fase (Task 4 y Task 5), siempre durante el paso opcional de "verificación visual en navegador" al final de una task — nunca durante la implementación/tests/tsc, que siempre habían terminado y estaban verificados antes del corte. Patrón para manejarlo si vuelve a pasar:

1. Verificar desde afuera (el controller, no el agente) que el código, los tests y `tsc --noEmit` están bien — normalmente ya lo están, el corte llega tarde en el flujo de la task.
2. Commitear igual si todo lo anterior está verde (no hace falta esperar a que el agente mismo commitee).
3. Opcionalmente, reanudar el mismo agente (por `agentId`, no uno nuevo) pidiéndole solo que escriba su reporte, sin reprocesar nada pesado — a veces alcanza cuota para eso aunque no para más trabajo.
4. Si la verificación visual en navegador quedó pendiente, el controller puede completarla él mismo con las herramientas de Browser pane (`preview_start` con `{name: "ph-fac-dev"}`, `navigate`, `read_page`/`get_page_text` — el `screenshot` con píxeles reales no funciona en este entorno, da "the Browser pane is not displayed, so the page is not compositing frames"; usar el árbol de accesibilidad/texto en su lugar).
5. Si el límite bloquea directamente el *despacho* de un agente (no solo lo corta a mitad de camino), no hay mucho margen: puede que haya que esperar a que se renueve el mes, o que el usuario lo suba desde `claude.ai/settings/usage`. No confundir con los límites de sesión/semanales vistos en fases anteriores, que se resuelven solos en horas o días — este es mensual.

### Convención de commits de esta fase (igual que el resto del proyecto)

Español, imperativo, terminando en `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Cuando el controller corrige un bug del plan encontrado durante la implementación, hace un commit aparte solo para el archivo del plan (no mezclado con el código), con el mensaje explicando qué estaba mal. Ver `git log` en la rama para los ejemplos exactos (`515d1b4`, `bad48af` no — ese es el fix de código, buscar `f89d315` y el commit del fixture de Task 1).

---

## Fase 2: completa

Las 11 tareas de la Fase 2 están terminadas. **187 tests en verde** (incluye los 2-3 tests flaky conocidos de `migrate.test.ts` por contención de SQL Server — si falla justo ese archivo, re-correr sin tocar nada suele alcanzar).

El circuito completo anda de punta a punta: **importar → extraer con Claude → revisar contra el PDF con resaltado sincronizado → corregir con autosave → confirmar → historial**. Verificado en el navegador contra el dev server real (`:3011`) con un comprobante real (`Comprobante_147868-CLARO.pdf`, factura de AMX Argentina/Claro):

- Import + extracción real: 20 campos, confianza promedio 94%, modelo `claude-opus-5`, 18,6 s.
- El proveedor se resolvió solo por CUIT contra `CPA01` (`AMX ARGENTINA SOCIEDAD ANONIMA`).
- Se corrigió "Condición de pago" a mano, se recargó la página y la corrección persistió.
- Se confirmó: el badge pasó de "Pendiente de revisión" a "Confirmado", el botón primario cambió a "Registrar en Tango" (deshabilitado, título "Llega en la Fase 4"), y apareció la entrada "Datos confirmados por el operador" en el historial.
- La bandeja, filtrada por "Confirmados", mostró el comprobante.

Lo que quedó funcionando, sumado a la Fase 1:

- Importación de PDFs (drag & drop o selección, hasta 50 archivos, 10 MB c/u) con validación de lote atómica.
- Extracción con Claude (`src/server/ia/`): 29 campos + renglones, con confianza por campo, corriendo en una cola en proceso (`src/server/app/cola.ts`) con reintentos y repesca de comprobantes colgados. Esto es cierto desde el fix round de la revisión final de la Fase 2 (hallazgos 1 y 2): antes, `arrancarWorker()` no la invocaba nadie del repo (faltaba `instrumentation.ts`), así que la repesca nunca corría en la práctica, y `tanda()` no drenaba la cola completa por lote. Los dos quedaron resueltos: `instrumentation.ts` arranca el worker al boot, y `tanda()` vuelve a pedir pendientes hasta vaciar la cola.
- Pantalla de revisión (`/comprobantes/[id]`): visor de PDF real (pdf.js) con resaltado sincronizado por capa de texto, formulario de 4 grupos con autosave, barra de acciones con botón contextual por estado, aviso de lectura IA con reproceso (avisa antes de descartar correcciones), renglones (ocultos si no hay ninguno — 77% de los casos) e historial de auditoría.
- Estados especiales: `procesando` muestra un placeholder que se refresca solo cada 3 s y deja de hacerlo en cuanto el server component deja de montarlo; `error` muestra el mensaje y el botón de reprocesar.
- `registrado` es terminal e inmutable: la escritura de campos (`guardarCampoEn`) es un no-op atómico si el comprobante ya está registrado — verificado con test. Desde el fix round de la Tarea 11 (hallazgo 1) el formulario también lo refleja: los inputs quedan de solo lectura (`Campo`/`Formulario`/`Pantalla` reciben `soloLectura`/`bloqueado` desde `page.tsx`), así que el operador ya no ve un campo "editable" cuyo guardado en realidad es un no-op silencioso.

Para verificar que todo sigue en pie:

```bash
cd /d/APP/PH_FAC && git status --short && pnpm test
```

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

**Fase 3** — las cuatro validaciones (proveedor por CUIT, sin duplicados, totales cuadran, CAE), modal de observación, resolución de CUIT duplicado a mano, toasts, atajos de teclado.
**Fase 4** — registro en Tango y asociación de remitos.

Cada fase lleva su propio plan. El diseño completo está en `docs/superpowers/specs/2026-08-04-importador-facturas-tango-design.md`. La Fase 2 tuvo su propio spec: `docs/superpowers/specs/2026-08-05-fase2-importacion-extraccion-revision-design.md`.

La API key de Anthropic ya está cargada en `ANTHROPIC_API_KEY`, en `D:\APP\PH_FAC\.env.local` (verificado el 2026-08-04, y de nuevo el 2026-08-06 con una extracción real).

---

## Cosas que hay que arrastrar a las fases siguientes

Las tres primeras salieron de la revisión final de la Fase 1; las dos últimas, de cerrar la Fase 2 (Tarea 11). Ninguna está resuelta. Anotarlas acá es la única forma de que no se pierdan.

### 1. Siete CUIT duplicados en `CPA01`, uno de ellos en cuatro filas

Verificado contra la base. `buscarProveedorPorCuit` ya es determinístico —ordena por `COD_PROVEE`— así que hoy no hay comportamiento aleatorio. Pero elegir "el primero" sigue siendo una decisión arbitraria.

La resolución real es de la **Fase 3**: cuando el CUIT matchea más de un proveedor, la app tiene que mostrarle las coincidencias al operador para que elija. Si no se hace, la Fase 4 termina imputando una factura a la cuenta corriente del proveedor equivocado, en el ERP real, y sin ningún síntoma visible: la razón social que muestra la pantalla es la del proveedor que la app eligió, así que se ve coherente.

### 2. ~~El spec declara cinco lecturas de Tango y solo se implementó una~~ — CERRADO

Resuelto el 2026-08-05. Las cinco lecturas del spec §4 están implementadas y testeadas contra la base. Ver "La capa de lectura de Tango" más abajo.

### 3. La contraseña de SQL Server está en el historial de git

La saqué de todos los archivos trackeados, pero estuvo commiteada en los commits anteriores a `37d6a9b`. **No hay remoto configurado, así que nunca salió de este disco.**

Si en algún momento se publica el repo, hay que rotar la contraseña del usuario `Axoft` en SQL Server, o reescribir el historial antes de publicar. Es una decisión que queda pendiente y hay que tomarla **antes** del primer push, no después.

### 4. El costo real por comprobante no está medido sobre una muestra representativa

Un solo comprobante real disponible en `D:\CASOS\RAM - APP FAC\` (`Comprobante_147868-CLARO.pdf`, 6 páginas): la extracción tardó 18,6 s con `claude-opus-5`, 20 de 29 campos con valor y confianza promedio 94%. `extraerDePdf` (`src/server/ia/extraccion.ts`) **ya devuelve** `usage.inputTokens`/`outputTokens` (fix round de la Tarea 11, hallazgo 2), así que el dato está disponible para quien procese un comprobante; falta persistirlo en `PHF_COMPROBANTE` cuando haga falta acumularlo. Lo que sigue pendiente, y por falta de muestra, no de código: correrlo contra 4-5 comprobantes reales más para tener un promedio de costo en USD, no un solo dato. Antes de la Fase 4 (que es cuando el volumen real —20 a 100 comprobantes por día— empieza a importar en plata) conviene juntar esos PDFs y, si se decide acumular el gasto por comprobante, agregar la columna correspondiente.

### 5. `NUMERO` tiene dos convenciones distintas conviviendo en la misma columna

Descubierto armando la barra de acciones de la pantalla de revisión (Tarea 11). Los comprobantes que vienen de `pnpm seed` guardan `PHF_COMPROBANTE.NUMERO` ya combinado con el punto de venta (`"0003-00018742"`); los que vienen de una extracción real dejan `NUMERO` y `PUNTO_VENTA` por separado (`"00018742"` + `"0003"`). La bandeja (`src/components/bandeja/tabla.tsx`) ya convivía con esto mostrando `NUMERO` solo, sin combinarlo — la barra de acciones nueva sigue el mismo criterio (`formatComprobante` en `src/app/comprobantes/[id]/page.tsx`) para no duplicar el punto de venta en pantalla. Si en algún momento se unifica el formato de `NUMERO`, hay que revisar los dos lugares.

### 6. `condcompra` sigue siendo un input de texto libre

Salió de la revisión final de la Fase 2. El campo "Condición de pago" del formulario de revisión es un input de texto en vez de un select contra `listarCondicionesCompra` (`src/server/tango/condicionesCompra.ts`), que ya existe y ya está testeado. No bloquea la Fase 2 -- el operador puede escribir cualquier cosa y el dato se guarda igual -- pero antes de la Fase 4 (donde ese valor probablemente tenga que resolverse a un código válido de Tango para grabar el asiento) conviene cerrarlo.

### 7. `desnormalizarBandejaEn` trunca con `.slice()` sin avisar

Salió de la misma revisión. `TIPO`, `PUNTO_VENTA`, `NUMERO` y `CUIT` se truncan con `.slice(10)`, `.slice(20)`, etc. antes de escribirlos en `PHF_COMPROBANTE` (`src/server/app/cola.ts`), para calzar con el ancho de columna. Si la IA devuelve un valor más largo que el límite, se guarda cortado y sin ningún aviso. Hoy es un riesgo bajo porque esas columnas son solo de visualización en la bandeja (el valor completo sigue disponible en `PHF_CAMPO.VALOR_IA`/`VALOR_FINAL`), pero si alguna vez alimentan directamente la escritura en Tango, un truncado silencioso ahí sí sería un problema.

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
