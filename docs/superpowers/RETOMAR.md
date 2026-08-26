# Estado del proyecto

## Para retomar ahora (2026-08-26)

**Único pendiente inmediato: pushear a `origin`.** `master` está adelante de `origin/master` (todo el trabajo reciente). El `push`/`fetch` automático **no funciona desde esta sesión**: se diagnosticó con `GIT_TRACE=1` que no es un problema de red (curl a github.com responde al toque) sino que GitHub devuelve 401 y Git Credential Manager intenta abrir un prompt interactivo de login que una sesión no interactiva no puede completar -- por eso `git fetch`/`git push` cuelgan sin error, no fallan. Correr manualmente desde una terminal propia:

```bash
cd /d/APP/PH_FAC && git push origin master
```

Va a pedir loguearse en GitHub una sola vez (ventana del navegador o de Windows); después queda cacheado.

No hay ninguna rama propia ni worktree pendiente de mergear — todo el trabajo reciente se hizo directo en `master`, con el consentimiento explícito del usuario en cada caso.

**Pendiente de investigación (baja prioridad): qué hace exactamente el "pasar a contabilidad" manual real más allá de `CONTABILIZADO`.** Ver sección "Auditoría del circuito de escritura contra tablas oficiales no documentadas" más abajo — se descartó el riesgo principal que se había planteado (`p_InsertarAsientoComprobanteCompras` no es el camino cotidiano). Desde 2026-08-22 esta app graba `CONTABILIZADO='S'` directo (ver "Escritura real del asiento contable" más abajo), así que la pregunta original ("qué pasa el flag de N a S") ya no aplica -- lo que queda abierto es distinto: `LOTE_CN_GENERADO`/`LOTE_CN_GENERADO_COMPROBANTE` sí están activas en esta base (1.431/95.380 filas) y probablemente sean parte de la transferencia real a Contabilidad (`TRANSFERIDO_CN`, que esta app deja en 'N'); no se investigó qué escriben exactamente ni si el operador necesita algo de esta app para que su "pasar a contabilidad" las encuentre bien. No es bloqueante para lo que hay hoy.

**Última actualización:** 2026-08-26. **Nueva funcionalidad: botón "Vincular todos" en facturas de artículos.** Pedido directo del usuario: "en la factura de artículos agrega un botón que sea vincular todos. Su función es vincular el código de artículo de Tango con el de la factura". Ver sección "Vincular todos: asociación en lote de códigos de proveedor" más abajo para el detalle completo. Resumen: ya existía, por renglón, "Vincular con Tango" (`VincularArticulo`/`asociarArticuloProveedor`), que hace un UPSERT en `CPA15` asociando el código de artículo propio con el código impreso por el proveedor -- pedido explícito de una sesión anterior para que el emparejamiento automático de la próxima factura del mismo proveedor mejore solo. Lo nuevo es la versión en lote: un botón en el encabezado de "Renglones detectados" que hace lo mismo para todos los renglones que ya tienen los dos códigos resueltos de una sola vez, en vez de que el operador clickee renglón por renglón -- útil en facturas con muchos renglones (TOPPER llega a 48). Reusa `asociarArticuloProveedor` sin tocarlo; el paralelismo (`Promise.all`) es seguro porque esa función usa `getPool()` y no una transacción compartida (mismo razonamiento ya documentado para `asiento.ts`). Auditoría consolidada en una sola entrada con el conteo, mismo patrón que `actualizarCantidadesRemito`. **No se pudo verificar el click real contra datos en vivo**: los únicos comprobantes reales con renglones guardados (6402, 7015, 8731, 8903, 8904) ya están todos en estado `registrado`, así que el botón queda oculto por diseño (`!soloLectura`) -- se verificó en cambio que en 6402 el botón está correctamente ausente. La lógica subyacente reusa sin cambios el camino de `VincularArticulo`, que sí está probado. 517 tests en verde, `tsc --noEmit` limpio. Antes, mismo día: **nueva funcionalidad: campo "Leyenda / observación del asiento".** Pedido directo del usuario: "quiero que agregues un campo editable de una leyenda u observación. El valor puesto en ese campo debe ir en las leyendas de cada renglón del asiento". Implementación: nuevo campo `leyendaAsiento` (texto libre, no lo extrae la IA, grupo "Imputación en Tango", fila completa) que el operador carga a mano. `previsualizarAsientoEn` (`src/server/tango/asiento.ts`) lo agrega -- no lo reemplaza -- a la leyenda de cada línea ya calculada (`"${leyenda base} — ${observación}"`, truncado a 100 caracteres, el límite real de `ASIENTO_CP.DESC_LEYENDA`, para que la vista previa muestre exactamente lo que va a quedar grabado). `escribirAsientoEn` no necesitó ningún cambio propio: reusa `previsualizarAsientoEn` como siempre, así que la combinación queda en las tablas reales sin lógica duplicada. Verificado en vivo en el navegador contra un comprobante real (TOPPER 00183045): las 5 líneas de "Ver asiento" mostraron la leyenda propia más la observación cargada, el total siguió cerrando igual, y el dato de prueba se borró después de verificar (no quedó pisando el comprobante real). 4 tests nuevos en `asiento.test.ts` (agrega sin reemplazar, sin observación queda igual que antes, trunca a 100 caracteres, se graba de verdad en `ASIENTO_CP.DESC_LEYENDA`). 516 tests en verde, `tsc --noEmit` limpio. Antes, mismo día: se levantó la app (`pnpm dev`, puerto 3000 -- 3013 ya no estaba en uso) a pedido del usuario; quedó un proceso de dev server huérfano del 24/08 escuchando en el puerto 3015, no se tocó. Antes: **nueva funcionalidad: estado `existente` para facturas que ya están cargadas en Tango.** Pedido directo del usuario: "No permitas que se registre en Tango una factura que ya se encuentre registrada... pasala a una nueva pestaña que sea Comprobante existente". Ver sección "Estado `existente`: facturas que ya están en Tango" más abajo para el detalle completo. Resumen: ya existía una validación de Fase 3 que detectaba el duplicado contra `CPA04` (`buscarFacturaEnCpa04`) y lo bloqueaba recién al intentar confirmar -- lo nuevo es clasificarlo solo, apenas se importa, en un séptimo estado (`existente`) con su propia pestaña en la bandeja, en vez de dejarlo mezclado con "Pendientes" esperando que el operador note el error en rojo. `existente` es terminal e inmutable, mismo criterio que `registrado` (`guardarCampoEn` lo bloquea con el mismo no-op atómico, el formulario queda de solo lectura). Agregar un séptimo valor a `Estado` significó extender el `CHECK` de `PHF_COMPROBANTE.ESTADO` -- `migrate.ts` no tenía antes un camino para reparar un `CHECK` constraint que cambia de cuerpo (a diferencia de columnas/índices, que solo se agregan); se construyó esa capacidad (`checks`/`reemplazaA` en `Definicion`) y de paso reparó la tabla real de producción, verificado contra la base. Verificado en vivo en el navegador: la pestaña "Comprobante existente" aparece en el lugar correcto de la bandeja, con su filtro funcionando. 512 tests en verde, `tsc --noEmit` limpio. Antes, mismo día: **nueva funcionalidad: aprendizaje de la condición de compra por proveedor.** Pedido directo del usuario: "cuando se seleccione una condición de compra en Tango, [que la app] la relacione con el texto de la condición de la factura... para que en futuras facturas sea más fácil encontrar la condición adecuada". Ver sección "Aprendizaje de la condición de compra por proveedor" más abajo para el detalle completo. Resumen: la IA ahora lee `condpago` (el texto de condición de pago/venta que imprime el proveedor -- "Cuenta Corriente", "D026", "30-60-90 días" -- reusando un campo del catálogo que existía desde antes pero nunca se pedía ni se guardaba), solo en facturas de artículos (conceptos/tarjeta ya tienen la condición fija, no hay nada que ayudar a resolver ahí). Cuando el operador elige a mano la condición de compra correcta, se aprende la relación (proveedor + texto) → código de Tango, reusando el mismo mecanismo y la misma tabla `PHF_ALICUOTA_PROVEEDOR` que ya aprendía IVA/IIBB (`TipoAprendizaje` ganó un tercer valor, `'condicion'` -- la tabla lo anticipaba textualmente: "agregar un tercer tipo... no debe pedir una migración aparte"). En la próxima factura de artículos del mismo proveedor con el mismo texto, `resolverCondicionCompraEn` (en `cola.ts`, mismo patrón que `resolverProveedorEn` para el CUIT) la completa sola apenas se importa, sin que el operador tenga que elegir nada -- lo que a su vez hace que el botón "Ver cuotas" (ver sección de abajo) ya muestre los vencimientos correctos sin ninguna acción manual. Verificado visualmente en el navegador que el campo nuevo se ve bien en el formulario (fila completa, sin romper la grilla). 507 tests en verde, `tsc --noEmit` limpio. Antes, mismo día: **bug real encontrado y corregido: una fecha de factura con puntos ("30.07.2026") se grababa en Tango como la fecha de HOY, en silencio.** Se encontró verificando en vivo el comprobante 6402 (ver entrada de cuotas más abajo): `parsearFechaArg` (`src/lib/validaciones.ts`) solo reconocía `dd/mm/yyyy` con barra; con puntos devolvía `null`, y `registrarComprobanteEn` hacía `?? new Date()` -- ninguna advertencia, ningún error, la factura quedaba registrada con la fecha de emisión equivocada. Corregido: `parsearFechaArg` acepta `/`, `.` y `-`, y ahora rechaza días/meses fuera de rango en vez de reindexar en silencio (ej. "31/02" ya no se convierte en 03/03). El fallback `?? new Date()` se sacó de raíz -- `registrarComprobanteEn` falla con error claro si la fecha no se puede interpretar, en vez de adivinar (mismo criterio de "frená y preguntá" que ya regía para proveedor/condición de compra inexistentes). Nuevo ítem **"Fecha de emisión"** en "Listo para registrar" (`validarFecha`), para que el operador vea el problema antes de tocar "Registrar en Tango", no después. Alcance medido contra la base real: **6402 era el único comprobante ya registrado afectado** (era, además, el que se acababa de registrar en la misma prueba); otros 4 pendientes (5571, 6264, 7015, 8731) tenían fecha con puntos pero todavía no registrados -- ahora van a funcionar bien solos. **Corregidos a mano, en una transacción, los 5 campos de fecha que había grabado mal el comprobante 6402** (`CPA04`/`CTA05.FECHA_EMIS`/`FECHA_CONT`, `CPA46.FECHA_MOV` en sus 48 renglones, `ASIENTO_COMPROBANTE_CP.FECHA_CONTABILIZACION`, `CPA54.FECHA_VTO` en sus 4 cuotas), del 23/08/2026 (hoy, mal) al 30/07/2026 (real) -- decisión explícita del usuario vía `AskUserQuestion`, verificado después contra la base que los 5 quedaron corregidos. Los importes nunca estuvieron mal, solo las fechas. 501 tests en verde, `tsc --noEmit` limpio. Antes, mismo día: **nueva funcionalidad: cuotas reales de la cuenta corriente de proveedores (CPA54), con vista previa "Ver cuotas".** Pedido directo del usuario ("Falta crear las cuotas... busca la lógica para implementar... quiero que como en el caso del asiento tenga la posibilidad de ver antes de que generes el movimiento"). Ver sección "Cuotas de la cuenta corriente de proveedores" más abajo para el detalle completo. Resumen: `registrarComprobanteEn` ya armaba un `CPA54` por cuota desde Fase 4 (leyendo `A_VENCER`/`PORC_MONTO` de la vista `CPA49`), pero un chequeo contra la base real encontró que nunca seteaba `CPA54.ID_CPA04` -- 17.849 de 17.853 filas reales de CPA54 (99,98%) sí lo tienen, enlazado a `CPA04.ID_CPA04`; sin eso, el vencimiento de un comprobante registrado por esta app quedaba huérfano frente a cualquier pantalla o reporte de Tango que use ese vínculo. Corregido, y la lógica se extrajo a `src/server/tango/cuotas.ts` (`previsualizarCuotasEn`/`escribirCuotasEn`), mismo patrón preview+escritura que `asiento.ts`. Nuevo botón "Ver cuotas" al lado de "Ver asiento", mismo criterio de visibilidad. Verificado en vivo contra el comprobante real 6402 (TOPPER, condición "CTA CTE 90-120-150-180 DIAS"): 4 cuotas del 25% en 90/120/150/180 días, suma exacta al total ($7.615.337,98, la última cuota absorbe el redondeo). 493 tests en verde, `tsc --noEmit` limpio. Antes, mismo día: **el asiento ya queda contabilizado al grabarse (`CONTABILIZADO='S'`), no en 'N'.** Decisión explícita del usuario, instrucción directa: al insertar `ASIENTO_COMPROBANTE_CP`, `USUARIO_CONTABILIZACION='PHF_WEB'`, `FECHA_CONTABILIZACION` es la fecha de la factura (no la de hoy) y `TERMINAL_CONTABILIZACION` es el hostname real de la PC que graba (`terminalActual()`, nuevo en `src/lib/usuario.ts`, mismo patrón que `usuarioActual()`). `ASIENTO_ANULACION`/`TRANSFERIDO_CN` siguen en 'N' -- la transferencia a Contabilidad sigue siendo un proceso propio de Tango. Revierte lo que decía la sección "Escritura real del asiento contable" más abajo sobre dejar `CONTABILIZADO='N'`; el resto de esa sección (qué tablas, por qué esas dos, `IMPORTE_RENGLON_ALTER_CP`) sigue vigente. 488 tests en verde, `tsc --noEmit` limpio. Antes, mismo día: auditoría contra un documento de instrucciones de descubrimiento de esquema que pasó el usuario -- ver "Auditoría del circuito de escritura contra tablas oficiales no documentadas" más abajo. Antes: **Verificado en vivo: `registrarComprobanteEn` escribe el asiento contable real en Tango.** A pedido del usuario ("Que yo registre un comprobante real ahora mismo y te muestre el resultado"), se registró en el navegador el comprobante 4205 (AMX ARGENTINA / CLARO, factura de conceptos, $690.983,02) contra la base real. Resultado: `CPA04` (NCOMP_IN_C=17270, N_COMP=A0134000147868, COD_PROVEE=010151, IMPORTE_TO=690983.02) más un encabezado en `ASIENTO_COMPROBANTE_CP` (CONTABILIZADO='N', ASIENTO_ANULACION='N', TRANSFERIDO_CN='N', como se diseñó) y 6 renglones en `ASIENTO_CP` -- Compras 51460 débito 529.947,50; IVA 13405 débito 39.190,99 + 92.697,41; Percepción IVA 13407 débito 15.898,43; Percepción IIBB 13411 débito 13.248,69; Proveedores 20002 crédito 690.983,02 -- Debe y Haber cierran exacto en $690.983,02, `IMPORTE_RENGLON_ALTER_CP` igual al base en las 6 líneas, `EDITA_CUENTA` en 'S' solo en Compras/Proveedores. Confirma que la implementación de la sección "Escritura real del asiento contable" (abajo) funciona igual en producción que en los tests. Antes, mismo día: **`registrarComprobanteEn` ahora también escribe el asiento contable real en Tango** (`ASIENTO_COMPROBANTE_CP`/`ASIENTO_CP`), no solo lo simula -- decisión explícita del usuario que revierte lo decidido en Fase 4 (ver sección abajo, "Escritura real del asiento contable"). Antes, mismo día: bug real encontrado por reporte del usuario ("la app no está guardando/usando la relación de impuestos"): una línea de IVA con importe pero **sin porcentaje impreso** (ej. "Percepción IVA RG 2408", un total en pesos sin tasa) caía en la regla del 0% y quedaba omitida del registro en vez de resolverse -- ahora se resuelve sola al código 15, mismo criterio que el 3% ambiguo (ver sección abajo, "Línea de IVA sin porcentaje impreso"). Antes, mismo día: nueva tabla `PHF_ALICUOTA_PROVEEDOR`: aprende, por proveedor, a qué código de Tango va cada porcentaje de IVA o jurisdicción de IIBB que la app no pudo resolver sola -- el operador lo corrige una vez y la próxima factura del mismo proveedor con el mismo texto ya lo propone sola (ver sección abajo). Antes, mismo día: en liquidaciones de tarjeta, el total del comprobante ya no se toma del importe leído del resumen (sale por diferencia y no es confiable) — se calcula como subtotal + IVA + impuestos, y la revisión lo aclara explícitamente (ver sección abajo). Antes, mismo día: nuevo selector de concepto en "Listo para registrar": cuando una factura de conceptos bloquea porque el proveedor no tiene concepto asociado, el operador ya puede elegir uno del maestro de Tango (CPA45) sin salir de la app (ver sección abajo). Antes, mismo día: nuevo botón "Ver asiento" en la revisión: vista previa de solo lectura del asiento contable que Tango generaría al registrar el comprobante (ver sección abajo). También en 2026-08-20/21: "Renglones detectados" unifica el código de Tango y el código de la factura en la descripción (antes cada uno tenía columna propia y se partían en dos líneas), se agregó un subtotal de renglones con cotejo contra el neto gravado, un botón para refrescar la cantidad del remito contra Tango en vivo, y un botón para vincular el código de proveedor a un artículo en CPA15 por renglón.
**Anterior:** 2026-08-19/20. "Renglones detectados" ahora muestra, por renglón, de qué remito y qué línea de Tango salió (ver sección abajo). `buscarRemitoPorNumero` ahora tolera que el primer dígito del número de remito no coincida con lo que imprime el proveedor (ver sección abajo). 2026-08-11: la IA ya no detecta renglones en comprobantes de servicios (ver sección abajo). Agregado el tercer valor de `tipoFactura` ("Liquidación de tarjeta"), bloqueado hasta que se implemente. Restricción de percepciones de IVA/IIBB completa. Todo en `master` directamente, sin rama propia. Registro por conceptos completo e integrado a `master`. Fase 4 completa e integrada a `master`.
**Fase 3:** completa e integrada a `master`. Ver la sección "Fase 3" más abajo para el detalle.
**Fase 2:** completa e integrada. Se mergeó a `master` (fast-forward, sin conflictos) el 2026-08-06; la rama `fase-2-importacion-extraccion-revision` ya no existe (se borró después del merge). Ver la sección "Fase 2" más abajo para el detalle.

---

## Estado `existente`: facturas que ya están en Tango

Pedido directo del usuario: "No permitas que se registre en Tango una factura que ya se encuentre registrada en Tango. Debés pasarla a una nueva pestaña que sea Comprobante existente."

**Lo que ya existía:** la validación de Fase 3 (`validarComprobanteEn`) ya detectaba este caso -- `buscarFacturaEnCpa04(codProvee, nComprobante)` contra `CPA04` -- y lo mostraba como "✕ Ya existe un comprobante igual" en el panel de Validaciones, bloqueando "Confirmar datos" (`bloqueante: true`). Técnicamente ya era imposible registrar una factura duplicada por el camino normal. Lo que faltaba era exactamente lo que pidió el usuario: que no quedara mezclada en "Pendientes" esperando que el operador la abra y note el error, sino clasificada sola, aparte, con su propia pestaña.

**Diseño elegido, y por qué no el más simple:** la alternativa más liviana era reusar el estado `observacion` (que ya tiene su propia pestaña) con un motivo nuevo -- cero cambios de esquema. Se descartó porque el pedido fue explícito ("una pestaña que sea Comprobante existente", no "un motivo más dentro de En observación"), y porque semánticamente son cosas distintas: `observacion` es "hay algo que el operador tiene que corregir"; esto es "no hay nada que corregir, la factura ya está cargada". Se optó por un séptimo valor real de `Estado` (`'existente'`), con su entrada propia en `ORDEN_TABS` -- consistente con cómo ya generalizan `ESTADOS`, `BadgeEstado`, los conteos de la bandeja (`Conteos`) y el filtro (`WHERE_ESTADO`), todos ya escritos para iterar sobre cualquier `Estado` sin casos especiales.

**El costo real de esa decisión: `migrate.ts` no sabía reparar un `CHECK` constraint.** `PHF_COMPROBANTE.ESTADO` tiene `CK_PHF_COMP_ESTADO CHECK (ESTADO IN (...))`. Al agregar `'existente'` a la lista, la tabla YA EXISTENTE en producción se queda con el `CHECK` viejo -- a diferencia de una columna o un índice, que se agregan con `ALTER TABLE ADD` sin tocar lo que ya había, un `CHECK` no se puede "ampliar": hay que crear uno nuevo y tirar el viejo, porque si quedaran los dos activos SQL Server exige que la fila cumpla TODOS los `CHECK` de la columna, y el viejo seguiría rechazando `'existente'` aunque el nuevo lo permitiera. `migrate.ts` (`scripts/migrate.ts`) no tenía ningún camino para esto -- se construyó uno:
- `Definicion` ganó un campo `checks?: CheckDef[]`, con `{ nombre, ddl, reemplazaA }` -- `reemplazaA` nombra los constraints viejos que hay que dropear antes de agregar el nuevo.
- El `CHECK` del `CREATE TABLE` (para una base nueva) se renombró a `CK_PHF_COMP_ESTADO_V2` con la lista completa (siete valores).
- El camino de reparación (`checksFaltantes`, mismo patrón que `columnasFaltantes`/`indicesFaltantes`) detecta que `CK_PHF_COMP_ESTADO_V2` no existe en una tabla vieja, dropea `CK_PHF_COMP_ESTADO` si está, y agrega el nuevo -- todo en una transacción.
- **Corrió de verdad contra la base real** como efecto colateral de correr la suite de tests (`migrar()` sin prefijo pega contra las tablas de producción): se verificó después contra `sys.check_constraints` que `PHF_COMPROBANTE` ya tiene `CK_PHF_COMP_ESTADO_V2` y el viejo desapareció. No hizo falta ningún paso manual aparte.

**Implementación funcional:**
- `src/lib/estados.ts`: `Estado` gana `'existente'`, con label "Comprobante existente", su entrada en `ORDEN_TABS` (entre "Registrados" y "Con error") y `esTerminal` ahora también lo cubre (mismo criterio que `registrado`: no hay ningún paso siguiente que dar desde esta app).
- `src/server/app/cola.ts`: nueva `marcarExistenteEnTangoEn(e, id, codProvee, valores)`, mismo patrón que `resolverProveedorEn`/`observarSinConceptoEn` -- corre en la transacción de importación, justo después de `marcarLeidoEn`, reusando `buscarFacturaEnCpa04`. Si encuentra coincidencia, pasa `ESTADO='existente'` y audita, y el pipeline corta ahí: no evalúa concepto, no busca remitos, no hace la segunda pasada de renglones (todo eso sería trabajo tirado en algo que no se va a registrar).
- `src/server/app/detalle.ts`: `guardarCampoEn` extiende su freno atómico (`WHERE ESTADO NOT IN ('registrado', 'existente')`) -- antes solo cubría `registrado`.
- `src/app/comprobantes/[id]/page.tsx`: el formulario pasa a `soloLectura` también en `existente`, mismo criterio que `registrado`.
- `src/components/modal-eliminar.tsx`: aviso propio (distinto al de "ya registrado en Tango") aclarando que esta factura no la registró la app -- ya estaba cargada de antes.
- No se tocó la validación de Fase 3 existente: sigue funcionando igual para el caso residual de un duplicado *dentro de la app* (la misma factura importada dos veces, ninguna todavía en Tango) -- ese caso no se auto-clasifica como `existente` porque sería falso.

**Verificado**: tests nuevos en `cola.test.ts` (`marcarExistenteEnTangoEn`: clasifica con un `N_COMP` real de `CPA04`, no toca nada si no matchea, no hace nada sin proveedor o datos incompletos, y una vez `existente` el freno de `guardarCampoEn` corta igual que `registrado`) y en `migrate.test.ts` (repara el `CHECK` viejo, verificado que el constraint viejo desaparece y no quedan los dos activos) y en `estados.test.ts`. Verificado en vivo en el navegador: la pestaña "Comprobante existente" aparece en el orden correcto de la bandeja con su conteo, y el filtro (`?filtro=existente`) funciona sin errores. **No se verificó en vivo el flujo completo de clasificación automática** (importar una factura real que ya esté en Tango) porque hubiera requerido reimportar un PDF ya cargado -- la lógica que se ejercita en ese camino (`buscarFacturaEnCpa04`, `marcarExistenteEnTangoEn`) ya está cubierta por tests de integración contra la base real. 512 tests en verde, `tsc --noEmit` limpio.

---

## Aprendizaje de la condición de compra por proveedor

Pedido directo del usuario, en la misma sesión que pidió las cuotas (ver sección de abajo): "agrega un botón que sirva para previsualizar cómo quedan los vencimientos... [y] agrega que cuando se seleccione una condición de compra en Tango, la relacione con el texto de la condición de la factura. Esto es para que en futuras facturas sea más fácil que encuentres la condición adecuada." La primera parte (el botón de previsualizar) ya existía -- es "Ver cuotas" -- así que el trabajo real fue la segunda parte.

**Investigado antes de tocar código:** ¿existe ya un campo con el texto de la condición de pago/venta que imprime el proveedor? `condcompra` (la que elige el operador) tiene `extraePorIA: false` -- la IA nunca la lee, así que no había nada de qué aprender. Pero sí existía, dormido, un campo `condpago` en el catálogo (`campos.ts`, grupo "Proveedor"): `extraePorIA: true` pero excluido de los tres tipos vía `CAMPOS_NO_ANALIZADOS`, con un comentario que decía que salía "de la ficha del proveedor en CPA01" -- nada en el código la poblaba nunca desde ahí. Un campo scaffoldeado y nunca terminado, no uno en uso. Se decidió reusarlo en vez de crear uno nuevo con nombre parecido.

**Decisión de alcance:** `condpago` solo se pide en facturas de **artículos**. En conceptos y tarjeta, `cola.ts` ya fija `condcompra` en `COND_COMPRA_CONCEPTOS` ('2', "CONTADO 1 DIA") apenas se importan -- decisión de una sesión anterior -- así que no hay nada que el operador tenga que elegir ahí, y por lo tanto nada que ayudar a resolver. Pedirle el campo a la IA en esos dos tipos habría sido gastar cupo de schema (el límite medido es 35 campos sin renglones) en un dato que nunca se usaría.

**Implementación:**
- `src/lib/tipoFactura.ts`: `condpago` salió de `NO_ANALIZADOS_COMUNES` y entró a una exclusión nueva (`CONDICION_PAGO`) aplicada solo a conceptos y tarjeta, mismo patrón que `REMITOS` (que ya hacía exactamente esto, solo que al revés: excluido en conceptos/tarjeta, incluido en artículos). En artículos, `condpago` pasa a ocupar la fila entera de la grilla (span 6, vía `SPAN_POR_TIPO`) en vez del span 2 del catálogo -- con span 2 el grupo "Proveedor" quedaba en 14, no múltiplo de 6, y el test `en %s cada grupo suma un múltiplo de 6` (`campos.test.ts`) lo hubiera detectado.
- `src/server/ia/prompt.ts`: nuevo párrafo en la sección de artículos pidiendo el texto tal como está impreso ("Cuenta Corriente", "D026", "30-60-90 días"), aclarando explícitamente que no lo convierta a un código de Tango -- eso lo hace el sistema.
- `src/server/app/aprendizajeImpuestos.ts`: `TipoAprendizaje` ganó `'condicion'`. Reusa `PHF_ALICUOTA_PROVEEDOR` sin ninguna migración -- el comentario de esa tabla en `migrate.ts` literalmente decía "agregar un tercer tipo... no debe pedir una migración aparte", escrito antes de que existiera este pedido.
- `src/server/tango/condicionesCompra.ts`: nueva función `normalizarTextoCondicion` (sin acentos, minúsculas, espacios de más colapsados), mismo criterio que `normalizar` en `percepcionIibb.ts` para que "Cuenta Corriente" y "CUENTA  CORRIENTE" peguen en la misma fila aprendida.
- `src/server/app/cola.ts`: nueva `resolverCondicionCompraEn(e, id, codProvee, condicionTexto)`, mismo patrón que `resolverProveedorEn` (que resuelve `codprovee` por CUIT): si `condcompra` todavía está vacía y el proveedor ya enseñó ese texto, la completa sola y audita. Se llama justo después de `resolverProveedorEn` en el pipeline de importación -- en conceptos/tarjeta no hace nada porque `condcompra` ya tiene el valor fijo para cuando esto corre.
- `src/components/revision/formulario.tsx`: cuando el operador cambia `condcompra` a mano, si hay un `condpago` cargado se aprende la relación (mismo lugar donde ya se aprendían las correcciones de IVA/IIBB).

**Verificado**: tests nuevos en `aprendizajeImpuestos.test.ts` (normalización) y `cola.test.ts` (`resolverCondicionCompraEn`: completa sola, matchea con distinto casing/acentos/espacios, no pisa un valor que ya existe -- el caso conceptos/tarjeta --, no hace nada sin proveedor o sin texto). Verificado visualmente en el navegador contra el comprobante real 6402: el campo "Condición de pago" aparece en su propia fila completa en la sección Proveedor, sin romper la grilla. **No se pudo verificar el aprendizaje de punta a punta en vivo** (requeriría importar una factura nueva con el prompt actualizado; 6402 ya se había extraído con el prompt viejo, así que su `condpago` quedó vacío). 507 tests en verde, `tsc --noEmit` limpio.

---

## Cuotas de la cuenta corriente de proveedores

Pedido directo del usuario, con información propia de Tango que no estaba en el CLAUDE.md: "Tango usa la tabla CPA54 para guardar los vencimientos de las facturas. Las condiciones de venta las guarda el encabezado en la tabla CPA49 y los renglones en la tabla RENGLON_CONDICION_COMPRA."

**Lo que se confirmó investigando la base real, antes de tocar código:**
- El usuario nombró `CPA49` como el encabezado y `RENGLON_CONDICION_COMPRA` como los renglones, pero es al revés en esta versión de Tango: `CPA49` es una **vista** (no una tabla) que junta `CONDICION_COMPRA` (encabezado real, una fila por condición) con `RENGLON_CONDICION_COMPRA` (renglones reales, uno por cuota) -- confirmado con `OBJECTPROPERTY(OBJECT_ID('CPA49'), 'IsView')`. La vista ya expone exactamente `A_VENCER`/`PORC_MONTO`/`N_RENGLON` por cuota, que es lo que hacía falta. No cambia la conclusión práctica (esos son los datos correctos), pero corrige de dónde salen.
- `RENGLON_CONDICION_COMPRA` también tiene `CANT_CUOTA` (repetir la cuota N veces) y `DIA_MES` (vencer un día fijo del mes en vez de "a los N días"). Verificado contra las 69 filas reales de esta empresa: **`CANT_CUOTA` es siempre 1 y `DIA_MES` siempre `'D'`** -- ninguna condición configurada usa esas dos funcionalidades. `previsualizarCuotasEn` no las lee: agregarlas sin un caso real que las necesite sería simular algo que esta empresa no usa.
- `registrarComprobanteEn` **ya armaba un CPA54 por cuota desde Fase 4** (el pedido del usuario sonaba a "no existe", pero sí existía). Lo que se descubrió comparando contra la base real: nunca seteaba `CPA54.ID_CPA04`, la columna que enlaza el vencimiento a `CPA04`. Verificado: **17.849 de 17.853 filas reales de `CPA54` (99,98%) tienen `ID_CPA04` seteado**, igual a `CPA04.ID_CPA04`; las de esta app quedaban `NULL`, huérfanas frente a cualquier pantalla o reporte de Tango que use ese vínculo en vez de la clave natural `(T_COMP, N_COMP, COD_PROVEE)`. Es la explicación más probable de por qué el usuario percibía que "faltaban las cuotas".

**Implementación:**
- La lógica de cuotas (antes en línea dentro de `registrarComprobanteEn`) se extrajo a `src/server/tango/cuotas.ts`, mismo patrón preview+escritura que `asiento.ts`: `previsualizarCuotasEn(e, comprobanteId)` calcula (no bloquea por datos faltantes, igual que el asiento -- una condición sin elegir simplemente no arma cuotas), y `escribirCuotasEn(e, comprobanteId, codProvee, tComp, nComprobante, idCpa04)` reusa ese mismo cálculo para grabar, bloqueando si no cierra contra el total.
- La última cuota absorbe el resto del redondeo (mismo criterio que el prorrateo de renglones en `asiento.ts`): la suma de cuotas redondeadas independientemente puede quedar uno o dos centavos corta, y un vencimiento de cuenta corriente no puede diferir del total un centavo.
- `registrarComprobanteEn` ahora captura `ID_CPA04` del INSERT a `CPA04` (con `OUTPUT INSERTED.ID_CPA04 INTO @tabla` -- **no `OUTPUT` directo**, porque `CPA04` tiene triggers activos y SQL Server no permite `OUTPUT ... INTO cliente` en una tabla con triggers; hubo que corregir esto durante la implementación, lo tiraba el primer test) y se lo pasa a `escribirCuotasEn`.
- Nuevo botón "Ver cuotas" en la barra de acciones, al lado de "Ver asiento", mismo criterio de visibilidad (`leido`/`observacion`/`confirmado`). `ModalCuotas` (mismo patrón que `ModalAsiento`): carga al abrirse, muestra cuota/vencimiento/%/importe/total, avisa si no cierra.

**Verificado**: tests nuevos en `cuotas.test.ts` (arma 6 cuotas reales para "CTA CTE 30-60-90-120-150-180 DIAS" sumando exacto al total, vacío sin condición/total, rechaza si la condición no existe) y `comprobantes.test.ts` extendido para confirmar `CPA54.ID_CPA04` contra el `CPA04.ID_CPA04` real. **Verificado también en vivo, en el navegador, contra el comprobante real 6402** (TOPPER ARGENTINA, condición "CTA CTE 90-120-150-180 DIAS"): el modal mostró 4 cuotas del 25% venciendo a 90/120/150/180 días de la fecha de emisión, sumando exacto a $7.615.337,98. **493 tests en verde**, `tsc --noEmit` limpio.

---

## Auditoría del circuito de escritura contra tablas oficiales no documentadas

El usuario pasó un documento de instrucciones genérico para descubrir el esquema de Tango desde cero (diff de rowcounts, captura con Extended Events grabando una factura real desde el cliente de Tango, etc.) y pidió revisar el proceso de carga de facturas contra ese nivel de rigor. Antes de hacer la captura diferencial completa (que necesita una copia restaurada de producción y que el usuario grabe una factura desde el cliente de Tango -- fuera de lo que esta sesión puede hacer sola), se corrió la parte de solo lectura (triggers, búsqueda del generador de IDs, dependencias entre stored procedures) contra la base real para auditar lo que ya está implementado. Resultado, decidido con el usuario vía `AskUserQuestion` en cada punto de corte:

**Confirmado, sin acción pendiente:**
- `ID_ASIENTO_COMPROBANTE_CP` no es un riesgo de concurrencia: no es `IDENTITY`, tiene `DEFAULT NEXT VALUE FOR SEQUENCE_ASIENTO_COMPROBANTE_CP` -- un mecanismo atómico real de SQL Server. `escribirAsientoEn` no especifica esa columna, así que ya usa ese default correctamente.
- El uso de `MAX(NCOMP_IN_C)+1` en `comprobantes.ts` (documentado antes como "riesgo latente aceptado") resultó ser lo que hace el propio Tango: existe `Sp_AxNumeroInternoCompras`, un SP real de Axoft para alta por lotes, que calcula `NCIC = ISNULL(MAX(Ncomp_in_c), 1) FROM Cpa04`. No hay un generador dedicado por `(Company, Tabla)` para esta columna -- Tango mismo usa `MAX()+N`.
- Los triggers activos sobre `CPA04`/`CPA46` (`TR_CPA04_RG3685`, `T_CACHE_CPA04`, `Tr_C_cpa04`, `Tr_BajaComprobantesIyE`, `Tr_Cpa04_BajaCompRG3685`, `TR_CLOUD_CPA46`) no dependen de contexto de sesión de la aplicación de Tango (`CONTEXT_INFO`, tablas temporales propias) -- corren bien con un INSERT plano parametrizado como el que hace esta app. De paso, `Tr_C_cpa04` confirma algo que no se sabía con certeza: cada comprobante que esta app registra queda encolado solo para sincronización con Tango Central (tabla `tablasaenviar`), igual que si se hubiera cargado nativamente.

**Investigado a fondo y descartado como riesgo real:** existe `p_InsertarAsientoComprobanteCompras`, un SP oficial de Axoft que arma exactamente las mismas filas que `escribirAsientoEn` arma a mano en `ASIENTO_COMPROBANTE_CP`/`ASIENTO_CP`, filtrando por `CPA04.GENERA_ASIENTO = 'S'` (el default de esa columna, que esta app nunca pisa -- se confirmó en el comprobante 4205 recién registrado). Como `ASIENTO_COMPROBANTE_CP.NCOMP_IN_C` tiene índice único, en el papel esto planteaba un riesgo real: si ese SP alguna vez procesara un comprobante que esta app ya asentó, el INSERT (que es un solo `INSERT...SELECT` de conjunto, no fila por fila) podría fallar por clave duplicada y arrastrar en el fallo a otros comprobantes legítimos del mismo lote.

Se seedó la cadena de invocación real vía `sys.sql_expression_dependencies` (no adivinando nombres): `p_InsertarAsientoComprobanteCompras` ⟵ `p_InsertarAsientoComprobante` (orquesta Compras+Ventas+Tesorería+VentasResto) ⟵ `p_EjecutarMigraConversorContabilidad`, que nadie más llama desde SQL. Este último es un **conversor de un sistema contable anterior ("Astor") hacia la Contabilidad nativa de Tango**, gateado por `ACT_CNA38.CN_TANGO = 0`, y antes de reconstruir corre `p_BlanquearTablasParaContabilidadAstor`, que hace `DELETE` sin ningún filtro sobre `ASIENTO_COMPROBANTE_CP`, `ASIENTO_CP` y varias tablas más (`RENGLON_MODELO_CP`, `ASIENTO_MODELO_CP`, `CONCEPTO_CP`, `PROVEEDOR`, `CLIENTE` del módulo Contabilidad) -- borra todo, de toda la empresa, sin scope. Se verificó `ACT_CNA38.CN_TANGO = false` en esta base: el guard técnicamente no bloquea la ejecución, pero `ASIENTO_CP` ya tiene ~63.598 filas acumuladas de años de uso real -- si este conversor se disparara en el uso normal, esa historia ya se habría borrado repetidas veces, y evidentemente no pasó. Conclusión: es una herramienta de conversión de una sola vez (probablemente solo alcanzable desde un menú de utilidades específico, quizás con intervención de soporte de Axoft), no el "pasar a contabilidad" cotidiano. El riesgo de colisión es real en el papel pero prácticamente inerte en este circuito.

**Sigue abierto, sin resolver, no bloqueante:** no se encontró todavía qué proceso hace el paso manual cotidiano que el usuario corre desde Tango para pasar `ASIENTO_COMPROBANTE_CP.CONTABILIZADO` de 'N' a 'S'. Es de bajo riesgo porque por diseño de la tabla (un `UPDATE` sobre una fila que ya existe, no un re-`INSERT`) no debería competir con lo que esta app ya escribió -- pero es una inferencia, no algo verificado como el resto de esta sección. El usuario decidió no seguir indagando esto por ahora.

---

## Escritura real del asiento contable

Pedido directo del usuario: "implementa la escritura en Tango de la factura y de los asientos". La parte de "la factura" ya existía desde Fase 4; esto es sobre "los asientos" -- hasta ahora la app solo los *simulaba* (`previsualizarAsientoEn`/"Ver asiento"), por decisión explícita de Fase 4 ("el asiento contable lo genera un proceso aparte en Tango, esta app no lo toca"). Este pedido revierte esa decisión, así que antes de tocar código se investigó a fondo y se confirmaron tres cosas con el usuario vía `AskUserQuestion` (documentado acá porque cambia el riesgo del feature, no por trámite):

1. **Que de verdad quería escribir el asiento real**, entendiendo que implica tocar tablas de Contabilidad no documentadas en Compras/Stock.
2. **En qué tablas**: el usuario indicó `ASIENTO_COMPROBANTE_CP` (encabezado) y `ASIENTO_CP` (renglones) -- aclarando algo clave que no era obvio investigando solo: son tablas de *staging* que Tango lee para "pasar a contabilidad" después, **no el mayor posteado final**. Sin esa aclaración, la investigación inicial (buscando `ASIENTOS_A_IMPORTAR_TANGONET` como alternativa "seguro" -- resultó ser un blob binario propietario ilegible, sin usar) apuntaba a que escribir el asiento real requería reproducir numeración por ejercicio/período contable, mucho más riesgoso de lo que resultó ser.
3. **Qué hacer con `IMPORTE_RENGLON_ALTER_CP`**: en la base real (63.598 filas), solo 5 tienen ese valor igual al importe base -- en el resto es el importe re-expresado por el módulo de Ajuste por Inflación propio de Tango (tablas `INDICE`/`INDICE_VALOR`/`TMP_AJUSTE_INFLACION`, no investigadas a fondo). El usuario decidió grabarlo igual al importe base (sin ajuste) y dejar que el proceso de ajuste de Tango lo recalcule después, igual que con cualquier asiento cargado por fuera de ese módulo.

**Lo que se confirmó investigando la base real, antes de escribir código:**
- `ASIENTO_COMPROBANTE_CP.NCOMP_IN_C` (único, sin `TCOMP_IN_C`) enlaza directo con `CPA04.NCOMP_IN_C` del comprobante ya registrado.
- `ASIENTO_CP.EDITA_CUENTA` resultó ser **exactamente** `RENGLON_MODELO_CP.REEMPLAZA_CUENTA` -- verificado cruzando un asiento real completo (factura real de Banco Macro, FP 17039) contra el modelo: SB/EX/TO en `'S'`, IVA/percepciones/varios en `'N'`, sin excepción. No hizo falta ninguna lógica nueva: ya se resolvía en la simulación.
- La estructura de `ASIENTO_CP` (`ID_CUENTA`, `D_H`, `IMPORTE_RENGLON_BASE_CP`, `DESC_LEYENDA`) mapea casi 1:1 contra `LineaAsiento`, el tipo que ya arma `previsualizarAsientoEn`. La factura real verificada cierra exacto: Compras (14003) + IVA (13405) + Percepción IIBB (13411) = Proveedores (20002) = `CPA04.IMPORTE_TO`.

**Implementación** (`src/server/tango/asiento.ts`):
- `RenglonModelo`/`CuentaContable`/`LineaAsiento` ganan `idCuenta: number` (además de `codCuenta`) y `editaCuenta: boolean` -- `ASIENTO_CP.ID_CUENTA` necesita el ID numérico, no el código de texto.
- `escribirAsientoEn(e, comprobanteId, ncompInC, fechaFactura)`: llama a `previsualizarAsientoEn` (la MISMA función que ya usa "Ver asiento" -- preview y escritura real nunca pueden divergir, es literalmente el mismo cálculo), bloquea si `!balanceado`, arma un `INSERT` en `ASIENTO_COMPROBANTE_CP` y un `INSERT` por línea en `ASIENTO_CP`. **Actualizado 2026-08-22**: deja `CONTABILIZADO='S'` (antes 'N'), `USUARIO_CONTABILIZACION='PHF_WEB'`, `FECHA_CONTABILIZACION=fechaFactura`, `TERMINAL_CONTABILIZACION` = hostname real vía `terminalActual()` -- decisión explícita del usuario. `ASIENTO_ANULACION='N'`, `TRANSFERIDO_CN='N'` sin cambios -- la transferencia a Contabilidad sigue siendo un proceso propio de Tango.
- Se llama desde `registrarComprobanteEn` (`src/server/tango/comprobantes.ts`), como último paso dentro de la misma transacción, después de todo lo demás (CPA04/CPA18/CPA46-47/CPA54). Sin chequeo de idempotencia propio: el early-return de `registrarComprobanteEn` sobre `PHF_COMPROBANTE.TANGO_NCOMP_IN_C` ya evita que corra dos veces en el camino normal, y el índice único de `NCOMP_IN_C` en `ASIENTO_COMPROBANTE_CP` hace fallar limpio (no duplicar en silencio) si algo la llamara igual dos veces.

**CLAUDE.md**: nueva excepción explícita (2026-08-22) para `ASIENTO_COMPROBANTE_CP`/`ASIENTO_CP`, esta vez de lectura **y escritura** -- distinta de la excepción de solo-lectura de Fase 4/asiento-preview. De paso se completó la lista de esa excepción anterior con `RENGLON_MODELO_CP`, `CONCEPTO_CP` y `ARTICULO_CUENTA`, que ya se usaban pero habían quedado afuera del texto.

**Un desvío real encontrado corriendo los tests, no en revisión de código**: al hacer obligatorio el armado del asiento dentro de `registrarComprobanteEn`, tres tests preexistentes (fixtures mínimos para probar idempotencia/remito/etc., sin `neto` o con un `total` que no correspondía a la suma real) empezaron a fallar con "el asiento no cierra". Ninguno era un bug de la funcionalidad nueva: eran fixtures de prueba con importes que nunca habían tenido que cerrar contablemente porque nada los exigía antes. Corregidos los tres (uno tenía directamente un error de tipeo en el importe, `10.147.092,39` en vez de `157.092,39`).

**Verificado**: tests nuevos en `asiento.test.ts` (arma encabezado+renglones, rechaza si no cierra, no escribe nada sin líneas) y un test de integración en `comprobantes.test.ts` que registra un comprobante real de punta a punta y confirma el asiento completo contra `CPA04`. **488 tests en verde**, `tsc --noEmit` limpio. **Verificado también en vivo, en el navegador, contra la base real** (2026-08-22, a pedido del usuario): comprobante 4205 (AMX ARGENTINA/CLARO, $690.983,02) confirmado y registrado desde la UI real; `CPA04`/`ASIENTO_COMPROBANTE_CP`/`ASIENTO_CP` quedaron exactamente como predecía la vista previa -- 6 renglones, Debe=Haber=$690.983,02, `CONTABILIZADO='N'` (pendiente de que el usuario lo pase a contabilidad desde el propio Tango). Detalle completo en la entrada de "Última actualización" arriba.

---

## Línea de IVA sin porcentaje impreso: se resuelve sola, no se omite

Bug real, encontrado investigando el reporte del usuario "la app no está guardando la relación de los impuestos del proveedor con los de Tango, o no está usando esta relación al cargar un nuevo comprobante" (sobre la tabla de aprendizaje de la sección de abajo).

**Diagnóstico**: la tabla `PHF_ALICUOTA_PROVEEDOR` estaba vacía, pero SÍ había una corrección manual real en la base (comprobante 10643, Banco Macro, resumen NaranjaX/VISA): `codiva3 = '16'`. Leyendo el PDF real, esa línea es **"Percepción IVA RG 2408"**, con un importe ($ 147.092,39) pero **sin ningún porcentaje impreso en ningún lado del comprobante** -- a diferencia de las alícuotas de IVA reales, que sí traen "Tasa 21,00%"/"Tasa 10,50%" explícitas. `resolverAlicuotas` (`src/lib/alicuotas.ts`) usaba `parsearImporte`, que no distingue "" de "0" (las dos dan `0`), así que esta línea caía en la regla de "alícuota 0% no se registra" -- **no era que la app no aprendiera el ajuste, era que la línea nunca llegaba a registrarse en absoluto salvo que el operador la corrigiera a mano cada vez**, y por eso tampoco había nada que aprender (mi lógica de aprendizaje solo graba cuando hay un porcentaje que usar como clave).

**Decisión con el usuario** (`AskUserQuestion`, opción recomendada): cuando un slot de IVA tiene importe pero el porcentaje está genuinamente ausente (no es "0", es que no hay dato), se resuelve automáticamente al código preferido (15), mismo criterio que ya usa el proyecto para el 3% ambiguo entre 15 y 16 ("siempre 15, sin selector"). No hace falta que el operador corrija nada, y por lo tanto tampoco hace falta aprender nada por proveedor para este caso -- se volvió una regla general, no una excepción por proveedor.

**Implementación**: se cambió `parsearImporte` por `parsearImporteONulo` (que sí preserva la diferencia entre "" y "0") al leer `porcivaN` en `resolverAlicuotas`, y se agregó una rama nueva antes de la regla del 0%: sin porcentaje leído, resuelve directo a `CODIGO_IVA_PREFERIDO` con el porcentaje que ESE código tiene en Tango (CPA14, no un valor inventado). Mismo fix espejado en `CeldaAlicuotaTango` (`alicuota-tango.tsx`) para que la celda de la revisión muestre el código resuelto en vez de un "—" neutro que no avisaba de nada.

**Verificado**: 5 tests nuevos (`alicuotas.test.ts`, incluido un caso que replica los números reales de RG 2408) más un test de integración en `comprobantes.test.ts` que registra de punta a punta una línea sin porcentaje y confirma `COD_IVA1=15` en `CPA04` real. **No se verificó en vivo en el navegador**: el único comprobante real con este patrón hoy en la base ya tiene la corrección manual del operador guardada (`codiva3='16'`), así que no hay forma de ver el auto-resuelve sin mutar ese dato real o reprocesar el comprobante -- ninguna de las dos se hizo sin pedir permiso primero.

Suite completa: **485 tests en verde**, `tsc --noEmit` limpio.

---

## Tabla de aprendizaje por proveedor: `PHF_ALICUOTA_PROVEEDOR`

Pedido directo del usuario: "implementá una tabla en la que guardes la relación entre las alícuotas de IVA e impuestos utilizados por un proveedor... cuando un impuesto detectado en la factura no tenga su correspondiente en Tango, el usuario debe elegir la correcta en Tango y esto debe quedar grabado en la tabla". Antes de implementar se acordaron tres decisiones de diseño con el usuario (`AskUserQuestion`, las tres opciones recomendadas):

1. **Alcance**: IVA + Percepciones IIBB ahora; impuestos varios queda para una segunda etapa -- hoy la IA no captura un texto propio para esas líneas (solo el código que ya elige el operador de una lista), así que no hay "cómo lo escribe la factura" que aprender todavía.
2. **Auto-sugerencia, no solo registro**: igual que `CPA15` con los artículos, la próxima factura del mismo proveedor con el mismo texto propone sola el código aprendido, en vez de quedar solo como un log de auditoría.
3. **Por proveedor, no global**: mismo criterio que `CPA15`.

**`scripts/migrate.ts`**, tabla nueva `PHF_ALICUOTA_PROVEEDOR` (`COD_PROVEE`, `TIPO` 'iva'/'percepcion', `DESCRIPCION`, `COD_TANGO`, únique en `(COD_PROVEE, TIPO, DESCRIPCION)`). `DESCRIPCION` se guarda ya normalizada (el porcentaje como número canónico para IVA, la jurisdicción sin acentos/mayúsculas para IIBB) -- no la grafía exacta de esa factura puntual -- para que dos facturas del mismo proveedor con distinto casing/acentuación sigan pegando en la misma fila.

**`src/server/app/aprendizajeImpuestos.ts`** (módulo nuevo, patrón `_En`/wrapper como el resto de las tablas `PHF_*`): `aprenderImpuestoEn` (MERGE por proveedor+tipo+texto: una segunda corrección reemplaza a la primera) y `cargarAprendidosEn` (todo lo aprendido de un proveedor+tipo, como `Record<string,string>` -- no `Map`, porque cruza la frontera server/client component y los props de un Server Component no admiten `Map`).

**Resolución**: `resolverCodigoIva` (`src/lib/alicuotas.ts`) y `resolverPercepcionIibb`/`resolverIibbPorTipo` (`src/lib/percepcionIibb.ts`) ganan un parámetro `aprendidos?: Record<string,string>`, consultado **último** -- nunca antes que la resolución normal por porcentaje/jurisdicción, para que lo aprendido no pueda pisar un dato que ya resuelve solo. Las tres funciones que lo usan (`validarListoParaRegistrarEn`, `registrarComprobanteEn`, `previsualizarAsientoEn`) lo cargan de la misma fuente, para que el panel, el registro real y la vista previa del asiento nunca puedan resolver distinto.

**Escritura**: en `formulario.tsx`, cuando el operador completa `codivaN`/`codpercepN` (la corrección manual de esas celdas), se llama a `aprenderImpuestoTango` (nueva server action) además del `guardarCampo` normal. A propósito sin `revalidatePath`: se dispara en cada corrección, como el autosave, y forzar un refresh interrumpiría al operador si está editando otro campo -- la celda ya refleja el código elegido con el estado local del formulario.

**Un bug real, encontrado corriendo la suite de tests (no en revisión de código):** las primeras versiones de `previsualizarAsientoEn`/`registrarComprobanteEn`/`validarListoParaRegistrarEn` cargaban `aprendidosIva`/`aprendidosPercepcion` con `Promise.all([cargarAprendidosEn(e,...), cargarAprendidosEn(e,...)])` -- dos pedidos concurrentes sobre la **misma** `sql.Transaction`. `mssql` no admite eso: cuelga la conexión en vez de fallar, y arrastra a cualquier otra transacción que espere un lock de la misma sesión. Se reprodujo en vivo (la suite completa quedó colgada más de diez minutos, con sesiones bloqueándose en cadena vistas por `sys.dm_exec_requests`) y se corrigió a dos `await` secuenciales en los tres sitios. Quedó documentado en un comentario en cada uno para que nadie lo vuelva a paralelizar "por prolijidad".

**Otro hallazgo del mismo pase, más chico:** el guard de `aprenderImpuestoEn` contra una descripción vacía miraba el valor ya normalizado, y `parsearImporte('')` da `0` -- `String(0)` es `"0"`, un string no vacío que pasaba el chequeo. Corregido para mirar la descripción cruda antes de normalizar.

**Segundo hallazgo, en `tests/scripts/migrate.test.ts`:** el test tenía DOS listas de nombres de tabla hardcodeadas para la limpieza post-test (`limpiarPrefijo` y el `afterAll` de "ejercitando el CREATE de verdad"), ninguna de las dos actualizada al agregar la tabla nueva -- dejaban `PHF_test..._ALICUOTA_PROVEEDOR` huérfanas en la base real cada corrida. Corregidas las dos listas; se limpiaron a mano las ~15 tablas huérfanas que ya habían quedado de las corridas de este mismo pase.

**Verificado en vivo, con un límite real:** se probó extremo a extremo con un test de integración (`comprobantes.test.ts`) que fuerza un porcentaje de IVA que Tango no tiene ("5%"), aprende el código con `aprenderImpuestoEn` dentro de la misma transacción, y confirma que `registrarComprobanteEn` lo resuelve y graba igual que si el porcentaje matcheara solo. **No se probó el flujo de corrección a mano en el navegador**: el clasificador de permisos del entorno bloqueó la mutación temporal de un comprobante real para armar el escenario (mismo criterio que "no se probó el guardado real" del selector de concepto -- no hay hoy ningún caso real de porcentaje o jurisdicción sin resolver en la base para probarlo sin fabricar uno). Sí se verificó en el navegador, sin mutar nada, que el comprobante real 10038 (Tarjeta Naranja) sigue renderizando bien todas las celdas "En Tango" después del cambio.

Suite completa: **480 tests en verde**, `tsc --noEmit` limpio.

---

## En tarjeta, el total del comprobante se calcula, no se lee

Pedido directo del usuario: "en el caso de los resúmenes de tarjetas de crédito, el total del comprobante surge por diferencia [...] debés sumar el subtotal (monto del concepto), el IVA y los impuestos y con eso forma el total [...] tenés que aclararlo en el momento de la revisión que el monto sale desde ahí." El total impreso en un resumen de tarjeta arrastra saldo anterior, pagos e intereses que la app no captura, así que no sirve como total del comprobante -- a diferencia de una factura normal, donde el total impreso sí es el dato correcto.

**El cálculo ya existía**: `totalImputado` (`src/lib/formato.ts`) suma exactamente neto + exento + IVA + percepciones + impuestos varios -- ya alimentaba el campo "Total imputado" del formulario y la comparación de `validarTotales`. Lo que faltaba era que, para tarjeta, ese cálculo fuera el que de verdad se graba y se muestra, en vez de solo una referencia al lado del importe leído.

Tres puntos, todos con el mismo criterio (para no poder divergir entre sí):

- **`registrarComprobanteEn`** (`src/server/tango/comprobantes.ts`): el `total` que va a `CPA04.IMPORTE_TO`, `CTA05.IMPORTE_TO` y al cálculo del vencimiento (`CPA54`) es `totalImputado(valores)` cuando `tipoFactura === 'tarjeta'`, no `parsearImporte(valores.total)` como en los demás tipos.
- **`previsualizarAsientoEn`** (`src/server/tango/asiento.ts`): la línea "Total del comprobante" (Haber, cuenta del modelo) usa la misma función y el mismo criterio, así la vista previa nunca puede mostrar un total distinto del que se graba.
- **`validarTotales`** (`src/lib/validaciones.ts`), gana un segundo parámetro `tipoFactura`: en tarjeta ya no compara contra el importe leído (esa diferencia es esperada, no un error) -- siempre da "ok" mostrando el total calculado con su fórmula: *"Total del comprobante: $ X (subtotal + IVA + impuestos -- no el importe leído del resumen, que sale por diferencia)."* Esto es lo que "aclara en el momento de la revisión" que pidió el usuario: aparece en el panel "Validaciones", que el operador ya lee para cada comprobante.

**Verificado en vivo** contra el único comprobante real de tipo tarjeta hoy en la base (10038, TARJETA NARANJA S.A.U., resumen NaranjaX real de 8 páginas): el panel de Validaciones muestra el mensaje con el total calculado ($ 14.849.964,79), y "Ver asiento" muestra exactamente el mismo importe en la línea de Haber -- confirmado que ambos caminos nunca pueden divergir, porque comparten la misma función. Tests nuevos en los tres archivos, forzando a propósito un "total" leído muy distinto del calculado (para no depender de que coincidan por casualidad, como sí coincidía el fixture de test preexistente).

Suite completa: **463 tests en verde**, `tsc --noEmit` limpio.

---

## Selector de concepto para el proveedor sin uno en Tango

Pedido directo del usuario: en las facturas de conceptos, cuando el proveedor no tiene un concepto asociado (`CPA_CONCEPTOS_PROVEEDOR` sin fila para ese `COD_PROVEE`), la app bloqueaba el registro con un mensaje pidiendo cargarlo a mano en Tango. Antes de este cambio, según lo que ya dejó documentado "Registro por conceptos" (más abajo), esto pasaba con casi todos los proveedores: solo uno tenía concepto cargado en toda la base. Implementado directo, sin spec/plan formal (pedido acotado y sin ambigüedad de registración: el usuario ya especificó qué mostrar -- `COD_CONCEP`/`DESC_CONCE` de CPA45 -- y dónde se guarda la relación).

**`src/server/tango/conceptos.ts`**, dos funciones nuevas:
- `listarConceptos()`: todo el maestro CPA45 (89 filas hoy, ninguna inhabilitada), solo código y descripción, ordenado por descripción.
- `asignarConceptoProveedor(codProvee, codConcepto)`: `MERGE` sobre `CPA_CONCEPTOS_PROVEEDOR`, con `ID_CPA45`/`ID_CPA01` resueltos por subquery -- mismo patrón que `asociarArticuloProveedor` (CPA15) de la Task de renglones. La clave del `MERGE` es `COD_PROVEE` solo, no `(COD_PROVEE, COD_CONCEPT)` como permitiría el índice único de la tabla: la app entera asume 1:1 por proveedor (`buscarConceptoProveedor` no tiene `ORDER BY`/`TOP`), así que un segundo concepto reemplaza al primero en vez de dejar una fila ambigua.

**Server actions** (`src/server/app/acciones.ts`): `listarConceptosTango()` y `asignarConcepto(comprobanteId, codProvee, codConcepto, descripcion)` -- esta última escribe la relación, audita, y hace `revalidatePath`. No toca `ESTADO`/`MOTIVO_OBSERVACION` del comprobante, mismo criterio que `elegirProveedor`: el operador sigue el flujo normal (confirmar) para salir de observación.

**UI**: `SelectorConcepto` (nuevo componente, mismo lenguaje visual que `SelectorProveedor`) aparece dentro de "Listo para registrar" cuando el ítem de concepto está en error Y `tipoFactura === 'conceptos'` (no en `'tarjeta'`: ese concepto es fijo y no depende del proveedor). A diferencia de `SelectorArticulo` (que busca contra STA11 por SQL en cada letra), acá el maestro completo se trae una sola vez al montar y se filtra en el cliente -- a 89 filas no hace falta el vaivén al servidor.

**Test de escritura, mismo criterio que `asociarArticuloProveedor`**: `asignarConceptoProveedor` escribe con `getPool()` directo, sin executor inyectable, porque es una escritura sobre dato maestro del ERP (no un rollback de comprobante propio). El test no llama a la función real -- comitearía de verdad --, replica el `MERGE` dentro de `conRollback` contra un proveedor real sin concepto, descubierto en runtime.

**Verificado en vivo** contra el comprobante real 4792 (SUPERMERCADOS MAYORISTAS MAKRO S.A., proveedor `010698`, en observación por `MOTIVO_SIN_CONCEPTO`): el panel "Listo para registrar" muestra el buscador bajo el ítem en rojo, y tipear "telefon" filtra correctamente a "712 · TELEFONOS LOCALES". **No se probó el guardado real** (el click que dispara `asignarConcepto`): asociar un concepto a un proveedor real es una decisión de registración contable, y el usuario pidió que esas se consulten en vez de decidirlas en una verificación. La lógica de escritura sí quedó verificada por separado (test de arriba, contra el schema y datos reales). Pendiente: que el usuario pruebe la primera asignación real, o autorice hacerla en su nombre.

Suite completa: **460 tests en verde**, `tsc --noEmit` limpio.

---

## Vista previa del asiento contable ("Ver asiento")

Pedido directo del usuario: quería ver, durante la revisión, qué asiento contable generaría Tango al registrar el comprobante. Spec: `docs/superpowers/specs/2026-08-21-vista-previa-asiento-contable-design.md`. Plan: `docs/superpowers/plans/2026-08-21-vista-previa-asiento-contable.md`, ejecutado con `superpowers:subagent-driven-development` (7 tareas, un fix round en la Task 2, más un fix round de la revisión final de rama completa). **455 tests en verde**, `tsc --noEmit` limpio.

**Revisión final de rama completa** (modelo `opus`, sobre los 8 commits de la feature): sin hallazgos Critical, 3 Important + 7 Minor, aprobada igual ("ready to merge, con fixes como seguimiento") pero el controller decidió aplicarlos todos en un fix wave antes de dar la feature por cerrada, no dejarlos como deuda:
1. **El armado de "Subtotal gravado" para facturas de artículos con más de una cuenta distinta sumaba `IMPORTE_IA` crudo de los renglones en vez de prorratear el `neto` de cabecera** — podía marcar "el asiento no cierra" en una factura que en realidad estaba bien, porque la suma de renglones no siempre coincide centavo a centavo con el neto (la propia tarjeta de renglones ya expone y tolera esa diferencia). Corregido: se prorratea `neto` entre las cuentas, con el resto del redondeo en el último grupo.
2. **Faltaban tests de las tres ramas más complejas** (multi-cuenta, fallback a la cuenta del modelo cuando el artículo no tiene `ARTICULO_CUENTA`, la línea de exento). Agregados los tres, con artículos reales (`106817`→cuenta `14003`, `474575`→cuenta `14007`).
3. **Una línea de impuesto sin código de Tango resuelto (jurisdicción no reconocida, código elegido que ya no existe) desaparecía sin aviso**, y el mensaje de "no cierra" le echaba la culpa a los importes cuando el problema era otro. Se agregó `AsientoPreview.lineasOmitidas` (cuenta cuántas líneas se omitieron por esto) y el modal distingue los dos casos en el aviso. De paso se corrigió una contradicción real entre dos secciones del spec (una decía que esas líneas se muestran, otra que se omiten — el código siempre hizo lo segundo, que es lo correcto).
4. Minor: `RENGLON_MODELO_CP.REEMPLAZA_CUENTA` se leía pero no se usaba — ahora el reemplazo de cuenta de Subtotal gravado/exento respeta la bandera en vez de aplicarse siempre.
5. Minor: ancho de columna (`VarChar(20)`→`VarChar(15)`) para que coincida con `ARTICULO_CUENTA.COD_STA11` real, mismo criterio que ya usa `articulos.ts`.
6. Minor: import sin usar en el test.
7. Minor: `codigoFinal ?? codigo` → `codigoFinal?.trim() || codigo?.trim()`, mismo criterio que ya usa `registrarComprobanteEn` para no dejar que una corrección vacía gane por sobre un código válido.

**Desvío no pedido, encontrado al escribir el test de multi-cuenta:** `insertarRenglonPrueba` (`src/server/app/comprobantes.ts`, helper de test compartido por toda la suite) tenía `ORDEN` fijo en `1` — rompía al insertar un segundo renglón para el mismo comprobante (viola `UQ_PHF_RENGLON`). Corregido a `ISNULL(MAX(ORDEN),0)+1`. Queda un hueco Minor parqueado a propósito: el cálculo no es atómico (sin `HOLDLOCK`), pero ningún test del repo inserta renglones en paralelo para el mismo comprobante, así que agregar locking ahí sería sobre-ingeniería para un problema que no existe hoy.

**Módulo nuevo de solo lectura** (`src/server/tango/asiento.ts`): simula el motor de asientos de Tango combinando `RENGLON_MODELO_CP`/`TIPO_CONTABLE`/`CUENTA` (el modelo `ID_ASIENTO_MODELO_CP=1`, "FACTURAS / NOTAS DE DEBITO") con `CONCEPTO_CP`/`ARTICULO_CUENTA` (para el reemplazo de cuenta del subtotal). No escribe nada — ni en `PHF_*` ni en el ERP; el asiento real lo sigue generando un proceso aparte de Tango cuando contabiliza (`CONTABILIZ` sigue en 0 después de registrar, decisión de Fase 4 que no cambió).

**El hallazgo que simplificó todo:** los códigos de `TIPO_CONTABLE.COD_TIPO_CONTABLE` para IVA (`1`-`4`) y percepción IIBB (`60`,`61`,`62`,`68`, entre otros) son los MISMOS códigos de `CPA14` que ya usan `porciva1..5`/`percep1..4` en el formulario. `previsualizarAsientoEn` reutiliza sin modificar `resolverAlicuotas`/`resolverPercepciones`/`resolverVarios` (las mismas funciones que ya usa `registrarComprobanteEn`), así que la vista previa no puede divergir del registro real — solo cambia el destino (líneas de asiento en vez de `INSERT`s en `CPA04`/`CPA18`/`CPA63`).

**Excepción a la regla de tablas documentadas**, ya reflejada en `CLAUDE.md`: `TIPO_CONTABLE`, `CUENTA` y `ASIENTO_MODELO_CP` no figuran en la documentación de Axoft para Compras ni Stock (se revisó también Contabilidad, Procesos generales y Administrador) — son tablas de configuración real del motor contable, no espejos `CTA*`, y quedaron autorizadas de solo lectura por decisión explícita del usuario.

**Decisiones de scope tomadas con el usuario durante el brainstorming:**
- Subtotal exento va a la MISMA cuenta que el gravado (no hay split propio, la app no distingue renglones exentos de gravados).
- Si dos renglones de artículos resuelven a cuentas distintas (raro: 1/9.060 en la base real), se agrupan y se emite una línea de Debe por cada cuenta distinta.
- Flete/Intereses/Bonificación (`FL`/`IN`/`BO` en el modelo) se omiten: la app no los captura como campo de cabecera.
- La cuenta de "Total del comprobante" (Haber) siempre es la del modelo (20002 · PROVEEDORES) — no se encontró una tabla que vincule proveedor a una cuenta corriente específica.

**Un desvío real encontrado en el fix loop (Task 2):** el brief original ensanchaba `VarChar(3)` a `VarChar(20)` en `cuentaDelConcepto` para acomodar un fixture de test mal elegido (`'999999'`, copiado de otro brief donde la columna real era más ancha). `CPA45.COD_CONCEP` es de 3 caracteres reales — corregido a `VarChar(3)` con el fixture del test ajustado a `'999'`, sin tocar el ancho de producción.

**Verificado en vivo contra dos comprobantes reales**, sin usar datos de prueba:
- Comprobante `8731` (TOPPER, factura de artículos, talles L/M/S/XL): Subtotal gravado a la cuenta `14007 · COMPRAS MERC. DEPORT.` (la cuenta específica del artículo, no la 14003 del modelo) por $238.072,11; IVA 21% a `13405`; dos percepciones IIBB (Tucumán y Salta) a `13411`; Total a `20002 · PROVEEDORES` por $298.304,36. **Balanceado**: Debe = Haber = $298.304,36.
- Comprobante `4205` (AMX/Claro, proveedor `010151`, factura de conceptos): Subtotal gravado a `51460 · TELEFONOS LOCALES` (la cuenta del concepto `712`, no la 14003 del modelo) por $529.947,50; IVA 21% y 27% combinados correctamente (dos líneas, misma cuenta `13405`, distinto código); percepción R.G.3337 y percepción IIBB Tucumán. **Balanceado**: Debe = Haber = $690.983,02.

Confirma que el reemplazo de cuenta por concepto/artículo funciona con datos reales (no solo en los tests de `conRollback`), que el asiento cierra en los dos caminos de negocio (conceptos y artículos), y que dos alícuotas de IVA que comparten cuenta se muestran como líneas separadas, no fusionadas.

El botón "Ver asiento" vive en la barra de acciones, visible en `leido`/`observacion`/`confirmado` (no depende de que las validaciones estén en verde — es justamente para revisar antes de eso). Reusa el estilo `.verAsiento` ya existente del botón deshabilitado "Ver asiento en Tango" del estado `registrado` (ese sigue sin funcionalidad, decisión de Fase 4 que no cambió): nunca se muestran los dos a la vez.

---

## "Renglones detectados" muestra el remito y la línea de Tango de origen

Pedido del usuario tras ver el bloque "Renglones detectados" (que **ya venía de Tango**, no de la IA — ver la sección anterior) y el bloque separado "Remitos pendientes" mostrando esencialmente lo mismo por separado, sin forma directa de saber a simple vista de qué remito salió cada renglón sin cruzarlos a mano. Eligió, de dos opciones ofrecidas, mostrar por cada renglón su remito y N° de línea de Tango directamente en la tarjeta "Renglones detectados" (`src/components/revision/renglones.tsx`), en vez de una relectura en vivo contra Tango antes de confirmar.

Columna nueva `PHF_RENGLON.REMITO_NUMERO` (`scripts/migrate.ts`, camino de reparación de columna): guarda el número impreso del remito (`N_COMP`, ej. `"R0502600531798"`), separado de `REMITO_NCOMP_IN_S` (el código interno, que sigue siendo la clave real para el join contra STA20/STA14 al registrar). Se decidió guardarlo en vez de recalcularlo en pantalla contra `buscarRemitosPendientes`: un remito que se consume del todo desaparece de esa lista, así que una vez registrado el comprobante el dato quedaría huérfano si no estuviera guardado.

Se escribe en dos caminos:
- **Automático** (`cargarRenglonesDeRemitosEn`, `src/server/app/cola.ts`): ya tenía `r.remito.numero` en memoria al insertar `PHF_RENGLON`, solo hubo que sumarlo al INSERT.
- **Manual** (`asignarRemitoEn`/`asignarRemito`, `src/server/app/acciones.ts`): el panel "Remitos pendientes" (`remitos-pendientes.tsx`) ya tenía el número impreso disponible en el prop `remitos` (viene de `buscarRemitosPendientes`), así que se lo pasa como tercer valor codificado en el `<option>` en vez de agregar una consulta nueva a Tango.

**Backfill:** los 48 renglones del único comprobante real con remito ya asignado antes de este cambio (6402, TOPPER) se completaron con un script puntual dentro de `src/server/tango/` (respeta la frontera del proyecto: solo ese módulo consulta STA14) y se borró después de correrlo.

**Verificado en vivo con Playwright** contra el comprobante real 6402: cada renglón de la tarjeta ahora muestra "Remito R0502600531798 · renglón N" en una segunda línea bajo la descripción, en IBM Plex Mono, `--texto-4`.

Suite completa: **398 tests en verde**, `tsc --noEmit` limpio.

---

## `buscarRemitoPorNumero` tolera el primer dígito del número

Pedido directo del usuario tras ver el comprobante real 6264 (TOPPER ARGENTINA S.A.) en observación con "Remito sin saldo o inexistente" pese a que el remito **sí existe** en Tango. El PDF imprime "Remito/Factura Nº: 5026-00530766" (verificado leyendo el PDF directamente, texto y render coinciden) pero Tango lo tiene guardado como `N_COMP = "R0502610530766"` — idéntico salvo el primer dígito del número (`0` vs `1`), con el punto de venta y los siete dígitos restantes exactamente iguales.

`normalizarNumeroRemito` (`src/server/tango/remitos.ts`) cambió de contrato: ya no arma el string completo de 14 caracteres, devuelve `{ ptovta, numero }` por separado — el único consumidor era `buscarRemitoPorNumero`, así que no hay otros callers que romper. `buscarRemitoPorNumero` arma un patrón `LIKE` con `_` (comodín de un carácter SQL) en el primer dígito del número, y ordena los resultados prefiriendo el match exacto si existe más de uno. La eliminación de guiones ya la hacía el regex existente al usarlos como separador; no hizo falta agregar nada para eso.

**Verificado en vivo, sin usar el navegador:** `buscarRemitoPorNumero('010685', '5026-00530766')` pasó de `{ estado: 'no-existe' }` a `{ estado: 'sin-saldo' }` — el remito real está facturado por completo (`ESTADO_MOV = 'F'`), así que "sin saldo" es la clasificación correcta, distinta de "no existe". Reprocesado el comprobante 6264 real de punta a punta (con reintento: la primera pasada de extracción con IA no volvió a leer `remito1`, no determinístico y sin relación con este cambio): la observación ahora dice "Remito 5026-00530766 ya está facturado por completo en Tango: no queda mercadería pendiente para asociar." — correcto y distinto del mensaje anterior, que insinuaba un número mal leído.

Suite completa: **398 tests en verde**, `tsc --noEmit` limpio.

---

## La IA no detecta renglones en comprobantes de servicios

Pedido directo del usuario, mismo día que lo de arriba: "en las facturas de conceptos no es necesario detectar renglones". El problema real es de orden — la extracción con IA corre al importar el PDF, **antes** de que el operador elija `tipoFactura` en la revisión, así que la app no puede filtrar por tipo de antemano. El usuario eligió, sabiendo el riesgo, que sea la propia IA la que decida: `PROMPT_EXTRACCION` (`src/server/ia/prompt.ts`, regla 6 nueva) le dice a Claude que si el comprobante es de un proveedor de servicios (telefonía, luz, gas, seguros, alquiler, honorarios, publicidad, gastos bancarios, etc. — no mercadería para la venta), devuelva los renglones vacíos aunque el PDF liste sub-ítems (líneas telefónicas, planes, consumos), porque esos detalles no se usan para ese tipo de comprobante.

**Riesgo aceptado explícitamente:** si Claude clasifica mal un comprobante (lo confunde con servicio cuando en realidad es mercadería atada a un remito), se pierden renglones reales que hacían falta para la ruta "por artículos" (`CPA46`). No hay una verificación automática de esto — si aparece un caso así en producción, es candidato a revisar el prompt o a mover el corte de "no detectar renglones" a después de que el operador clasifique (la alternativa más segura que se descartó esta vez).

**Verificado en vivo:** la factura real de AMX/Claro (`Comprobante_147868-CLARO.pdf`), que antes traía ~20 renglones (líneas de plan telefónico), ahora devuelve `renglones: []` — sin afectar el resto de la extracción (`codpercibb` siguió sugiriendo `60` con 93% de confianza).

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
