# Registro en Tango por conceptos

**Fecha:** 2026-08-09
**Estado:** aprobado, pendiente de plan de implementación
**Depende de:** Fase 4 integrada en `master` (`registrarComprobanteEn`, panel "Listo para registrar", selectores de percepción)

---

## 1. Qué se construye

Hoy `registrarComprobanteEn` solo sabe grabar renglones de artículo (`CPA46`, vía remito asignado — Fase 4, Task 7) o cabecera sola. Faltaba el otro camino real del negocio: facturas de **conceptos** (servicios, sin remito ni stock de por medio), que en Tango se graban distinto — un renglón en `CPA47` con el código de concepto del proveedor, no un artículo.

El operador va a elegir, para cada comprobante, si es "por conceptos" o "por artículos" antes de poder registrarlo. Por conceptos ya se implementa completo en este trabajo; por artículos sigue exactamente como está desde Fase 4 — no se toca nada de esa ruta.

## 2. Decisiones

| Punto | Decisión | Motivo |
|---|---|---|
| Cómo se clasifica la factura | Selector nuevo `tipoFactura` (`'conceptos'` \| `'articulos'`), elegido a mano por el operador | Decisión explícita del usuario — no hay forma confiable de inferirlo solo de los datos extraídos |
| `tipoFactura` vacío | Bloquea "Registrar en Tango" | Mismo criterio sin-default-silencioso del resto de Fase 4 |
| Ruta "por artículos" | Sin cambios — sigue el camino de Fase 4 tal cual (CPA46 vía remito si hay, o solo cabecera) | Decisión explícita del usuario: este trabajo es aditivo, no reemplaza nada que ya funciona |
| Renglones de CPA47 por factura | Uno solo (no uno por `PHF_RENGLON`) | Decisión explícita del usuario, confirmada contra la base real: 13.030 de 13.062 facturas de conceptos (99,75%) tienen exactamente un renglón en `CPA47`. El único caso encontrado con más de uno (`NCOMP_IN_C=17245`, 2 conceptos) es la excepción, no el patrón — queda fuera de este alcance |
| Concepto no encontrado para el proveedor | Bloquea el registro | Decisión explícita del usuario. Hoy `CPA_CONCEPTOS_PROVEEDOR` tiene una sola fila cargada de 666 proveedores (`010151`, concepto `712`) — va a ser el caso común hasta que se cargue más data en Tango, y no hay forma de adivinar un concepto sin arriesgar una imputación contable mal hecha |
| Panel "Remitos pendientes" con `tipoFactura='conceptos'` | Se oculta | Un concepto no se ata a un remito — mostrar el selector sería confuso y no lleva a ningún lado |
| Panel "Renglones detectados" con `tipoFactura='conceptos'` | Sigue igual, sin cambios | Es puramente informativo (lo que la IA extrajo del PDF); nunca se escribió 1:1 contra Tango, tampoco ahora |

## 3. Arquitectura

Respeta la frontera ya establecida: `src/server/tango/` es la única capa que toca tablas de Tango; el `INSERT` a `CPA47` vive en el único archivo que ya escribe el ERP (`comprobantes.ts`).

### 3.1. Lectura nueva — `src/server/tango/conceptos.ts` (nuevo archivo)

Mismo patrón que `condicionesCompra.ts`/`impuestos.ts`/`remitos.ts`: solo lectura, sin ambigüedad de cardinalidad porque hoy es 1:1 proveedor→concepto en toda la base.

```ts
export type ConceptoProveedor = { codConcepto: string; descripcion: string }
export async function buscarConceptoProveedor(codProvee: string): Promise<ConceptoProveedor | null>
```

`SELECT` contra `CPA_CONCEPTOS_PROVEEDOR` (por `COD_PROVEE`) con `JOIN CPA45` (por `ID_CPA45`) para traer también `DESC_CONCE` — se usa en el mensaje del panel "Listo para registrar" para que el operador vea qué concepto se va a grabar, no solo el código.

Se usa en dos lugares: `validarListoParaRegistrarEn` (para mostrar el chequeo antes de intentar registrar) y dentro de `registrarComprobanteEn` (para el `INSERT` real) — mismo doble uso que ya tienen `listarCondicionesCompra`/`mapearAlicuotaIva`.

### 3.2. Catálogo de campos — `src/lib/campos.ts`

Nuevo campo en el grupo `imputacion`, junto a `condcompra`:

```ts
{ clave: 'tipoFactura', label: 'Tipo de factura', grupo: 'imputacion', span: 3,
  tipo: 'select', mono: false, extraePorIA: false, soloLectura: false }
```

A diferencia de `codpercibb`/`codpercepiva` (poblados con datos de Tango), las opciones de este select son fijas en el propio `Formulario` — "Por conceptos" / "Por artículos" — no vienen de una consulta.

### 3.3. Validación pura — `src/lib/validaciones.ts`

```ts
export function validarTipoFactura(valor: string | null | undefined): ResultadoValidacion
```

`error` si está vacío ("Elegí el tipo de factura antes de registrar"), `ok` si tiene cualquiera de los dos valores válidos.

### 3.4. Orquestación — `src/server/app/validaciones.ts`

`ResultadoListoParaRegistrar` gana dos campos:

```ts
export type ResultadoListoParaRegistrar = {
  condCompra: ResultadoValidacion
  percepcionIibb: ResultadoValidacion
  percepcionIva3: ResultadoValidacion
  formatoComp: ResultadoValidacion
  tipoFactura: ResultadoValidacion   // nuevo
  concepto: ResultadoValidacion      // nuevo
  bloqueante: boolean
}
```

`concepto` solo se evalúa contra Tango (`buscarConceptoProveedor`) cuando `tipoFactura === 'conceptos'` y `codprovee` ya está resuelto; en cualquier otro caso es `'ok'`/"No aplica" (mismo patrón que `percepcionIva3` cuando no hay slot al 3%). `bloqueante` pasa a considerar los 6 resultados, no 4.

### 3.5. Escritura — `src/server/tango/comprobantes.ts`

Dentro de `registrarComprobanteEn`, después de resolver la cabecera (`CPA04`/`CTA05`) y antes del bloque de renglones-con-remito existente:

```ts
if (valores.tipoFactura === 'conceptos') {
  const concepto = await buscarConceptoProveedor(codProvee)
  if (!concepto) throw new Error(`El proveedor ${codProvee} no tiene un concepto configurado en Tango.`)
  // INSERT CPA47: un solo renglon
  //   COD_CONCEP = concepto.codConcepto
  //   NCOMP_IN_C = el recien generado, TCOMP_IN_C = 'FP', N_RENGL_C = 1
  //   IMPORTE_GRAVADO = neto, IMPORTE_EXENTO = exento
  //   IMPORTE_NE = IMPORT_PAN = IMP_NETO_P = neto + exento
  //   FECHA_MOV = fecha de emision del comprobante
}
// El bloque existente de renglones-con-remito (CPA46/CTA07/CPA48) sigue
// corriendo exactamente igual, sin condicionarlo a tipoFactura -- por
// diseño (ver 2.), una factura "por conceptos" simplemente no va a tener
// renglones con remito asignado en la práctica, así que el bloque
// existente no hace nada si no hay ninguno. No hace falta un `if`
// excluyente entre las dos rutas.
```

El chequeo de `tipoFactura`/concepto vuelve a correr server-side dentro de la propia transacción de registro (mismo criterio que las validaciones de Fase 3/4: lo que se muestra en pantalla se revalida al escribir, no se confía ciegamente en lo que ya se mostró).

### 3.6. UI

- `src/components/revision/listo-para-registrar.tsx`: el array `items` gana `resultado.tipoFactura` y `resultado.concepto`.
- `src/components/revision/formulario.tsx`: `opcionesPara()` gana un caso para `tipoFactura` con las dos opciones fijas.
- `src/components/revision/pantalla.tsx` / `src/app/comprobantes/[id]/page.tsx`: `<RemitosPendientes>` se deja de renderizar (o se le pasa una lista vacía) cuando el valor final de `tipoFactura` es `'conceptos'`.

## 4. Manejo de errores

- `tipoFactura` vacío: bloquea "Registrar en Tango" desde el panel, igual que `condCompra` vacío.
- `tipoFactura='conceptos'` y proveedor sin fila en `CPA_CONCEPTOS_PROVEEDOR`: bloquea desde el panel con mensaje explícito ("Este proveedor no tiene un concepto configurado en Tango"), y si de todos modos se llega a intentar registrar (carrera, o el concepto se borró de Tango entre que se mostró el panel y se hizo click), `registrarComprobanteEn` tira el mismo error dentro de la transacción — no se inserta nada a medias.

## 5. Testing

- `buscarConceptoProveedor` contra la base real: devuelve el concepto para `010151` (el único cargado hoy), `null` para cualquier otro proveedor.
- `validarTipoFactura`: `error` vacío, `ok` con cualquiera de los dos valores.
- `validarListoParaRegistrarEn`: `concepto` en `'ok'`/no aplica cuando `tipoFactura` no es `'conceptos'`; en `error` cuando lo es y el proveedor no tiene concepto; en `ok` cuando sí lo tiene (usar `010151` como proveedor de prueba, mismo que ya usan los tests de Fase 3/4).
- `registrarComprobanteEn` con `tipoFactura='conceptos'` contra la base real, dentro de `conRollback`: verifica el `INSERT` en `CPA47` con las columnas esperadas, usando `010151` como proveedor de prueba (factura de referencia real de toda la sesión).
- Verificación manual en el navegador: registrar una factura de conceptos real (proveedor `010151`, el mismo caso de AMX/Claro ya usado en Fase 4) y confirmar contra la base que `CPA47` tiene la fila esperada.

---

## Caso borde aceptado

Si un renglón ya tenía un remito asignado (desde antes, con `tipoFactura` en blanco o en `'articulos'`) y el operador después cambia `tipoFactura` a `'conceptos'`, el bloque existente de `CPA46` en `registrarComprobanteEn` lo va a seguir procesando igual — no está condicionado a `tipoFactura` a propósito (ver 3.5). Ocultar el panel "Remitos pendientes" evita que se asigne uno *nuevo* mientras `tipoFactura='conceptos'`, pero no desasigna uno que ya estaba. Se acepta este caso borde en vez de agregar un `if` que condicione el bloque de `CPA46` — eso sí sería "tocar" esa ruta, y la decisión explícita fue dejarla tal cual. Si en la práctica esto genera confusión, es candidato a resolver en un trabajo aparte (por ejemplo, desasignar el remito automáticamente al cambiar a `'conceptos'`).

## Notas para quien escriba el plan

- No hace falta ninguna migración de esquema — `tipoFactura` es una fila más del catálogo de `PHF_CAMPO`, mismo mecanismo que `condcompra`.
- El único proveedor con concepto cargado hoy (`010151`) es la misma factura de referencia (AMX/Claro) que se usó para verificar Fase 4 de punta a punta — conviene reusarla también acá para el test manual.
- `IMPORTE_NE = IMPORT_PAN = IMP_NETO_P = neto + exento` está derivado empíricamente de las filas limpias de `CPA47` (no de documentación de Axoft, que no detalla la semántica exacta de estas columnas). Hay filas viejas de 2021 en la base donde `IMPORTE_NE`/`IMP_NETO_P` quedaron en 0 mientras `IMPORT_PAN` tenía el valor real — parecen basura de otro proceso o versión anterior de Tango, no el patrón a seguir. Si al implementar contra la base real algo no cuadra, verificar con una consulta directa antes de asumir que el plan está mal, mismo criterio que Fase 4.
