# Fase 3 — Validaciones, observación, toasts y atajos

**Fecha:** 2026-08-07
**Estado:** aprobado, pendiente de plan de implementación
**Depende de:** `2026-08-04-importador-facturas-tango-design.md` (diseño general), `2026-08-05-fase2-importacion-extraccion-revision-design.md`, Fase 2 integrada en `master`

---

## 1. Qué se construye

Todo lo que decide si un comprobante `leido` está listo para confirmarse, y qué hacer cuando no lo está:

- Las 4 validaciones del spec general §8, calculadas server-side y mostradas en un panel nuevo de la pantalla de revisión.
- Resolución manual de proveedor cuando el CUIT no matchea ningún proveedor de Tango, o matchea más de uno.
- El modal "Marcar en observación", con sus 5 motivos de lista cerrada.
- Un sistema de toasts genérico, reusable en esta fase y las que siguen.
- Atajos de teclado: `Ctrl+Enter` confirmar, `Ctrl+O` observación, `J`/`K` comprobante anterior/siguiente dentro del filtro activo.
- `condcompra` deja de ser texto libre y pasa a ser un select contra `listarCondicionesCompra` (Tango).

Al terminar la fase, un comprobante puede llegar a `confirmado` con la confianza de que un humano vio las 4 señales de riesgo, o quedar en `observacion` con un motivo trazable. Todavía no se graba nada en Tango — eso sigue siendo Fase 4.

---

## 2. Decisiones

| Punto | Decisión | Motivo |
|---|---|---|
| Fórmula de "totales cuadran" | Cabecera: `totalImputado()` (neto + exento + IVAs + percepciones) contra el `total` leído | El spec general y `design/README.md` se contradicen (cabecera vs. suma de renglones). El 77% de los comprobantes no tiene renglones; la fórmula de renglones los dejaría sin validar |
| Cuándo se recalculan las validaciones | Al abrir la pantalla de revisión, y de nuevo al clickear "Confirmar datos" | Así lo pide el spec general §8. No se recalculan en cada tecleo del autosave — consistente con que `guardarCampo` hoy no dispara `router.refresh()` |
| Resolución de proveedor sin match o con CUIT duplicado | Un solo componente dentro del panel de validaciones, con lista de candidatos + buscador por razón social | Los dos casos ("no sé qué proveedor es") son el mismo problema de fondo; un solo camino de UI evita duplicar lógica |
| Toasts | `ToastProvider` de cliente en el layout raíz, hook `useToast()` | Reusable en toda la app, incluida Fase 4 (el registro en Tango también dispara un toast) |
| Atajos J/K | Navegan dentro del filtro/orden activo de la bandeja, no por ID crudo | "Siguiente" tiene que ser el siguiente que el operador venía mirando, no un ID arbitrario que puede no estar en su lista |
| `condcompra` | Nuevo tipo de campo `select` en el catálogo, opciones desde `listarCondicionesCompra()` | Ya estaba señalado como cabo suelto desde la revisión final de Fase 2; Tango necesita un código válido, no texto libre |
| Migración de base | Ninguna nueva | `MOTIVO_OBSERVACION` y `NOTA_OBSERVACION` ya existen en `PHF_COMPROBANTE` desde la migración de Fase 1, sin usar hasta ahora |

---

## 3. Arquitectura

Piezas nuevas, respetando la frontera de carpetas ya establecida (`src/lib/` lógica pura, `src/server/app/` tablas propias, `src/server/tango/` única capa que toca el ERP, `src/components/`/`src/app/` sin SQL directo):

- **`src/lib/validaciones.ts`** — las 4 reglas como funciones puras: reciben los datos ya leídos (proveedor resuelto o no, candidatos, duplicado encontrado o no, valores de importes, CAE) y devuelven `{ estado: 'ok' | 'advertencia' | 'error', mensaje: string }` por validación. Reusa `totalImputado` de `src/lib/formato.ts`. Sin SQL, testeable con fixtures.
- **`src/server/app/validaciones.ts`** — orquesta: llama a `obtenerDetalleEn` (ya existe), a `src/server/tango/proveedores.ts` para el CUIT, al nuevo módulo de lectura de duplicados, y a `PHF_COMPROBANTE` para descartar duplicados dentro de la propia app. Arma el resultado de las 4 validaciones para la pantalla y para el gate de "Confirmar datos".
- **`src/server/tango/comprobantes.ts` (nuevo)** — lectura de `CPA04` para el chequeo de duplicados por proveedor + tipo + punto de venta + número. Los nombres exactos de columna en `CPA04` que identifican tipo/punto de venta/número hay que confirmarlos contra la base real antes de implementar (el spec general los llama `T_COMP`/`N_COMP`, que puede no ser el nombre literal de columna — mismo tipo de verificación que ya se hizo para las cuatro lecturas de Fase 1).
- **`src/server/tango/proveedores.ts`** — se agrega una función que devuelve **todos** los proveedores que matchean un CUIT (hoy `buscarProveedorPorCuit` deduce determinísticamente el primero por `COD_PROVEE`, ver "Riesgos asentados" del spec general). La usan tanto la validación #1 como el selector manual de la sección 5.
- **`src/server/app/acciones.ts`** — se agrega `marcarObservacion(id, motivo, nota)`.
- **`src/components/revision/`** — panel de validaciones, selector de proveedor, modal de observación, hook de atajos.
- **`src/components/toast/`** (nuevo) — `ToastProvider`, `useToast()`, el componente visual.

---

## 4. Las 4 validaciones

Panel nuevo en la pantalla de revisión, arriba de los 4 grupos de campos del formulario. Mismo shell de tarjeta que ya usan Historial y Renglones. Colores y medidas de `design/README.md` (línea 138 en adelante): punto de 18px con glifo — ✓ verde `#1c7355`/`#e3f1ea`, `!` ámbar `#8a5a00`/`#fbf0dc`, `✕` rojo `#a03526`/`#fae7e3`.

1. **Proveedor existe en Tango** (bloqueante). Match exacto por CUIT contra `CPA01`.
   - 1 match → ✓, muestra la razón social resuelta.
   - 0 o ≥2 matches → ✕, expande el selector manual (sección 5).
2. **Sin duplicados** (bloqueante). Mismo proveedor + tipo + punto de venta + número, buscado en `CPA04` (Tango) y en otros `PHF_COMPROBANTE` (excluyendo el propio comprobante bajo revisión).
   - Sin coincidencia → ✓.
   - Coincidencia → ✕, con una referencia al comprobante duplicado (número interno de Tango o ID de la app, según dónde se encontró) para que el operador lo revise a mano.
3. **Totales cuadran** (advertencia). `totalImputado(valores)` vs. el campo `total` leído, tolerancia de un centavo por redondeo.
   - Coinciden → ✓.
   - Difieren → `!`, con la diferencia exacta en pesos: "La suma de los importes difiere en $ 12.480,00 del total leído."
4. **CAE** (advertencia).
   - Formato: exactamente 14 dígitos numéricos.
   - Vencimiento: `vtocae` no puede ser anterior a la fecha de hoy.
   - Cualquiera de las dos cosas mal → `!`, con el motivo puntual ("CAE con formato inválido" / "CAE vencido el dd/mm/aaaa"). Sin consulta a ARCA (fuera de alcance, igual que en el spec general).

"Confirmar datos" (ya existe desde Fase 2) se deshabilita si #1 o #2 están en error. Las advertencias de #3/#4 no bloquean — el operador puede confirmar de todos modos.

---

## 5. Resolución manual de proveedor

Vive dentro del ítem #1 del panel, expandido solo cuando hace falta.

- **0 matches:** "Sin coincidencia por CUIT {cuit}." + input de búsqueda por razón social (`buscarProveedoresPorRazonSocial`, ya existe), debounce de 250 ms igual que la bandeja, hasta 20 resultados.
- **≥2 matches:** "Hay {N} proveedores con este CUIT." + lista de esos candidatos ya resueltos (razón social, código, CUIT), más el mismo buscador por si ninguno es el correcto.
- **Elegir un candidato** (de cualquiera de los dos casos) dispara un server action que guarda `codprovee` vía `guardarCampoEn` existente:
  - `corregidoPorUsuario: false` si el candidato vino de un match exacto de CUIT entre varios (el sistema tenía la respuesta, solo faltaba desambiguar).
  - `corregidoPorUsuario: true` si vino de la búsqueda manual por razón social (ahí sí es una corrección real).
  - Después de guardar: `router.refresh()`. A diferencia del autosave de texto libre, elegir un proveedor es un click deliberado, no tecleo — el refresh no interrumpe nada y actualiza el panel de validaciones y la razón social del formulario.

Los 7 CUIT duplicados reales en `CPA01` (documentados en `RETOMAR.md`) no se resuelven con este trabajo — siguen siendo un dato sucio de la base. Lo que cambia es que la app ahora se lo pregunta al operador en vez de elegir en silencio.

---

## 6. Modal "Marcar en observación"

El botón de la barra de acciones (hoy deshabilitado, `title="Llega en la Fase 3"`) se habilita para `leido`/`observacion`. Medidas, colores y copy de `design/README.md` §4, sin cambios: overlay, caja 520px, 5 motivos de selección única (obligatoria) + textarea de nota opcional.

Server action `marcarObservacion(id, motivo, nota)`:
- Rechaza si falta el motivo (uno de los 5 valores cerrados).
- Escribe `ESTADO = 'observacion'`, `MOTIVO_OBSERVACION`, `NOTA_OBSERVACION` en `PHF_COMPROBANTE`.
- Agrega la entrada de auditoría "En observación: {motivo}" (mismo patrón que `confirmarComprobante`).
- Devuelve a la bandeja al confirmar (a diferencia de "Confirmar datos", que se queda en la pantalla) — el comprobante en observación normalmente lo retoma otra persona o más tarde.

La transición `observacion → observacion` (cambiar de motivo) ya está contemplada en la tabla de estados del spec general; usa el mismo server action.

---

## 7. Toasts

`ToastProvider` de cliente en `src/app/layout.tsx`, envolviendo `children`. Hook `useToast()` expone una función para mostrar un mensaje. Componente visual según `design/README.md` §Toast: `position: fixed`, `bottom: 28px`, centrado, fondo `#17191d`, radio 9px, auto-dismiss a los 2600 ms, animación `riseIn`.

Se dispara desde:
- "Confirmar datos" → "Comprobante confirmado."
- "Marcar en observación" → "Comprobante marcado en observación."
- Import de PDFs (el modal ya existe desde Fase 2, hoy no dispara toast) → "{N} comprobantes importados."

---

## 8. Atajos de teclado

Hook de cliente montado en `Pantalla`, escucha `keydown` a nivel de documento:

- `Ctrl+Enter` → dispara "Confirmar datos" (si no está deshabilitado por una validación en error).
- `Ctrl+O` → abre el modal de observación.
- `J` / `K` (o `↓`/`↑`) → navega al comprobante siguiente/anterior **dentro del filtro y orden activos de la bandeja** (se pasan por query string a la pantalla de revisión, mismo mecanismo que ya usa la bandeja para filtrar). Requiere que el server component de la pantalla de revisión sepa calcular "el siguiente según ese filtro", no solo `id ± 1`.
- Los atajos se ignoran si el foco está en un `<input>`/`<textarea>` — para no interceptar `Ctrl+Enter` mientras se edita un campo, ni robarle `J`/`K` a alguien escribiendo esas letras en un campo de texto.
- `Tab` entre campos es comportamiento nativo del navegador, no requiere código.

El `key={id}` agregado en el fix final de Fase 2 es lo que hace seguro este punto: cada navegación J/K cambia de ruta, así que sigue habiendo remount completo de `Pantalla`/`Formulario`/`Campo`, y el `ref tocado` (que evita autosaves fantasma) no se contamina entre comprobantes.

---

## 9. `condcompra`: de texto libre a select

`src/lib/campos.ts` gana un tipo de campo nuevo, `'select'`, además de los tipos existentes (`texto`, `fecha`, `decimal`). El campo `condcompra` pasa de `tipo: 'texto'` a `tipo: 'select'`, con las opciones provistas por `listarCondicionesCompra()` (ya construida y testeada en Fase 1 — `src/server/tango/condicionesCompra.ts`).

`Campo` y `Formulario` necesitan soportar este tercer tipo de input: un `<select>` nativo con el mismo alto/borde/foco que ya usa el input de texto (`design/README.md` línea 151 en adelante), para no romper la grilla de 6 columnas. Las opciones se resuelven server-side y se pasan como prop — no hay necesidad de un fetch en cliente.

---

## 10. Testing

- `tests/lib/validaciones.test.ts` — las 4 reglas puras contra fixtures: proveedor resuelto/no resuelto/ambiguo, duplicado presente/ausente, totales que cuadran/no cuadran (reusando los mismos valores reales de `tests/lib/imputado.test.ts`), CAE válido/vencido/mal formado.
- `tests/server/app/validaciones.test.ts` — la orquestación contra SQL Server real: proveedor real por CUIT, un caso de CUIT duplicado real de los 7 ya conocidos (descubierto en `beforeAll`, no hardcodeado — mismo patrón que `tests/server/tango/remitos.test.ts`), duplicado creado dentro de `conRollback` para el caso "ya existe en `PHF_COMPROBANTE`".
- `tests/server/tango/comprobantes.test.ts` — la lectura nueva de `CPA04`, contra datos reales.
- Server action de observación: motivo faltante rechazado, motivo válido escribe las 3 columnas + la entrada de auditoría, dentro de `conRollback`.
- Atajos de teclado: sin infraestructura de test de componentes en el proyecto (no la había al cierre de Fase 2), se documentan como verificación manual en navegador — mismo criterio que se usó para el bloqueo de edición de comprobantes `registrado`.

---

## 11. Fuera de alcance

- Consulta a ARCA para validar CAE (fuera de alcance también en el spec general).
- Resolver los 7 CUIT duplicados en la base de Tango — es un dato de Tango, no algo que la app pueda corregir.
- Registro en Tango y asociación de remitos (Fase 4).
- Medir el costo real por comprobante sobre una muestra representativa — sigue pendiente, ya documentado en `RETOMAR.md`.
