# Estado del proyecto

**Última actualización:** 2026-08-11. Agregado el tercer valor de `tipoFactura` ("Liquidación de tarjeta"), bloqueado hasta que se implemente (ver "Cosas que hay que arrastrar" más abajo). Restricción de percepciones de IVA/IIBB completa. Todo en `master` directamente, sin rama propia. Registro por conceptos completo e integrado a `master`. Fase 4 completa e integrada a `master`.
**Fase 3:** completa e integrada a `master`. Ver la sección "Fase 3" más abajo para el detalle.
**Fase 2:** completa e integrada. Se mergeó a `master` (fast-forward, sin conflictos) el 2026-08-06; la rama `fase-2-importacion-extraccion-revision` ya no existe (se borró después del merge). Ver la sección "Fase 2" más abajo para el detalle.

---

## Restricción de percepciones de IVA/IIBB: completo

Cambio chico pedido directamente por el usuario ("no generes un plan, directamente implementa"), sin spec ni plan formal — implementado en el mismo `master`, sin rama propia. **271 tests en verde**, `tsc --noEmit` limpio.

Dos decisiones de negocio, ambas explícitas del usuario:

- **Percepción de IVA del 3%:** antes ambigua entre `COD_IVA` 15 ("PERCEPCION R.G.3337") y 16 ("PERCEP. DE IVA"), con un selector para que el operador eligiera. Ahora siempre se resuelve a **15** — se sacó el selector (`codpercepiva`) del catálogo y del formulario. `mapearAlicuotaIva` (`src/server/tango/comprobantes.ts`) ya no recibe un código elegido, prefiere 15 cuando hay ambigüedad.
- **Percepción de IIBB:** restringida a 4 jurisdicciones (`src/lib/percepcionIibb.ts`, fuente única): `60` Tucumán, `61` Salta, `62` CABA, `68` Formosa. **La IA ahora sugiere el código automáticamente**, leyendo la jurisdicción del texto del comprobante (prompt extendido en `src/server/ia/prompt.ts`, regla 8) — `codpercibb` pasó a ser un campo `extraePorIA: true`, igual que cualquier otro campo con badge de confianza; el operador lo puede corregir si hace falta.

**Un hallazgo real, no una suposición del usuario:** los códigos `64`/`66` que el usuario mencionó originalmente ("64 para bancarias") **no son percepciones en Tango — son retenciones** (`CPA14.TIPO_ALI='OT'`, `PERCEPCION=false`, descripciones "RET IIBB BANCARIOS"/"RET IIBB SIRCREB"). Tratarlos como percepción habría escrito mal el dato en `CPA18`. Verificado contra la base real antes de implementar; el usuario confirmó que son un caso aparte, fuera de este alcance. También se corrigió sobre la marcha: el código `68` (Formosa) tiene `PERCEPCION=true` (es una percepción real) pero está clasificado como `TIPO_ALI='OT'`, no `'IB'` — por eso el filtro de `codigosIibb` en `page.tsx` usa una lista explícita de códigos (`JURISDICCIONES_IIBB`), no `TIPO_ALI`, que resultó no ser confiable para esto.

**Verificado en vivo, sin usar el navegador para la parte de IA** (para no gastar una llamada más de la cuenta): se corrió `extraerDePdf` directo contra el PDF real de AMX/Claro (que dice "Perc. IIBB Tucumán RG 22/18") — la IA devolvió `codpercibb: "60"` con 95% de confianza. Después sí se verificó en el navegador (con datos insertados a mano, sin gastar otra llamada) que el select se ve pre-cargado en "PERCEPCION IIBB TUC" con el badge 95%, que la lista de opciones tiene exactamente las 4 jurisdicciones esperadas (ni retenciones ni otros códigos de `CPA14`), y que el selector de percepción de IVA ya no aparece en ningún lado del formulario.

**Dos ajustes posteriores, mismo día:**

1. **No era un bug de lógica.** El usuario reportó que la sugerencia automática "no funcionaba" en un comprobante real (`Comprobante_147868-CLARO.pdf`, ID 1003). La causa: ese comprobante se había extraído contra un proceso de `next dev` que llevaba corriendo desde antes de este cambio — Node no recarga en caliente el worker de la cola en background (`instrumentation.ts`), así que seguía usando el prompt/schema viejo, sin `codpercibb`. Al reprocesar con el servidor reiniciado, sugirió `60` correctamente. Lección para la próxima: si algo "no toma" un cambio de servidor después de editar código, reiniciar el `pnpm dev` antes de sospechar de la lógica.
2. **El panel "Listo para registrar" ahora muestra la descripción real de Tango** para la percepción de IIBB elegida (`Percepción IIBB: 60 — PERCEPCION IIBB TUC.`), no solo "Código elegido." — mismo criterio que ya usaba el chequeo de concepto de las facturas por conceptos. Pedido explícito del usuario, verificado en el comprobante real 1003.

**Tercer valor de `tipoFactura`, agregado el mismo día:** el usuario adelantó que además de "por conceptos" y "por artículos" va a haber una tercera categoría, **liquidación de tarjeta**, con interpretación de IA propia — de momento fuera de alcance ("en esta etapa nos vamos a concentrar en las de concepto"). Se agregó la opción al selector (`src/components/revision/formulario.tsx`) para que el operador ya pueda clasificar el comprobante, pero `validarTipoFactura` bloquea el registro con un mensaje explícito si se elige, y `registrarComprobanteEn` tiene el mismo guard al principio de la función (antes de cualquier lectura/escritura), no solo en la UI. Los códigos `64`/`66` (retenciones de IIBB, ver arriba) quedan anotados como candidatos para esta categoría cuando se implemente — no para "por conceptos".

---

## Registro por conceptos: completo

Las 7 tareas del plan (`docs/superpowers/plans/2026-08-09-registro-por-conceptos.md`) están implementadas y verificadas contra la base real. **275 tests en verde**, `tsc --noEmit` limpio. Spec: `docs/superpowers/specs/2026-08-09-registro-por-conceptos-design.md`.

Hasta ahora `registrarComprobanteEn` solo sabía grabar renglones de artículo (`CPA46`, vía remito) o cabecera sola. Esto agrega el otro camino real del negocio: facturas de **conceptos** (servicios, sin remito ni stock de por medio) — el operador elige "Tipo de factura: por conceptos / por artículos" en el formulario, y si elige "por conceptos", el registro busca el concepto configurado del proveedor en `CPA_CONCEPTOS_PROVEEDOR` y graba un renglón en `CPA47`. La ruta "por artículos" no se tocó — es aditivo.

Lo que se agregó:

- **Campo `tipoFactura`** (select, dos valores fijos: `'conceptos'`/`'articulos'`) en el grupo "Imputación en Tango". Sin elegir, bloquea el registro — mismo criterio sin-default-silencioso de Fase 4. Ocupa una fila propia completa (`span: 6`) porque `codprovee`+`condcompra` ya suman los 6 de una fila — hay una invariante en `tests/lib/campos.test.ts` que exige que cada grupo sume múltiplo de 6, encontrada recién al correr el test de Task 1.
- **`buscarConceptoProveedor`** (`src/server/tango/conceptos.ts`, lectura nueva): `CPA_CONCEPTOS_PROVEEDOR` es 1:1 por proveedor en toda la base hoy (ningún `COD_PROVEE` tiene más de una fila) — no hace falta un selector de ambigüedad como con las percepciones de Fase 4. Hoy solo hay **un proveedor con concepto cargado en toda la base**: `010151` (AMX/Claro, concepto `712`, "TELEFONOS LOCALES") — el resto va a bloquear "por conceptos" hasta que se cargue más data en Tango.
- **Panel "Listo para registrar"** gana dos chequeos: tipo de factura elegido, y si es "por conceptos", que el proveedor tenga concepto configurado (bloquea si no).
- **`registrarComprobanteEn`** inserta un solo renglón en `CPA47` cuando `tipoFactura='conceptos'` — confirmado contra la base real que esto es el patrón dominante (13.030 de 13.062 facturas de conceptos, 99,75%, tienen exactamente un renglón en `CPA47`; el resto son la excepción, fuera de alcance de este trabajo). El concepto se resuelve y valida **antes** del `INSERT` de `CPA04` (no después, como decía la primera versión del plan — ver más abajo), para no desperdiciar ese insert caro si el proveedor no tiene concepto.
- **Panel "Remitos pendientes"** se oculta cuando `tipoFactura='conceptos'` (un concepto no se ata a un remito).

**Un hallazgo real durante la revisión crítica del plan, antes de implementar (no llegó a ser un bug porque se corrigió antes del Step 3 de la Task 5):** el plan original ponía la resolución/validación del concepto *después* del `INSERT` en `CPA04` (~10-30s bajo contención real, medido en Fase 4). Eso hubiera desperdiciado ese insert completo en cada intento fallido por falta de concepto — el propio código ya establece el patrón correcto (`armarAlicuotas`/`mapearAlicuotaIva` se resuelven *antes* del insert, en Fase 4). Se corrigió el plan con su propio commit antes de tocar código.

**Verificación manual en el navegador**, con datos reales: comprobante de prueba contra el proveedor real `010151`, eligiendo "Por conceptos" — el panel mostró "Concepto: 712 — TELEFONOS LOCALES." en verde, "Remitos pendientes" no apareció; tras completar condición de compra, el registro escribió `CPA47` con `COD_CONCEP='712'`, `IMPORTE_GRAVADO=10000`, `IMPORTE_EXENTO=500`, `IMPORTE_NE=IMPORT_PAN=IMP_NETO_P=10500` — exactamente como predecía el diseño derivado empíricamente de las filas reales de `CPA47`.

Mergeado a `master` el mismo día (fast-forward, sin conflictos). **275 tests en verde** sobre el resultado mergeado, `tsc --noEmit` limpio. La rama `registro-por-conceptos` se borró después del merge.

---

## Fase 4: completa

Las 10 tareas del plan (`docs/superpowers/plans/2026-08-08-fase4-registro-tango-remitos.md`) están implementadas y verificadas contra la base real (`PUNTO_HOGAR_1`). **264 tests en verde**, `tsc --noEmit` limpio. Ejecutada inline (`superpowers:executing-plans`, no subagent-driven — el usuario eligió la vía más rápida), con checkpoints propios antes y después de la Task 6 (la más grande y riesgosa del plan).

Lo que se agregó:

- **`registrarComprobanteEn`/`registrarComprobante`** (`src/server/tango/comprobantes.ts`) — la única función de escritura de todo el proyecto contra el ERP. Un `sp_getapplock` serializa registros concurrentes; idempotente (llamar dos veces devuelve el mismo `TANGO_NCOMP_IN_C` sin duplicar). Escribe 9 tablas del ERP en una transacción `SERIALIZABLE`: `CPA04`/`CTA05` (cabecera), `CPA18`/`CTA06` (percepciones IIBB + impuesto interno fijo código 40), `CPA63`/clasificación IVA (alícuotas), `CPA54` (vencimientos, por cuota de `CPA49` o 100%/0 días si no hay), y si hay renglones con remito asignado, `CPA46`/`CTA07`/`CPA48` + `UPDATE STA20.CANT_FACTU/CANT_PEND` + `UPDATE STA14.ESTADO_MOV` (a `'F'` si el remito queda completamente consumido).
- **Panel "Listo para registrar"** (`src/components/revision/listo-para-registrar.tsx`): cuatro chequeos bloqueantes antes de habilitar el registro — condición de compra elegida, código de percepción IIBB elegido (si hay importe), código de percepción de IVA 3% elegido (si hay importe — desambigua entre "PERCEPCION R.G.3337" y "PERCEP. DE IVA", el único porcentaje ambiguo de `CPA14`), formato de `N_COMP` válido.
- **Selectores `codpercibb`/`codpercepiva`** en el formulario, poblados con datos reales de Tango (`listarCodigosImpuesto`/`listarAlicuotasIva`, ya existían desde la capa de lectura).
- **Botón "Registrar en Tango"** funcional en estado `confirmado` — deshabilitado si el indicador de conexión está caído o si el panel "Listo para registrar" tiene algo bloqueante. "Ver asiento en Tango" (estado `registrado`) queda **permanentemente deshabilitado**: decisión explícita del usuario — el asiento contable lo genera un proceso aparte en Tango, esta app no lo toca (`CONTABILIZ = 0`, verificado en la base real tras registrar).
- **Asociación manual de renglones a remitos pendientes** (`src/components/revision/remitos-pendientes.tsx` + `asignarRemitoEn`/`asignarRemito` en `acciones.ts`): un `<select>` por renglón, listando los remitos pendientes reales del proveedor (`buscarRemitosPendientes`, Fase 1) con su cantidad pendiente. La cantidad que se copia a `CPA46` es la del renglón de la propia factura (`PHF_RENGLON.cantidad`), no la del remito — el remito solo aporta código de artículo, depósito y precio.

**Un bug real del plan, encontrado en Task 6 vía TDD contra la base real (no lo habría atrapado `tsc` ni una revisión de código):** el plan confundía dos códigos de Tango que se parecen pero son distintos — `TCOMP_IN_C` (código interno de secuenciación, `varchar(2)`, tiene que ser `'FP'`) vs `T_COMP` (código de visualización, `varchar(3)`, `'FAC'`). El plan ataba la misma variable a los dos, lo que rompía el `INSERT` de `CPA04` con "String or binary data would be truncated". Corregido separando en dos constantes (`tComp`/`tcompInC`) y rebindeando los 9 sitios afectados. De paso salieron dos bugs más de infraestructura, también solo detectables contra datos reales: `CPA04.LEYENDA` es `varchar(30)` (no 60, como asumía el plan), y el `requestTimeout` global de `mssql` (30s) es insuficiente para un `INSERT` real en `CPA04` bajo contención (se midió hasta 95s en esta misma fase) — subido a 60s en `src/server/db/pool.ts`, con impacto real de producción, no solo de tests.

**Verificación manual de punta a punta en el navegador**, con datos reales:

- Comprobante sin renglones (factura AMX/Claro real, `Comprobante_147868-CLARO.pdf`): elegidos condición de compra, código IIBB (Tucumán) y código de percepción IVA 3% ("PERCEP. DE IVA") a mano en el formulario; "Registrar en Tango" pasó de deshabilitado a habilitado en cuanto los tres quedaron en verde; el registro tardó 95s (contención real de `CPA04`); badge pasó a "Registrado en Tango", botón quedó "Ver asiento en Tango" deshabilitado, persistió al recargar. `CPA04` verificada: `TCOMP_IN_C='FP'`, `T_COMP='FAC'`, `N_COMP='A0134000147868'`, `CONTABILIZ=0`.
- Comprobante con un renglón y remito asignado (proveedor `010246`, remito real `R0008400337724`): antes del registro, `STA20.CANT_PEND=8`/`CANT_FACTU=0`; después, `CANT_PEND=6`/`CANT_FACTU=2` (coincide con la cantidad de la factura, no con la del remito), `STA14.ESTADO_MOV` se mantuvo `'P'` (correcto: quedan 6 unidades pendientes de otro renglón). `CPA46`/`CPA48` verificadas con la cantidad correcta.
- Indicador de conexión: **no se pudo verificar de forma aislada tal como lo describe la Task 10 del plan.** `probarConexion()` comparte el mismo pool (`getPool()`, `src/server/db/pool.ts`) que usan `PHF_*` y las tablas de Tango — viven en la misma instancia de SQL Server. Al simular una conexión caída (`SQLSERVER_HOST` inválido), **toda** la pantalla de revisión devuelve 500 antes de llegar a renderizar el botón, porque `obtenerEncabezado` (que corre antes que `probarConexion` en `page.tsx`) también depende del mismo pool roto. No es un bug de la Task 8: es una característica inherente de tener una sola instancia de SQL Server para datos propios y del ERP. La lógica de gating en sí (`disabled={pendiente || sinConexion || bloqueanteRegistro}`, `src/components/revision/barra-acciones.tsx`) es trivial y quedó revisada por tipo; su valor práctico real es acotado a una ventana de carrera (la conexión se cae *después* de que la página ya cargó bien, justo antes del click) que no se puede reproducir de forma segura sin infraestructura de mocks, ajena al estilo de test de este proyecto.

---

## Fase 3: completa

Las 9 tareas del plan (`docs/superpowers/plans/2026-08-07-fase3-validaciones-observacion-toasts.md`) están implementadas, cada una revisada individualmente en limpio, más un hotfix de una regresión real de Task 6 y una ronda de fix sobre la revisión final de todo el rango. **233 tests en verde**, `tsc --noEmit` limpio. Ledger completo tarea por tarea, con cada revisión y cada fix round: `.superpowers/sdd/2026-08-07-fase3-validaciones-observacion-toasts/progress.md` — el workspace del SDD todavía no se borró, queda ahí hasta decidir el merge.

Lo que se agregó:

- **Cuatro validaciones server-side** (proveedor por CUIT, sin duplicados, totales cuadran, CAE) — lógica pura en `src/lib/validaciones.ts`, orquestación contra Tango + `PHF_COMPROBANTE` en `src/server/app/validaciones.ts`. Se calculan al abrir la revisión y de nuevo al confirmar.
- **Resolución manual de proveedor** cuando el CUIT matchea 0 o 2+ proveedores en `CPA01` — panel de validaciones + `SelectorProveedor` (buscador por razón social) + `elegirProveedor`. Esto cierra el ítem #1 de "Cosas que hay que arrastrar" (más abajo): la app ahora **sí** le pregunta al operador cuál proveedor corresponde, y esa elección **sí** destraba la confirmación (ver el bug Critical que hubo que corregir, próximo párrafo).
- **El botón "Confirmar datos" se bloquea** (cliente y servidor) si hay alguna validación en estado `error`.
- **Modal de "marcar en observación"** con motivo de una lista cerrada + nota opcional.
- **Sistema de toasts** (`ToastProvider`/`useToast`) en confirmar, observación e importar, con manejo de error visible en los tres casos.
- **"Condición de pago" pasó de texto libre a `<select>`** poblado con `listarCondicionesCompra()` (datos reales de Tango).
- **Atajos de teclado**: `Ctrl+Enter` confirma, `Ctrl+O` abre observación (ambos andan con foco en un campo de texto), `J`/`K` navegan al comprobante siguiente/anterior dentro del filtro y búsqueda activos de la bandeja.

**Un hotfix a mitad de fase:** Task 6 exportó una constante (`MOTIVOS_OBSERVACION`) desde `src/server/app/acciones.ts`, que tiene `'use server'` — Next.js exige que todo export de un archivo así sea una función async, así que esto rompía con 500 **todas** las server actions del archivo (confirmar, importar, elegir proveedor, etc). Lo encontró el implementer de la Task 7 al verificar en el navegador. Se corrigió moviendo la constante a `src/lib/observacion.ts` (commit `0d6faa9`).

**Un bug Critical encontrado en la revisión final de todo el rango** (no en las revisiones tarea por tarea — es justamente el tipo de cosa que solo aparece mirando la fase completa): `elegirProveedorEn` escribía `codprovee` cuando el operador resolvía a mano un proveedor, pero `validarComprobanteEn` nunca lo leía — seguía mirando solo el CUIT, así que un comprobante con CUIT duplicado o sin match quedaba **permanentemente inconfirmable** aun después de que el operador elegía bien. Corregido (commits `6a27943`/`e06a279`) junto con 4 hallazgos Important de la misma revisión (falso "Sin duplicados" ✓ cuando el chequeo no corría; `modal-observacion.tsx`/`selector-proveedor.tsx` sin manejo de error visible; los atajos `Ctrl` muertos con foco en un input; fetches duplicados/seriales en `page.tsx`). Verificado en vivo contra un comprobante de prueba con CUIT real duplicado (creado y borrado limpiamente) y con una re-revisión independiente que confirmó los 5 arreglos por su cuenta, no solo por el reporte del implementer.

### Tres cosas Minor que quedaron sin resolver, anotadas por la re-revisión final (ninguna bloqueante)

1. `selector-proveedor.tsx` no tiene `.catch()` en la búsqueda de candidatos — mismo tipo de error silencioso que se cerró para las mutaciones, pero acá es una lectura.
2. `Ctrl+Enter` puede dispararse con el foco en el `<textarea>` del modal de observación y confirmar el comprobante en vez de someter el modal (existía desde antes, quedó un poco más ancho al mover el guard de `estaEditando()`). Se arregla con un `if (modalAbierto) return` en `onConfirmar`.
3. Una vez que `codprovee` queda resuelto, el selector desaparece y `codprovee` es de solo lectura — si el operador se equivocó de proveedor, no hay forma de corregirlo sin un reproceso completo (que descarta las demás correcciones ya hechas).

### Próximo paso: decidir el merge

Falta:
1. Correr `superpowers:finishing-a-development-branch` para decidir con el usuario qué hacer con la rama (mergear a `master`, como se hizo con la Fase 2).
2. Borrar el workspace del SDD (`rm -rf .superpowers/sdd/2026-08-07-fase3-validaciones-observacion-toasts`) recién después de eso.

### Bugs del plan encontrados durante la implementación (ya corregidos en el plan y en el código)

Salieron 5 defectos reales del propio plan a lo largo de la fase — documentados acá para que quien lea el plan sepa que **ya fue parcheado sobre la marcha** y no hay que desconfiar de él, pero sí vale la pena tenerlos presentes:

1. **Task 1** — un fixture de `validarTotales` tenía mal la aritmética (`neto: '100,00'` con `total: '112.480,00'` no da una diferencia de `12.480,00`). Corregido a `neto: '100.000,00'`.
2. **Task 3** — el plan decía "Expected: PASS (6 tests)" pero el bloque de código tiene 5 `it()`. Error de conteo, no un test faltante — el reviewer confirmó independientemente que 5 es cobertura adecuada.
3. **Task 3** — `.input('tipo', sql.VarChar(10), valores.tipo ?? null)` en la query de duplicado contra `PHF_COMPROBANTE` no truncaba el valor antes de bindearlo (puede tener 24+ caracteres reales). Corregido con `.slice(0, 10)`, mismo patrón que ya usaba `cola.ts:135`.
4. **Task 4** — `elegirProveedor` usaba `getPool()` (conexión real) directo, y el test la llamaba sobre un comprobante insertado dentro de `conRollback` (transacción sin commitear): deadlock real, reproducido dos veces. Corregido separando en `elegirProveedorEn(e: Ejecutor, ...)` (testeable) + `elegirProveedor(...)` (wrapper de producción) — patrón que después se repitió a propósito en Task 6 (`marcarObservacionEn`/`marcarObservacion`).
5. **Task 9, Step 3** — la query de `obtenerVecinosEn` tal como estaba escrita en el plan tenía un bug real de precisión: comparar un `DATETIME2(7)` contra un valor `sql.DateTime2` reconstruido desde un `Date` de JS pierde la parte sub-milisegundo en el driver `mssql`/`tedious` (mismatch de nombre `nanosecondDelta`/`nanosecondsDelta`), así que la fila "anterior" terminaba emparejándose consigo misma en casi todas las filas reales. Reproducido en vivo contra la base real por el reviewer de esa tarea, no solo sospechado. Corregido reescribiendo la función con una sola query `LAG`/`LEAD` que calcula todo server-side sin el round-trip.

**Dato de infraestructura verificado, relevante para el punto 4:** la base tiene `READ_COMMITTED_SNAPSHOT` **activado** (`is_read_committed_snapshot_on: true`). Una **lectura** (`SELECT`) desde una conexión separada NO se bloquea contra una fila con una transacción de escritura sin commitear. La regla práctica: **escrituras** (`UPDATE`/`INSERT`/`MERGE`) desde el pool real SÍ pueden colgarse contra un `conRollback` que insertó la fila; **lecturas** (`SELECT`) no. Por eso el patrón `_En`/wrapper hace falta para escrituras testeadas contra `conRollback`, pero no para lecturas.

### Interrupciones por límite MENSUAL de gasto de la API (distinto de los límites de sesión/semanales)

Pasó varias veces durante la fase, casi siempre durante el paso de "verificación visual en navegador" al final de una task — nunca durante implementación/tests/tsc. Patrón para manejarlo si vuelve a pasar:

1. Verificar desde afuera (el controller, no el agente) que código, tests y `tsc --noEmit` están bien.
2. Commitear igual si todo lo anterior está verde.
3. Opcionalmente, reanudar el mismo agente (por `agentId`, no uno nuevo) pidiéndole solo que escriba su reporte.
4. Si la verificación visual quedó pendiente, completarla el controller mismo con herramientas de browser.
5. Si el límite bloquea directamente el *despacho* de un agente, no hay mucho margen: esperar a que se renueve el mes o que el usuario lo suba desde `claude.ai/settings/usage`.

### Convención de commits de esta fase (igual que el resto del proyecto)

Español, imperativo, terminando en `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Cuando el controller corrige un bug del plan encontrado durante la implementación, hace un commit aparte solo para el archivo del plan (no mezclado con el código).

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

**Decidir el merge de Fase 4 a `master`** — usar `superpowers:finishing-a-development-branch`. Es la única decisión pendiente ahora mismo; no hay una Fase 5 planificada todavía.

Ítems que quedaron abiertos para cuando se retome trabajo en esta área (ver también "Cosas que hay que arrastrar" más abajo):

- `CPA04.UNIDADES` es la única columna de todo el registro en Tango sin fórmula confirmada — se usa `IMPORTE_TO` como aproximación, no bloquea el registro, pero vale la pena revisarla con atención si aparece algún desvío en producción.
- El indicador de conexión (`sinConexion`) no protege contra una caída de la base **antes** de que la pantalla de revisión cargue (ver el detalle en "Fase 4: completa" más arriba) — solo contra la ventana en que se cae después de cargar y antes de tocar el botón. Si en algún momento se quiere un manejo más robusto (una pantalla de error dedicada para "sin conexión a la base" a nivel de toda la app), es trabajo nuevo, no un bug de esta fase.

Cada fase lleva su propio plan. El diseño completo está en `docs/superpowers/specs/2026-08-04-importador-facturas-tango-design.md`. La Fase 2 tuvo su propio spec: `docs/superpowers/specs/2026-08-05-fase2-importacion-extraccion-revision-design.md`. La Fase 3 tuvo el suyo: `docs/superpowers/specs/2026-08-07-fase3-validaciones-observacion-toasts-design.md`. La Fase 4 tuvo el suyo: `docs/superpowers/specs/2026-08-08-fase4-registro-tango-remitos-design.md`.

La API key de Anthropic ya está cargada en `ANTHROPIC_API_KEY`, en `D:\APP\PH_FAC\.env.local` (verificado el 2026-08-04, y de nuevo el 2026-08-06 con una extracción real).

---

## Cosas que hay que arrastrar a las fases siguientes

Las primeras dos activas salieron de la revisión final de la Fase 1; una se cerró en Fase 3. Las siguientes, de cerrar la Fase 2 (Tarea 11) — una de ellas también se cerró en Fase 3. Las últimas tres salieron de la revisión final de la Fase 3; dos de esas tres (#6 y #8) se cerraron en Fase 4. Quedan abiertas: #3, #4, #5, #7, #9. Anotarlas acá es la única forma de que no se pierdan.

### 1. Siete CUIT duplicados en `CPA01`, uno de ellos en cuatro filas — CERRADO en Fase 3

Verificado contra la base (sigue habiendo 7, confirmado de nuevo en la revisión final de Fase 3). La Fase 3 agregó el selector manual de proveedor: cuando el CUIT matchea 2+ proveedores, la app le muestra las coincidencias al operador para que elija, y esa elección (`codprovee`) ahora sí destraba la confirmación — hubo que corregir un bug Critical en el camino para que esto funcionara de punta a punta (ver la sección "Fase 3: completa" más arriba). El dato sucio en `CPA01` sigue existiendo, pero ya no es un riesgo silencioso: la app pregunta y usa la respuesta.

`buscarProveedorPorCuit` (singular, que elegía "el primero" de forma determinística) ya no tiene ningún caller de producción — quedó solo para tests. Candidato a borrar si nadie más lo necesita.

### 2. ~~El spec declara cinco lecturas de Tango y solo se implementó una~~ — CERRADO

Resuelto el 2026-08-05. Las cinco lecturas del spec §4 están implementadas y testeadas contra la base. Ver "La capa de lectura de Tango" más abajo.

### 3. La contraseña de SQL Server está en el historial de git

La saqué de todos los archivos trackeados, pero estuvo commiteada en los commits anteriores a `37d6a9b`. **No hay remoto configurado, así que nunca salió de este disco.**

Si en algún momento se publica el repo, hay que rotar la contraseña del usuario `Axoft` en SQL Server, o reescribir el historial antes de publicar. Es una decisión que queda pendiente y hay que tomarla **antes** del primer push, no después.

### 4. El costo real por comprobante no está medido sobre una muestra representativa

Un solo comprobante real disponible en `D:\CASOS\RAM - APP FAC\` (`Comprobante_147868-CLARO.pdf`, 6 páginas): la extracción tardó 18,6 s con `claude-opus-5`, 20 de 29 campos con valor y confianza promedio 94%. `extraerDePdf` (`src/server/ia/extraccion.ts`) **ya devuelve** `usage.inputTokens`/`outputTokens` (fix round de la Tarea 11, hallazgo 2), así que el dato está disponible para quien procese un comprobante; falta persistirlo en `PHF_COMPROBANTE` cuando haga falta acumularlo. Lo que sigue pendiente, y por falta de muestra, no de código: correrlo contra 4-5 comprobantes reales más para tener un promedio de costo en USD, no un solo dato. Antes de la Fase 4 (que es cuando el volumen real —20 a 100 comprobantes por día— empieza a importar en plata) conviene juntar esos PDFs y, si se decide acumular el gasto por comprobante, agregar la columna correspondiente.

### 5. `NUMERO` tiene dos convenciones distintas conviviendo en la misma columna

Descubierto armando la barra de acciones de la pantalla de revisión (Tarea 11). Los comprobantes que vienen de `pnpm seed` guardan `PHF_COMPROBANTE.NUMERO` ya combinado con el punto de venta (`"0003-00018742"`); los que vienen de una extracción real dejan `NUMERO` y `PUNTO_VENTA` por separado (`"00018742"` + `"0003"`). La bandeja (`src/components/bandeja/tabla.tsx`) ya convivía con esto mostrando `NUMERO` solo, sin combinarlo — la barra de acciones nueva sigue el mismo criterio (`formatComprobante` en `src/app/comprobantes/[id]/page.tsx`) para no duplicar el punto de venta en pantalla. Si en algún momento se unifica el formato de `NUMERO`, hay que revisar los dos lugares.

### 6. `condcompra` de texto libre a select — CERRADO en Fase 3 y Fase 4

Salió de la revisión final de la Fase 2. Resuelto en la Task 8 de Fase 3: "Condición de pago" es ahora un `<select>` poblado con `listarCondicionesCompra()`. El punto que quedaba abierto (representación unificada de "sin valor" antes de escribir `CPA04.COND_COMPR`) se resolvió en la Task 2/3 de Fase 4 con una decisión más simple que unificar las tres representaciones: `validarCondCompra` bloquea el registro directamente si `condcompra` está vacío, sin default silencioso. `codprovee` ya bloqueaba de la misma forma desde Fase 3 (el proveedor tiene que estar resuelto para confirmar).

### 7. `desnormalizarBandejaEn` trunca con `.slice()` sin avisar

Salió de la misma revisión. `TIPO`, `PUNTO_VENTA`, `NUMERO` y `CUIT` se truncan con `.slice(10)`, `.slice(20)`, etc. antes de escribirlos en `PHF_COMPROBANTE` (`src/server/app/cola.ts`), para calzar con el ancho de columna. Si la IA devuelve un valor más largo que el límite, se guarda cortado y sin ningún aviso. Hoy es un riesgo bajo porque esas columnas son solo de visualización en la bandeja (el valor completo sigue disponible en `PHF_CAMPO.VALOR_IA`/`VALOR_FINAL`), pero si alguna vez alimentan directamente la escritura en Tango, un truncado silencioso ahí sí sería un problema.

### 8. `nComp` (formato `letra + ptovta(5) + nro(8)`) solo se ejercitó en el camino de lectura — CERRADO en Fase 4

Salió de la revisión final de la Fase 3. Se usaba solo para el chequeo de duplicados contra `CPA04` (lectura); una fila real conocida (`A1326200252367`) no calza con el formato `letra + ptovta(5) + nro(8)`. Resuelto en la Task 2/3 de Fase 4: no se intentó "corregir" el formato (no hay forma de saber cuál de los dos lados está mal para esa fila puntual), sino agregar `validarFormatoNComp` como validación bloqueante antes de escribir — así un valor mal formado no se guarda truncado en Tango sin aviso, se bloquea el registro y el operador lo corrige a mano. Verificado en vivo: un comprobante real se registró con `N_COMP='A0134000147868'` (14 caracteres, formato correcto).

### 9. Sin índice en `PHF_COMPROBANTE.FECHA_ALTA`

Salió de la revisión final de la Fase 3. La navegación J/K (Task 9) y la bandeja ordenan por `FECHA_ALTA DESC, ID DESC` en cada carga. Al volumen actual no importa; a 20-100 comprobantes/día son ~25.000 filas/año. La Fase 4 no tocó `src/scripts/migrate.ts` (no hizo falta ninguna tabla ni columna nueva), así que sigue pendiente. Agregar `IX_PHF_COMP_ALTA` en la próxima migración que toque el esquema propio, no hace falta una migración solo para esto.

### 10. Registro de "liquidaciones de tarjeta" — sin implementar

Salió de la conversación del 2026-08-11 sobre percepciones. El usuario adelantó una tercera categoría de comprobante (además de "por conceptos" y "por artículos"), con su propia interpretación de IA — todavía sin definir cómo. Hoy el selector `tipoFactura` ya tiene la opción "Liquidación de tarjeta" (`valor: 'tarjeta'`), pero `validarTipoFactura` la bloquea con un mensaje explícito ("El registro de liquidaciones de tarjeta todavía no está implementado.") tanto en el panel "Listo para registrar" como dentro de `registrarComprobanteEn` — el operador puede clasificar el comprobante, pero no se puede registrar todavía. Los códigos `64` (RET IIBB BANCARIOS) y `66` (RET IIBB SIRCREB) de `CPA14` son candidatos a usarse acá cuando se implemente, según lo que dijo el usuario — no están confirmados ni verificados en contexto de una liquidación de tarjeta real, solo anotados como pista.

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

### Dos correcciones al spec — CERRADAS en Fase 4

1. ~~§9 paso 7 dice `UPDATE CTA11.FALTA_REM`~~. Corregido en la Task 10 de Fase 4: ahora dice `UPDATE STA20.CANT_FACTU/CANT_PEND` + `UPDATE STA14.ESTADO_MOV`, que es lo que el código de `registrarComprobanteEn` (`src/server/tango/comprobantes.ts`) usa en la práctica desde la Task 7.
2. ~~§266 define el remito pendiente sobre `CTA09`~~. Corregido a `STA14`: cabecera con `TCOMP_IN_S = 'RP'` y `ESTADO_MOV = 'P'`, con al menos un renglón de `STA20` con `CANT_PEND > 0`.

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
