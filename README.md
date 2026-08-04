# Handoff: Importador de facturas con IA → ERP Tango

## Overview
Aplicación web de escritorio para el equipo de **cuentas a pagar**. El usuario importa comprobantes de compra en PDF (factura A/B/C, notas de débito/crédito — tipos AFIP/ARCA), una IA extrae los campos, el usuario revisa y confirma contra el PDF original, y finalmente el movimiento se registra en el **ERP Tango** (SQL Server).

Volumen objetivo: **20 a 100 comprobantes por día y por usuario**. Esto condiciona todo el diseño: la revisión tiene que ser rápida, con el PDF y los campos visibles al mismo tiempo, y la bandeja tiene que soportar filtrado y búsqueda densos.

Perfil de usuario: administrativo de cuentas a pagar (operador de alto volumen, no un ejecutivo). Idioma: **español rioplatense**, tono sobrio y técnico.

## About the Design Files
Los archivos de este bundle son **referencias de diseño creadas en HTML**: prototipos que muestran el aspecto y el comportamiento buscados, **no código de producción para copiar**. Están escritos con un runtime de prototipado propio (`<x-dc>` + una clase de lógica) que no debe portarse.

La tarea es **recrear estos diseños en el entorno existente del codebase destino** (React, Vue, Blazor, WPF, etc.), usando sus patrones y librerías establecidos. Si todavía no hay entorno, elegir el framework más adecuado (para este caso: React + TypeScript en el front, y un backend .NET o Node con acceso a SQL Server) e implementar ahí.

Los datos del prototipo son **simulados y hardcodeados**. No hay backend, no hay parseo real de PDF, no hay conexión a SQL Server.

## Fidelity
**Alta fidelidad (hifi).** Colores, tipografía, espaciado, estados y copy son finales. Recrear la UI fielmente usando las librerías del codebase. Los datos son de muestra; la estructura de campos y estados sí es la propuesta de diseño.

---

## Modelo de estados (el corazón de la app)

Un comprobante recorre estos estados. Los colores son los del badge en la UI.

| Estado | Label en UI | Fondo / Texto | Significado | Transiciones salientes |
|---|---|---|---|---|
| `procesando` | Procesando IA | `#eceaf6` / `#4a3fa8` | PDF subido, extracción en curso | → `leido`, → `error` |
| `leido` | Pendiente de revisión | `#e7eef9` / `#2b4fd0` | IA terminó, espera revisión humana | → `confirmado`, → `observacion` |
| `observacion` | En observación | `#fbf0dc` / `#8a5a00` | Bloqueado por un motivo; no se registra | → `confirmado`, → `observacion` (cambio de motivo) |
| `confirmado` | Confirmado | `#e3f1ea` / `#1c7355` | Datos validados por el operador, listo para grabar | → `registrado` |
| `registrado` | Registrado en Tango | `#17191d` / `#ffffff` | Movimiento grabado en el ERP. **Terminal.** | ninguna |
| `error` | Error de lectura | `#fae7e3` / `#a03526` | PDF ilegible o extracción fallida | → `leido` (tras reprocesar), → borrado |

Reglas:
- `registrado` es terminal e inmutable — nada se edita después de grabar en Tango.
- Solo `confirmado` habilita el botón "Registrar en Tango".
- `observacion` requiere un **motivo** obligatorio (lista cerrada) y admite una nota libre.
- Cada transición escribe una entrada de auditoría (timestamp, texto, usuario).

Estilo del badge: `inline-flex`, `height: 21px`, `padding: 0 9px`, `border-radius: 11px`, `font-size: 11.5px`, `font-weight: 500`, `white-space: nowrap`.

---

## Screens / Views

### 1. Bandeja de comprobantes (`view: 'inbox'`)

**Purpose:** ver todo lo importado, filtrar por estado, buscar, y entrar a revisar. Es la pantalla de inicio.

**Layout:** columna vertical. Header global fijo (56px). Contenido con scroll propio (`overflow-y: auto`, `display: block` — importante: NO flex column, porque comprime la tabla), `max-width: 1560px`, centrado, `padding: 26px 28px 40px`.

Orden vertical: título + botón de importar → fila de 4 KPIs → fila de tabs de filtro + buscador → tabla → línea de pie.

**Componentes:**

*Título*
- `h1`: "Bandeja de comprobantes" — 23px / 600 / `letter-spacing: -0.02em`, `#17191d`.
- Subtítulo: "Importá los PDF, revisá lo que leyó la IA y registralo en Tango." — 13px, `#6b7078`.
- Botón primario a la derecha (`margin-left: auto`): "+ Importar PDF" — alto 38px, `padding: 0 17px`, fondo `#17191d`, texto `#fff` 13.5px/500, `border-radius: 7px`. Hover: fondo `#2b4fd0`.

*KPIs* — grid de 4 columnas iguales, `gap: 12px`. Cada tarjeta: fondo `#fff`, borde `1px solid #e3e1dc`, `border-radius: 9px`, `padding: 15px 17px`. Label: 11.5px, `#7b7f87`, uppercase, `letter-spacing: 0.03em`, `margin-bottom: 8px`. Valor: IBM Plex Mono 27px/600, `letter-spacing: -0.02em`.
1. "Pendientes de revisión" → count de `leido`.
2. "En observación" → count de `observacion`, valor en `#8a5a00`.
3. "Registrados hoy" → count de `registrado`.
4. "Importe pendiente" → suma de totales de `leido` + `observacion`, formato `$ 1.234.567,89`.

*Tabs de filtro* — fila con `gap: 8px`. Orden: Todos, Pendientes, En observación, Confirmados, Registrados, Con error. Cada tab: alto 34px, `padding: 0 13px`, `border-radius: 7px`, 13px. Inactivo: fondo `#fff`, borde `1px solid #e3e1dc`, texto `#4a4e56`. Activo: fondo y borde `#17191d`, texto `#fff`. Cada tab muestra el count al lado en IBM Plex Mono 11.5px (`#9a9ea6` inactivo, `#a8abb2` activo).

*Buscador* — a la derecha (`margin-left: auto`), fondo `#fff`, borde `1px solid #e3e1dc`, `border-radius: 7px`, alto 34px, `padding: 0 12px`, `min-width: 260px`. Ícono lupa `#9a9ea6` + input sin borde. Placeholder: "Buscar proveedor, CUIT o número". Filtra sobre proveedor + CUIT + número, case-insensitive, substring.

*Tabla* — contenedor fondo `#fff`, borde `1px solid #e3e1dc`, `border-radius: 10px`, `overflow-x: auto`.
Grid de columnas (idéntico en header y filas), `min-width: 1010px`:
```
170px 92px 148px 100px minmax(200px, 1fr) 132px 132px 96px 44px
```
→ Estado · Tipo · Comprobante · Fecha · Proveedor · CUIT · Total · Confianza · chevron

Header: alto 38px, fondo `#faf9f7`, borde inferior `1px solid #e3e1dc`, texto 11px uppercase `letter-spacing: 0.05em` `#82868e` peso 500. "Total" alineado a la derecha, "Confianza" centrado.

Filas: alto 50px (40px en densidad compacta), `padding: 0 16px`, borde inferior `1px solid #f0efec`, `cursor: pointer`. Hover: fondo `#f7f6f3`. Click abre la revisión de ese comprobante.
- Estado: badge (ver tabla de estados).
- Tipo: 13px `#4a4e56`.
- Comprobante (`0003-00018742`): IBM Plex Mono 12.5px `#17191d`.
- Fecha (`dd/mm/yyyy`): IBM Plex Mono 12.5px `#5c6068`.
- Proveedor: 13.5px/500, `text-overflow: ellipsis`, `white-space: nowrap`, `padding-right: 14px`.
- CUIT (`30-64872913-7`): IBM Plex Mono 12.5px `#5c6068`.
- Total: IBM Plex Mono 13px/500, derecha, `$ ` + es-AR con 2 decimales; `—` si es 0.
- Confianza: chip (ver "Chip de confianza").
- Chevron `›` 15px `#b0b4bb`, derecha.

Estado vacío: `padding: 52px`, centrado, "No hay comprobantes con este filtro." 13.5px `#8b8f97`.

*Pie*: `margin-top: 12px`, 12px `#8b8f97` — "{n} comprobantes · última sincronización con Tango hoy 09:42".

---

### 2. Revisión del comprobante (`view: 'review'`)

**Purpose:** validar campo por campo lo que extrajo la IA contra el PDF original, corregir, y confirmar o marcar en observación. Es la pantalla donde el usuario pasa el 90% del tiempo.

**Layout:** columna. Header global (56px) → barra de acciones (fija, no scrollea) → cuerpo `display: grid; grid-template-columns: minmax(420px, 44%) 1fr; min-height: 0` con **dos paneles de scroll independientes**.

**Barra de acciones** — `padding: 12px 24px`, fondo `#fff`, borde inferior `1px solid #e3e1dc`, `flex: none`.
- Izquierda: botón "← Bandeja" — alto 32px, `padding: 0 12px`, fondo `#f2f1ed`, borde `1px solid #e3e1dc`, `border-radius: 6px`, 12.5px `#4a4e56`. Hover `#e9e7e2`.
- Al lado, alineados por baseline con `gap: 12px`: proveedor (15.5px/600), tipo + número (IBM Plex Mono 13px `#5c6068`), badge de estado.
- Derecha, `gap: 9px`:
  - "Marcar en observación" — alto 36px, `padding: 0 15px`, fondo `#fff`, borde `1px solid #e0cfa4`, texto `#8a5a00` 13px/500, radio 7px. Hover fondo `#fdf6e7`.
  - Botón primario, contextual según estado:
    - `leido` u `observacion` → **"Confirmar datos"**, fondo `#17191d`, texto `#fff`.
    - `confirmado` → **"Registrar en Tango"**, fondo `#1c7355`, texto `#fff`.
    - `registrado` → **"Ver asiento en Tango"**, fondo `#f2f1ed`, borde `1px solid #e3e1dc`, texto `#4a4e56`.
    - Todos: alto 36px, `padding: 0 18px`, radio 7px, 13px/500. Hover `opacity: .88`.

**Panel izquierdo — visor de PDF** (`overflow: auto`, fondo `#e6e4df`, borde derecho `1px solid #d8d5cf`, `padding: 22px`).
- Barra superior: nombre del archivo (11.5px uppercase `letter-spacing: 0.05em` `#7b7f87`) y "Página 1 de 1" a la derecha.
- La "hoja": fondo `#fff`, `box-shadow: 0 2px 14px rgba(0,0,0,.13)`, `padding: 28px 30px`, `min-height: 640px`, texto base 11px `#2a2d33`.
  - **En producción esto es un visor de PDF real** (pdf.js / `<embed>`). En el prototipo es una factura AFIP dibujada en HTML para poder demostrar el resaltado; no portar ese markup.
  - Estructura de la factura simulada: cabecera 3 columnas (emisor | letra en caja de 44px con "CÓD. 001/006/011" | "FACTURA" + número + fecha + CUIT) con borde inferior `2px solid #17191d`; bloque cliente / condición de venta; tabla de renglones; bloque de totales alineado a derecha (246px de ancho); pie con CAE y vencimiento.

**Resaltado sincronizado (feature clave):** al enfocar un input del panel derecho, la zona correspondiente del PDF se resalta: `background: rgba(43,79,208,.13)`, `outline: 2px solid rgba(43,79,208,.5)`, `border-radius: 4px`, `transition: background .15s, outline-color .15s`. Se apaga en blur. Mapeo campo → zona del PDF:

| Zona del PDF | Campos que la activan |
|---|---|
| Razón social del emisor | `razon` |
| Número / letra | `nro`, `ptovta`, `tipo` |
| Fecha de emisión | `fecha` |
| CUIT y condición IVA | `cuit`, `condiva` |
| Bloque de totales | `neto`, `iva21`, `iva105`, `exento`, `perciva`, `perciibb`, `total`, `imputado` |
| Pie de CAE | `cae`, `vtocae` |

En producción esto se implementa con los **bounding boxes** que devuelve la IA por campo, superpuestos en coordenadas sobre el canvas del PDF. El request al modelo debe pedir, por cada campo: valor, confianza y bbox (página + x/y/w/h normalizados).

**Panel derecho — formulario** (`overflow: auto`, fondo `#f7f6f3`, `padding: 20px 24px 60px`, contenido `max-width: 760px`).

*Aviso de lectura IA* — fondo `#fff`, borde `1px solid #e3e1dc`, radio 9px, `padding: 12px 15px`, `margin-bottom: 16px`. Ícono 26px cuadrado radio 6px fondo `#eceaf6` color `#4a3fa8`. Título "Lectura automática completada" 13px/500. Detalle 12px `#7b7f87`: "Claude leyó 31 campos en 2,4 s · confianza promedio 95% · modelo facturas-AR v3". A la derecha botón "Reprocesar" (alto 30px, fondo `#f2f1ed`, borde `1px solid #e3e1dc`, radio 6px, 12px `#4a4e56`).

*Panel de validaciones* — mismo shell de tarjeta. Título de sección: 11.5px uppercase `letter-spacing: 0.05em` `#82868e`, `padding: 13px 0 10px`, borde inferior `1px solid #eeece8`. Cada ítem: `padding: 10px 0`, borde inferior `1px solid #f4f3f0`, `gap: 10px`. Punto de 18px circular con glifo 11px/700:
- OK → `✓`, fondo `#e3f1ea`, color `#1c7355`
- Advertencia → `!`, fondo `#fbf0dc`, color `#8a5a00`
- Error → `✕`, fondo `#fae7e3`, color `#a03526`

Validaciones a implementar (todas deben resolverse server-side contra Tango):
1. **Proveedor existe en Tango** — match exacto por CUIT. Error si no hay coincidencia: "Sin coincidencia por CUIT {cuit}. Elegí el proveedor manualmente." → debe ofrecer un buscador de proveedores.
2. **Sin duplicados** — no existe otro comprobante del mismo proveedor con el mismo tipo + punto de venta + número (ni en la app ni ya grabado en Tango). Error bloqueante.
3. **Totales cuadran** — suma de renglones + impuestos = total leído. Advertencia con la diferencia exacta: "La suma de renglones difiere en $ 12.480,00 del total leído."
4. **CAE** — formato válido y no vencido. En producción, opcionalmente consulta a ARCA.

*Grupos de campos* — 4 tarjetas, cada una con grid interno de **6 columnas**, `gap: 12px`; cada campo ocupa `grid-column: span N`.

Inputs: alto 36px, `padding: 0 11px`, radio 7px, 13.5px, color `#17191d`, `outline: none`.
- Normal: borde `1px solid #dcdad5`, fondo `#fff`.
- Baja confianza (< 0.80): borde `1px solid #e6b9b0`, fondo `#fdf6f4`.
- Solo lectura: fondo `#f7f6f3`.
- Focus: `border-color: #2b4fd0`, `box-shadow: 0 0 0 3px rgba(43,79,208,.12)`.
- Campos numéricos / de código (importes, CUIT, CAE, cotización, número, punto de venta) en **IBM Plex Mono**; el resto en IBM Plex Sans.

Label sobre el input: 11.5px `#7b7f87`, `margin-bottom: 5px`, con el chip de confianza al lado (`gap: 6px`).

**Grupo "Comprobante"** (span entre paréntesis): Tipo (2) · Punto de venta (2) · Número (2) · Fecha de emisión (2) · CAE (2) · Vto. CAE (2) · Moneda (2) · Cotización (2) · Orden de compra (2).

**Grupo "Proveedor"**: Razón social (3) · CUIT (3) · Condición IVA (2) · Condición de pago (2) · Vencimiento (2).

**Grupo "Importes"**: Neto gravado 21% (2) · IVA 21% (2) · IVA 10,5% (2) · No gravado / exento (2) · Percepción IVA (2) · Percepción IIBB (2) · Total del comprobante (3) · Total imputado (3, **solo lectura**, calculado).

**Grupo "Imputación en Tango"**: Cód. proveedor Tango (2) · Talonario (2) · Condición de compra (2) · Cuenta contable (3) · Centro de costo (3).
> ⚠️ Estos 5 campos son la propuesta de diseño y **deben confirmarse con el equipo de Tango** antes de implementar. En producción son selects contra las tablas maestras del ERP, no inputs libres.

*Renglones detectados* — tarjeta con grid `70px 1fr 60px 96px 104px` → Código · Descripción · Cant. · P. unitario · Importe. Header 11px uppercase `#82868e`. Filas 12.5px, `padding: 9px 0`, borde superior `1px solid #f4f3f0`; código/cantidad/precios en IBM Plex Mono alineados a derecha; importe en 500.
> Pendiente de definición: si el asiento en Tango lleva detalle de renglones o solo cabecera + imputación contable. La UI soporta ambos (la tarjeta se oculta en modo cabecera).

*Historial / auditoría* — tarjeta con filas de `padding: 10px 0`, borde inferior `1px solid #f4f3f0`: timestamp (IBM Plex Mono 11.5px `#9a9ea6`, ancho fijo 104px) · texto (12.5px) · usuario (12px `#9a9ea6`, derecha). Entradas base: "PDF importado desde carga manual" y "Lectura automática con IA — 31 campos" (usuario: "Sistema"). Cada cambio de estado agrega una entrada.

---

### 3. Modal de importación

Overlay `position: fixed; inset: 0`, fondo `rgba(23,25,29,.45)`, centrado, `z-index: 60`. Caja: 620px, fondo `#fff`, radio 12px, `padding: 24px`, animación `riseIn .18s ease-out`.
- Título "Importar comprobantes" 17px/600. Botón cerrar 28px cuadrado, fondo `#f2f1ed`, radio 6px.
- Dropzone: borde `1.5px dashed #c9c6c0`, radio 10px, `padding: 34px`, centrado, fondo `#faf9f7`, `cursor: pointer`. Hover: `border-color: #2b4fd0`, fondo `#f4f6fd`. Ícono `⇪` 26px `#b0b4bb`. Título "Arrastrá los PDF acá" 14px/500. Detalle 12.5px `#7b7f87`: "o hacé clic para elegirlos · hasta 50 archivos · PDF, máx. 10 MB c/u".
- Lista de archivos en proceso: filas con borde `1px solid #e3e1dc`, radio 7px, `padding: 9px 12px`, `gap: 10px`, `margin-bottom: 7px` — etiqueta "PDF" 12px/600 `#b03a2b`, nombre 12.5px, estado a la derecha 11.5px/500: "Leyendo con IA…" en `#4a3fa8`, "Listo" en `#1c7355`.
- Timing del prototipo: 1500 ms hasta "Listo", 2400 ms hasta cerrar y aparecer en la bandeja. **En producción es progreso real por archivo** (subida → cola → extracción), con reintento por archivo fallido y sin bloquear el modal.
- Al terminar: cierra, aplica el filtro "Pendientes", y muestra un toast "3 comprobantes importados y leídos por la IA."

### 4. Modal "Marcar en observación"

Mismo overlay. Caja 520px.
- Título "Marcar en observación" 17px/600. Subtítulo 13px `#7b7f87`: "El comprobante queda pendiente y no se registra en Tango hasta resolverlo."
- Lista de motivos (selección única, obligatoria), botones full-width alineados a la izquierda: `padding: 10px 13px`, radio 7px, 13px. Sin seleccionar: borde `1px solid #e3e1dc`, fondo `#fff`. Seleccionado: borde `1px solid #2b4fd0`, fondo `#f4f6fd`.
  1. Diferencia de importe con la O/C
  2. Proveedor inexistente en Tango
  3. Falta remito asociado
  4. CAE vencido o inválido
  5. Precio distinto al acordado
- Textarea de nota: alto 74px, borde `1px solid #e3e1dc`, radio 7px, `padding: 10px 12px`, 13px, `resize: none`. Placeholder "Nota para el equipo (opcional)".
- Acciones a la derecha: "Cancelar" (fondo `#f2f1ed`, borde `1px solid #e3e1dc`) y "Marcar en observación" (fondo `#8a5a00`, texto `#fff`) — ambos alto 36px, radio 7px, 13px.
- Al confirmar: estado → `observacion`, entrada de historial "En observación: {motivo}", vuelve a la bandeja, toast.

### 5. Header global

Alto 56px, fondo `#17191d`, texto `#fff`, `padding: 0 24px`, `flex: none`, `gap: 20px`.
- Logo: cuadrado 22px radio 5px fondo `#2b4fd0`, letra "C" 12px/700. Nombre "Comprobantes" 14px/600. Separador `border-left: 1px solid #33363d`, `padding-left: 10px`, "Cuentas a pagar" 11px `#8b8f97`.
- Derecha: indicador de conexión — punto 7px verde `#3ea37c` + "Tango · BD PRODUCCION" 12px `#b9bcc2`. (Debe reflejar el estado real de la conexión a SQL Server; rojo/ámbar si está caída, y bloquear "Registrar en Tango".)
- Avatar 26px circular fondo `#3b3e45`, iniciales 11px/600, nombre 12.5px, separados por `border-left: 1px solid #33363d`, `padding-left: 16px`.

### Chip de confianza

Se muestra junto a cada label de campo y en la columna Confianza de la tabla. `inline-flex`, alto 19px, `padding: 0 7px`, radio 10px, IBM Plex Mono 11px. Valor: porcentaje entero.
- `< 0.80` → fondo `#fae7e3`, color `#a03526` (y el input toma el estilo de baja confianza)
- `0.80 – 0.93` → fondo `#fbf0dc`, color `#8a5a00`
- `> 0.93` → fondo `#eef0f2`, color `#6b7078`
- Confianza 100% (campos derivados o de imputación manual): el chip se oculta.

### Toast

`position: fixed`, `left: 50%`, `bottom: 28px`, `transform: translateX(-50%)`, fondo `#17191d`, texto `#fff` 13px, `padding: 12px 20px`, radio 9px, `box-shadow: 0 6px 24px rgba(0,0,0,.22)`, `z-index: 70`, animación `riseIn .2s ease-out`. Auto-dismiss a los **2600 ms**.

---

## Interactions & Behavior

- **Click en fila de la tabla** → abre la revisión de ese comprobante, resetea el resaltado.
- **Click en tab de filtro** → filtra por estado. Combina con la búsqueda (AND).
- **Búsqueda** → substring case-insensitive sobre proveedor + CUIT + número. En producción debe ser server-side con debounce (~250 ms) y paginación.
- **Focus en input** → resalta la zona del PDF. **Blur** → apaga el resaltado.
- **Editar un input** → guarda el valor en el borrador de ese comprobante; el valor editado prevalece sobre el de la IA. En producción: autosave con debounce, y marcar el campo como "corregido por el usuario" (dato valioso para medir la precisión del modelo).
- **"Confirmar datos"** → estado `confirmado`, entrada de historial, toast, permanece en la pantalla. Debe bloquearse si hay validaciones en error.
- **"Registrar en Tango"** → estado `registrado`, entrada de historial con el número de asiento, toast con el comprobante generado, vuelve a la bandeja. Operación transaccional: si SQL falla, el estado NO cambia y se muestra el error.
- **"Marcar en observación"** → abre el modal. Motivo obligatorio.
- **"Reprocesar"** → re-envía el PDF a la IA; estado vuelve a `procesando`. Debe advertir que se descartan las correcciones manuales.
- **Animaciones**: `riseIn` (modales y toast) — `from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none }`, 180–200 ms `ease-out`. Sin más animación que eso: es una herramienta de alto volumen.
- **Scroll**: bandeja y cada panel de la revisión scrollean independientemente; los headers y la barra de acciones nunca scrollean.
- **Responsive**: diseñado para escritorio (≥ 1280px). La tabla tiene scroll horizontal por debajo de 1010px de área útil. No hay diseño mobile.

### Atajos de teclado (recomendados, no en el prototipo)
Con 100 comprobantes por día valen mucho: `Tab` entre campos, `Ctrl+Enter` = confirmar, `Ctrl+O` = observación, `J`/`K` o `↑`/`↓` = comprobante anterior/siguiente sin volver a la bandeja.

## State Management

Estado del prototipo (server state en producción):
- `view`: `'inbox' | 'review'` → en producción, ruteo real (`/comprobantes`, `/comprobantes/:id`).
- `filter`: estado seleccionado o `'todos'`.
- `query`: texto de búsqueda.
- `docs[]`: los comprobantes. Cada uno: `id, tipo, nro, fecha, proveedor, cuit, total, estado, conf, file`.
- `selId`: comprobante abierto.
- `edits`: `{ [docId]: { [fieldKey]: value } }` — correcciones del usuario, prevalecen sobre lo extraído.
- `hl`: clave del campo enfocado, para el resaltado del PDF.
- `showImport`, `uploading`, `uploadFiles[]`: modal de importación.
- `showObs`, `obsMotivo`, `obsNota`: modal de observación.
- `hist`: `{ [docId]: entrada[] }` — auditoría.
- `toast`: mensaje actual o `null`.

### Datos que hace falta traer del servidor
- Lista paginada de comprobantes con filtro + búsqueda.
- Detalle del comprobante: campos extraídos con **valor + confianza + bbox**, renglones, y el PDF.
- Maestros de Tango: proveedores (por CUIT), talonarios, condiciones de compra, cuentas contables, centros de costo.
- Resultado de las 4 validaciones.
- Endpoint de registro en Tango (transaccional, idempotente por `docId` para evitar doble grabación).

## Design Tokens

**Colores**
| Uso | Hex |
|---|---|
| Fondo de app | `#f2f1ed` |
| Fondo de panel derecho | `#f7f6f3` |
| Fondo del visor de PDF | `#e6e4df` |
| Superficie / tarjeta | `#ffffff` |
| Fondo de header de tabla | `#faf9f7` |
| Texto principal | `#17191d` |
| Texto secundario | `#5c6068` |
| Texto terciario | `#7b7f87` |
| Texto tenue / labels de tabla | `#82868e`, `#8b8f97`, `#9a9ea6` |
| Borde | `#e3e1dc` |
| Borde de input | `#dcdad5` |
| Borde sutil / divisor | `#f0efec`, `#f4f3f0`, `#eeece8` |
| Borde del visor de PDF | `#d8d5cf` |
| Dashed dropzone | `#c9c6c0` |
| Acento / focus | `#2b4fd0` (hover `#1b39a3`) |
| Acento tenue | `#e7eef9`, `#f4f6fd` |
| Éxito / registrado | `#1c7355`, fondo `#e3f1ea` |
| Punto de conexión OK | `#3ea37c` |
| Advertencia / observación | `#8a5a00`, fondo `#fbf0dc`, borde `#e0cfa4`, hover `#fdf6e7` |
| Error | `#a03526`, fondo `#fae7e3`, borde `#e6b9b0`, fondo de input `#fdf6f4` |
| IA / procesando | `#4a3fa8`, fondo `#eceaf6` |
| Etiqueta PDF | `#b03a2b` |
| Superficies de header oscuro | `#17191d`, `#33363d`, `#3b3e45`, texto `#b9bcc2` |
| Overlay de modal | `rgba(23,25,29,.45)` |
| Resaltado en PDF | fondo `rgba(43,79,208,.13)`, outline `rgba(43,79,208,.5)` |

**Tipografía** — `IBM Plex Sans` (400/500/600/700) para UI; `IBM Plex Mono` (400/500/600) para todo lo numérico o codificado: importes, CUIT, CAE, números de comprobante, fechas, timestamps, porcentajes. Es la regla tipográfica central del diseño: **cualquier dato que el usuario coteja contra el PDF va en mono**, para que los dígitos se alineen.

Escala: 27px/600 (KPI) · 23px/600 (h1) · 17px/600 (título de modal) · 15.5px/600 (título de doc) · 14px/600 (marca) · 13.5px (input, nombre de proveedor) · 13px (body, botones) · 12.5px (celdas, secundario) · 12px (metadatos) · 11.5px (labels, badges, chips) · 11px (headers de tabla, uppercase).

**Espaciado** — 4 / 5 / 6 / 7 / 8 / 9 / 10 / 12 / 14 / 16 / 18 / 20 / 22 / 24 / 26 / 28 / 34 / 40 / 52 px. Gap de tarjetas 12px; gap de campos 12px; separación entre bloques 16px.

**Radios** — 5 (logo) · 6 (botón chico) · 7 (input, botón, tab) · 9 (tarjeta, toast) · 10 (tabla, dropzone) · 11 (badge) · 12 (modal) · 50% (avatar, punto).

**Sombras** — hoja de PDF `0 2px 14px rgba(0,0,0,.13)` · toast `0 6px 24px rgba(0,0,0,.22)` · focus ring `0 0 0 3px rgba(43,79,208,.12)`.

**Alturas** — header 56px · fila de tabla 50px (compacta 40px) · header de tabla 38px · botón primario 36–38px · input 36px · tab/buscador 34px · botón chico 30–32px · badge 21px · chip 19px.

## Assets
Ninguno. No hay imágenes ni íconos externos: los glifos (`✓ ✕ ! ✦ ⌕ ⇪ › ← +`) son caracteres Unicode y en producción deberían reemplazarse por los íconos del design system del codebase. La única dependencia externa son las fuentes IBM Plex Sans / Mono desde Google Fonts.

## Files
- `screenshots/` — capturas del prototipo: `01-bandeja`, `02-modal-importar`, `03-revision`, `04-revision-campo-enfocado`, `05-modal-observacion`. **Nota:** tomadas en un viewport angosto (~920px), por lo que el layout aparece más comprimido de lo previsto; el diseño está pensado para ≥1280px. Para medidas y colores exactos usar este README, no las capturas.
- `Importador de Facturas.dc.html` — el prototipo completo (bandeja, revisión, ambos modales, toasts). Referencia de diseño: se lee, no se porta.

## Preguntas abiertas — resolver antes de implementar
1. **Módulo y operación de Tango**: ¿Compras → ingreso de factura de proveedor? ¿Qué comprobante/talonario genera?
2. **Detalle vs cabecera**: ¿el movimiento lleva renglones de artículos o solo cabecera + imputación contable?
3. **Acceso a datos**: ¿INSERT directo por SQL Server sobre las tablas de Tango, o API de Tango Delta? (Escribir directo en las tablas de Tango es riesgoso y suele romper la integridad del ERP.)
4. **Multiempresa / multisucursal**: ¿hay que elegir empresa y depósito? Si sí, va como selector en el header.
5. **Aprobación**: ¿alcanza que el administrativo confirme, o hace falta un segundo aprobador antes de grabar? (El modelo de estados soporta insertar un `pendiente_aprobacion` entre `confirmado` y `registrado`.)
6. **Origen de los PDF**: ¿solo carga manual, o también buzón de email / portal de proveedores?
7. **Consulta a ARCA** para validar CAE: ¿en alcance o no?
