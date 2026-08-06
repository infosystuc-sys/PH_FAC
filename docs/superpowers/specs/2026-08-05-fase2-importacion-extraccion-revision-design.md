# Fase 2 — Importación, extracción con Claude y pantalla de revisión

**Fecha:** 2026-08-05
**Estado:** aprobado, pendiente de plan de implementación
**Depende de:** `2026-08-04-importador-facturas-tango-design.md` (diseño general), Fase 1 integrada en `master`

---

## 1. Qué se construye

El circuito completo desde que el operador arrastra un PDF hasta que el comprobante queda `confirmado`:

importar → extraer con Claude → revisar contra el PDF → corregir → confirmar.

Al terminar la Fase 2 la app se puede poner a probar con comprobantes reales sin tocar el ERP. Lo único que no hace todavía es grabar en Tango, que es la Fase 4.

---

## 2. Decisiones

| Punto | Decisión | Motivo |
|---|---|---|
| Resaltado en el PDF | Capa de texto de pdf.js | Costo cero por comprobante y precisión exacta. **Corrige** al `design/README.md` línea 132, que pide bounding boxes de la IA |
| PDF escaneado | No resalta, y no es un error | La app funciona igual; el operador lee el PDF a ojo |
| Ejecución de la extracción | Cola en tabla con repesca | Sobrevive a que se reinicie el server, que con 100 comprobantes por día va a pasar |
| Alcance de la fase | Incluye confirmar y auditoría | Sin eso la fase no se puede validar con el operador. Las validaciones y el modal de observación siguen en Fase 3 |
| Grupo "Imputación en Tango" | Solo código de proveedor y condición de compra | Son los dos que la app usa para grabar y que la capa de lectura ya resuelve. Cuenta contable y centro de costo alimentan el asiento, que está fuera de alcance; talonario todavía no se sabe de dónde sale |
| Modelo | `claude-opus-5` | El costo de un error acá no es un token de más: es una factura imputada a la cuenta corriente equivocada |
| Contrato Claude ↔ app | Un catálogo tipado único | El JSON Schema, las claves de `PHF_CAMPO` y el formulario son la misma lista |
| Validación del schema | JSON Schema explícito, sin zod | Coherente con el resto del proyecto: SQL explícito, mappers a mano, sin capas de abstracción |

---

## 3. El catálogo de campos

`src/lib/campos.ts` es la fuente de verdad. Cada campo declara clave, label, grupo, ancho en la grilla de 6 columnas, tipo de dato, si va en IBM Plex Mono y si lo extrae la IA.

De ese catálogo se derivan tres cosas, sin repetir la lista:

1. El JSON Schema que va en `output_config.format`.
2. Las claves válidas de `PHF_CAMPO.CLAVE`.
3. El render del formulario de revisión.

### Grupo "Comprobante"

| Clave | Label | Span | Tipo | Mono |
|---|---|---|---|---|
| `tipo` | Tipo | 2 | texto | no |
| `ptovta` | Punto de venta | 2 | texto | sí |
| `nro` | Número | 2 | texto | sí |
| `fecha` | Fecha de emisión | 2 | fecha | sí |
| `cae` | CAE | 2 | texto | sí |
| `vtocae` | Vto. CAE | 2 | fecha | sí |
| `moneda` | Moneda | 2 | texto | no |
| `cotizacion` | Cotización | 2 | decimal | sí |
| `ordencompra` | Orden de compra | 2 | texto | sí |

### Grupo "Proveedor"

| Clave | Label | Span | Tipo | Mono |
|---|---|---|---|---|
| `razon` | Razón social | 3 | texto | no |
| `cuit` | CUIT | 3 | texto | sí |
| `condiva` | Condición IVA | 2 | texto | no |
| `condpago` | Condición de pago | 2 | texto | no |
| `vencimiento` | Vencimiento | 2 | fecha | sí |

### Grupo "Importes"

**Esta sección se rehízo el 2026-08-05**, después de que una factura real de servicios no cerrara con la forma original. Ver §11.

La forma sale de cómo Tango guarda realmente las alícuotas, verificado contra las 15.625 facturas de `CPA04`: **un solo neto gravado** —la suma de todas las bases— y hasta **cinco tripletas** de código, porcentaje e importe en `COD_IVA1..5` / `PORC_IVA1..5` / `IMP_IVA1..5`. Tango no guarda el neto por base.

| Clave | Label | Span | Tipo | Mono |
|---|---|---|---|---|
| `neto` | Neto gravado | 3 | decimal | sí |
| `exento` | No gravado / exento | 3 | decimal | sí |
| `porciva1`…`porciva5` | Alícuota 1…5 | 2 c/u | decimal | sí |
| `impiva1`…`impiva5` | Importe 1…5 | 4 c/u | decimal | sí |
| `perciibb` | Percepción IIBB | 3 | decimal | sí |
| `impint` | Impuesto interno | 3 | decimal | sí |
| `total` | Total del comprobante | 3 | decimal | sí |
| `imputado` | Total imputado | 3 | decimal | sí |

Cada par `porcivaN` + `impivaN` ocupa una fila de la grilla de 6.

**Los cinco slots mezclan alícuotas de IVA con percepciones de la familia IVA**, que es lo que hace Tango: el código 16 —percepción de IVA, 3%— vive en un slot, no en `CPA18`. Por eso no hay un campo `perciva` separado: es un slot más.

`perciibb` e `impint` son del lado de `CPA18`, que admite hasta 5 filas por comprobante. Se modelan como campos con nombre porque son los dos casos frecuentes; un mecanismo genérico para las 5 filas de `CPA18` es trabajo de la Fase 4, cuando haya que escribirlas.

Uso real de los slots, sobre 15.625 facturas: el 2 en 2.922 (19%), el 3 en 517, el 4 en 70, **el 5 en ninguna**. Las combinaciones más frecuentes son `21%` sola (11.326), `21% + percepción de IVA` (1.570) y `21% + 10,5%` (146).

**La IA extrae 29 campos**: 9 de comprobante, 5 de proveedor y 15 de importes.

`imputado` es **calculado y de solo lectura**: la suma de los seis campos que lo preceden (`neto`, `iva21`, `iva105`, `exento`, `perciva`, `perciibb`). Existe para que el operador vea de un vistazo si esa suma coincide con el `total` que la IA leyó del PDF. No lo extrae la IA y no se guarda en `PHF_CAMPO`.

### Grupo "Imputación en Tango"

| Clave | Label | Span | Origen |
|---|---|---|---|
| `codprovee` | Cód. proveedor Tango | 3 | Resuelto por `buscarProveedorPorCuit`. Solo lectura |
| `condcompra` | Condición de compra | 3 | Select contra `listarCondicionesCompra` |

Van a span 3 y no a 2 como en el `design/README.md`: sacado el talonario, dos campos de 2 dejaban la fila a un tercio. Cada grupo suma un múltiplo de 6, que es el ancho de la grilla.

Ninguno lo extrae la IA. `codprovee` se resuelve del CUIT extraído; si no hay match queda vacío y la Fase 3 lo trata como error bloqueante.

**La IA extrae 21 campos** (9 + 5 + 7). Los tres restantes se derivan o los elige el operador.

### Renglones

Van a `PHF_RENGLON`, no a `PHF_CAMPO`, y no tienen confianza por campo: `codigo`, `descripcion`, `cantidad`, `precioUnitario`, `importe`.

---

## 4. Extracción

`src/server/ia/` es una capa nueva con la misma disciplina de frontera que `src/server/tango/`: **es el único módulo que habla con la API de Anthropic.** Ningún otro la nombra.

- `extraccion.ts` — arma el request, llama, valida la respuesta.
- `prompt.ts` — el prompt de sistema, versionado por constante.

### El request

- Cliente `@anthropic-ai/sdk`, modelo `claude-opus-5`, leído de `ANTHROPIC_MODELO` con ese default.
- El PDF va como bloque `document` con `source.type = 'base64'`, **antes** del bloque de texto. El límite de la API es 32 MB por request, muy por encima de los 10 MB por archivo del modal.
- `output_config.format` con `type: 'json_schema'` y el schema derivado del catálogo.
- `thinking: { type: 'adaptive' }` con `output_config.effort: 'medium'`.
- `max_tokens: 16000`. En Opus 5 el pensamiento se cuenta **dentro** de `max_tokens`, así que el margen no es opcional.
- El prompt de sistema lleva `cache_control: { type: 'ephemeral' }`. Supera los 512 tokens que Opus 5 pide como mínimo cacheable y es idéntico en cada llamada, así que a partir del segundo comprobante esa parte de la entrada se cobra a una décima parte. El PDF va después, en `messages`, así que no rompe el prefijo.

### La respuesta

Por cada campo del catálogo, un objeto con `valor` (string o `null` si no figura en el PDF) y `confianza` (0 a 1). Más el array de renglones.

Todo se guarda como **texto** en `VALOR_IA`. El parseo a número o fecha vive en `src/lib/`, no en la capa de IA: `VALOR_IA` y `VALOR_FINAL` son `NVARCHAR(500)` y guardan lo que el PDF dice, no una interpretación.

`VALOR_FINAL` arranca igual que `VALOR_IA`. `CONFIANZA_PROMEDIO` de `PHF_COMPROBANTE` es el promedio de los campos que la IA devolvió con valor no nulo.

### Fallas

| Falla | Destino |
|---|---|
| `stop_reason === 'refusal'` | Estado `error`, mensaje del `stop_details` |
| JSON que no valida contra el schema | Estado `error` |
| PDF ilegible o sin contenido | Estado `error` |
| Timeout o error de red | Reintento del worker; a la cuarta, estado `error` |
| Rate limit (429) o 5xx | El SDK reintenta dos veces solo; después, reintento del worker |

Un comprobante en `error` se puede reprocesar desde la UI.

---

## 5. La cola

`src/server/app/cola.ts`.

1. La subida guarda el PDF en disco, calcula el SHA-256, inserta la fila en `procesando` y **devuelve enseguida**. El modal no espera a Claude.
2. Un worker en proceso toma pendientes de a **3 en paralelo**.
3. Cada 2 minutos repesca lo que quedó en `procesando` con más de **10 minutos** de antigüedad —reinicio del server, crash, cuelgue— y lo vuelve a encolar.
4. Al cuarto intento el comprobante pasa a `error` en vez de reintentarse para siempre.
5. La bandeja hace polling cada 3 segundos **solo mientras haya algo en `procesando`**.

Los PDFs van a la carpeta de `STORAGE_DIR`, con default `D:\APP\PH_FAC\storage`. Ya está en `.gitignore`.

El hash se guarda pero **no bloquea**: subir dos veces el mismo PDF está permitido en esta fase. La detección de duplicados es una validación de la Fase 3 y se hace por proveedor + tipo + número, que es el criterio del negocio, no por hash del archivo.

---

## 6. Cambios de esquema

Cuatro columnas nuevas en `PHF_COMPROBANTE`:

| Columna | Tipo | Para qué |
|---|---|---|
| `INTENTOS` | `INT NOT NULL DEFAULT 0` | Acotar los reintentos de la cola |
| `ERROR_MENSAJE` | `NVARCHAR(1000) NULL` | El spec general §221 pide "pasa a error con el mensaje". `MOTIVO_OBSERVACION` es de otra cosa y no sirve |
| `EXTRACCION_MS` | `INT NULL` | El aviso "Claude leyó 31 campos en 2,4 s" del `design/README.md` línea 136 |
| `EXTRACCION_MODELO` | `VARCHAR(40) NULL` | Mismo aviso, y permite comparar modelos con datos reales más adelante |

**La migración no sabe agregar columnas.** Hoy `scripts/migrate.ts` crea tablas que faltan y repara índices que faltan, pero no altera una tabla existente. Hay que extenderla con `ALTER TABLE ... ADD`, con el mismo criterio que ya tiene:

- Idempotente: se consulta `sys.columns` y solo se agrega lo que falta.
- Las columnas nuevas son `NULL` o tienen `DEFAULT`, así que la operación es segura sobre una tabla con datos.
- Sigue sin tocar ninguna tabla que no lleve el prefijo `PHF_`.
- Los tests de migración existentes cubren el camino de prefijo de prueba; hay que sumar el caso "tabla existente a la que le falta una columna", en paralelo al de índice faltante que ya está.

---

## 7. Pantalla de revisión

`/comprobantes/[id]`, hoy un stub de 17 líneas, pasa a ser la pantalla donde el operador vive el 90% del tiempo. Las medidas salen de `design/README.md` §2, que es la fuente de verdad.

- Grid de dos paneles, `minmax(420px, 44%) 1fr`, con scroll independiente. La barra de acciones y los headers nunca scrollean.
- **Visor**: pdf.js. El PDF se sirve por un route handler que lo lee de disco. **No va en `public/`**: los comprobantes no son archivos públicos.
- **Resaltado**: al enfocar un input se busca el `VALOR_FINAL` de ese campo en la capa de texto de la página y se resalta la coincidencia con los estilos del README §121. Al desenfocar se apaga. Sin capa de texto no resalta, y no es un error.
- **Autosave**: server action con debounce de 500 ms. Escribe `VALOR_FINAL` y marca `CORREGIDO_POR_USUARIO = 1`. Ese flag es el que después permite medir la precisión del modelo.
- **Aviso de lectura IA**: cantidad de campos, duración desde `EXTRACCION_MS`, confianza promedio y modelo desde `EXTRACCION_MODELO`.
- **Reprocesar**: vuelve a `procesando` y descarta las correcciones manuales. La UI avisa antes.
- **Confirmar datos**: pasa a `confirmado` y escribe la fila de `PHF_AUDITORIA`. Sin validaciones todavía.
- **Historial**: las filas de `PHF_AUDITORIA` del comprobante.
- Los colores del chip de confianza salen de `nivelConfianza` en `src/lib/confianza.ts`, que ya existe y ya implementa los cortes en 0,80 y 0,93. El estilo de input de baja confianza —borde `#e6b9b0` y fondo `#fdf6f4`— es nuevo y usa el mismo corte de 0,80.

El panel de validaciones y el modal de observación **no** entran en esta fase. El botón "Marcar en observación" se muestra deshabilitado.

---

## 8. Testing

| Qué | Cómo |
|---|---|
| Catálogo de campos y derivación del JSON Schema | Vitest puro, sin red |
| Mapeo respuesta → `PHF_CAMPO` / `PHF_RENGLON` | Vitest puro, con respuestas grabadas en `tests/fixtures/` |
| Parseo y formato de importes, fechas y CUIT | Ya cubierto por `tests/lib/formato.test.ts`; se extiende |
| Cola: encolar, tomar, repescar, agotar intentos | SQL Server real dentro de `conRollback` |
| Migración: columna faltante en tabla existente | SQL Server real con prefijo de prueba |
| Autosave y confirmación | SQL Server real dentro de `conRollback` |
| Llamada real a la API de Anthropic | **No entra en `pnpm test`.** Queda como script aparte, manual |

La suite tiene que seguir corriendo sin `ANTHROPIC_API_KEY` cargada. Los tests miden contra una línea de base, no asumen tablas vacías.

---

## 9. Fuera de alcance

- Las cuatro validaciones y el modal de observación — Fase 3.
- La resolución de CUIT duplicados en `CPA01` — Fase 3.
- Registro en Tango y asociación de remitos — Fase 4.
- Bounding boxes de la IA para el resaltado.
- Detección de duplicados por hash de archivo.
- Buzón de email o portal de proveedores como origen de PDFs.
- Consulta a ARCA para validar CAE.

---

## 10. Riesgos

- **Costo por comprobante sin medir.** Opus 5 cuesta $5 por millón de tokens de entrada y $25 de salida. Con 20 a 100 comprobantes por día el orden de magnitud son decenas de dólares al mes, pero el conteo real depende de cuántos tokens ocupa un PDF de factura. Hay que medirlo con `count_tokens` sobre comprobantes reales apenas haya extracciones andando, antes de dar un número firme.
- **El worker en proceso muere con el server.** La repesca lo cubre, pero si el server queda caído nadie procesa. Es aceptable para una app de red interna con un operador; si en algún momento hay varias instancias, la repesca necesita un lock para que dos no tomen el mismo comprobante.
- **La calidad de extracción en escaneos es desconocida.** El 100% de la lógica de la app funciona igual, pero la confianza promedio va a ser más baja y el operador va a corregir más. `CORREGIDO_POR_USUARIO` es lo que va a permitir cuantificarlo.
- **`pdf.js` es una dependencia pesada en el cliente.** Se carga solo en la ruta de revisión, no en la bandeja.

---

## 11. Lo que enseñó la primera factura real

El 2026-08-05, con las tareas 1 a 7 del plan ya implementadas, se probó la extracción contra una factura real de servicios (AMX ARGENTINA SA, la razón social de Claro). Salieron cuatro cosas que ningún test podía agarrar, porque ningún test le pega a la API — que es una restricción correcta y no se cambia.

### 1. El JSON Schema rompía toda extracción

La API devolvía 400 en cada llamada:

> Schemas contains too many parameters with union types (26 parameters with type arrays or anyOf) […] limit: 16 parameters with unions.

`schemaExtraccion()` generaba 26 uniones: un `anyOf: [string, null]` por cada campo más las cinco claves de renglón. El límite de structured outputs es 16.

**Resuelto:** `valor` pasa a `{ type: 'string' }` y la cadena vacía significa "no figura". `parsearRespuesta` no necesitó cambios: su helper ya convertía `''` a `null`. Hay un test que recorre el schema entero y falla si vuelve a aparecer una unión.

Lo que hizo el fallo diagnosticable en un intento fue el `console.error` del error crudo, agregado en una revisión anterior. Sin eso el mensaje llegaba recortado a 900 caracteres.

### 2. Un mismo comprobante mezcla formatos de importe

La factura imprime, literalmente:

```
IVA 21.0% (Neto gravado $ 186623.75) = $39.190,99
```

El neto sin separador de miles y con punto decimal; el IVA con punto de miles y coma decimal, en el mismo documento. El modelo estaba copiando bien: la regla del prompt es devolver exactamente lo impreso.

El defecto estaba del lado que consume. `desnormalizarBandejaEn` convertía con `REPLACE(REPLACE(@total,'.',''),',','.')`, que contra un total impreso como `690983.02` habría dado 69.098.302 en la columna que el operador ve.

**Resuelto:** `parsearImporte` en `src/lib/formato.ts` maneja los dos formatos y se usa desde JS, en vez de convertir en SQL. Un solo punto seguido de exactamente dos dígitos es decimal; cualquier otro punto es separador de miles.

### 3. El grupo de importes no cubría múltiples bases

Ver §3. La factura tenía dos bases imponibles y el catálogo modelaba una sola. Con las dos, los totales cierran exacto:

| | |
|---|---:|
| neto 21% | 186.623,75 |
| neto 27% | 343.323,75 |
| IVA 21% | 39.190,99 |
| IVA 27% | 92.697,41 |
| percepción IVA | 15.898,43 |
| percepción IIBB | 13.248,69 |
| **suma** | **690.983,02** |
| total leído | 690.983,02 |

### 4. Los renglones de servicios no se parecen a los de mercadería

Se detectaron 16 renglones con nombres de plan y montos, cuando el histórico dice que el 77% de las facturas vienen solo con cabecera y el 98,3% de los renglones están atados a un remito. Las facturas de servicios no tienen remito y sí tienen detalle.

No cambia nada de la Fase 2 —los renglones se guardan igual en `PHF_RENGLON`—, pero sí es un dato para la Fase 4: **un renglón sin remito no se graba en Tango**, y en una factura de servicios eso significa que no se graba ninguno. Hay que decidir si esos comprobantes se graban solo con cabecera o si necesitan otro camino.

### La lección de proceso

Las cuatro salieron de correr el sistema contra un documento real, no de los tests ni de las revisiones. La verificación final del plan incorpora una extracción real contra esta factura, para que el circuito completo quede probado antes de cerrar la fase.
