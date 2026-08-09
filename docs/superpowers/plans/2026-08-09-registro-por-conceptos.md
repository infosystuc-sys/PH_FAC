# Registro en Tango por conceptos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un segundo camino de registro en Tango — "por conceptos" — que graba un renglón en `CPA47` usando el concepto configurado del proveedor en `CPA_CONCEPTOS_PROVEEDOR`, elegible por el operador junto al camino existente "por artículos" (sin cambios).

**Architecture:** Extiende lo que ya existe desde Fase 4: nuevo campo select `tipoFactura` en el catálogo (`src/lib/campos.ts`), validación pura y orquestación en el panel "Listo para registrar", una lectura nueva de solo lectura en `src/server/tango/conceptos.ts` (mismo patrón que `condicionesCompra.ts`/`impuestos.ts`/`remitos.ts`), y un bloque nuevo dentro de `registrarComprobanteEn` (único punto de escritura del ERP) que inserta en `CPA47` cuando `tipoFactura === 'conceptos'`. La ruta "por artículos" (CPA46 vía remito) no se toca.

**Tech Stack:** Next.js 15 (App Router, Server Components + Server Actions), TypeScript, `mssql`, Vitest, CSS Modules.

## Global Constraints

- `CPA_CONCEPTOS_PROVEEDOR` y `CPA47` están documentadas en Axoft (módulo Compras: <https://ayudas.axoft.com/21ar/documentos/operacion/tablas_oper/tablascompras_oper/>) — verificado antes de escribir esta spec.
- Solo `src/server/tango/` puede emitir SQL contra `CPA*`/`STA*`/`CTA*`. Ningún otro módulo las nombra.
- Toda consulta va parametrizada con `.input(...)`. Nunca concatenar valores de usuario en el SQL.
- `tipoFactura` toma exactamente dos valores de texto: `'conceptos'` y `'articulos'`. Sin elegir, bloquea "Registrar en Tango" — sin default silencioso, mismo criterio que `condcompra` desde Fase 4.
- La ruta "por artículos" (bloque de `CPA46`/`CTA07`/`CPA48` en `registrarComprobanteEn`, ya implementado desde Fase 4) no se modifica en ningún task de este plan.
- Un solo renglón de `CPA47` por comprobante (no uno por `PHF_RENGLON`) — confirmado contra la base real: 13.030 de 13.062 facturas de conceptos (99,75%) tienen exactamente un renglón en `CPA47`.
- `IMPORTE_NE = IMPORT_PAN = IMP_NETO_P = neto + exento`, `IMPORTE_GRAVADO = neto`, `IMPORTE_EXENTO = exento` — derivado empíricamente de las filas consistentes de `CPA47` (ver spec, no hay documentación de Axoft que detalle esto).
- Commits en español, imperativo, terminando en `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Tests: la mayoría pegan contra SQL Server real (`PUNTO_HOGAR_1`). Los que escriben van dentro de `conRollback` (`src/server/db/tx.ts`) y no asumen que las tablas están vacías.
- El único proveedor con concepto configurado hoy es `010151` (AMX/Claro, concepto `712`, descripción "TELEFONOS LOCALES") — úsalo para los tests que necesitan un proveedor con concepto real, y para la verificación manual.

---

## Mapa de archivos

| Archivo | Qué hace |
|---|---|
| `src/lib/campos.ts` (extender) | Campo nuevo `tipoFactura` (select, grupo `imputacion`) |
| `src/lib/validaciones.ts` (extender) | `validarTipoFactura` |
| `src/server/tango/conceptos.ts` (nuevo) | `buscarConceptoProveedor` — lectura de `CPA_CONCEPTOS_PROVEEDOR`/`CPA45` |
| `src/server/app/validaciones.ts` (extender) | `ResultadoListoParaRegistrar` gana `tipoFactura`/`concepto`; `validarListoParaRegistrarEn` los calcula |
| `src/server/tango/comprobantes.ts` (extender) | `registrarComprobanteEn` inserta en `CPA47` cuando corresponde |
| `src/components/revision/listo-para-registrar.tsx` (modificar) | Muestra los dos chequeos nuevos |
| `src/components/revision/formulario.tsx` (modificar) | `opcionesPara()` gana el caso `tipoFactura` (opciones fijas) |
| `src/app/comprobantes/[id]/page.tsx` (modificar) | No trae remitos pendientes cuando `tipoFactura === 'conceptos'` |

---

### Task 1: Catálogo de campos — `tipoFactura`

**Files:**
- Modify: `src/lib/campos.ts`
- Test: `tests/lib/campos.test.ts`

**Interfaces:**
- Produces: una entrada nueva en `CAMPOS`, clave `tipoFactura`, `tipo: 'select'`.

- [ ] **Step 1: Escribir el test que falla**

Agregar a `tests/lib/campos.test.ts`, junto a los tests existentes de `condcompra`/`codpercibb`/`codpercepiva`:

```ts
it('tipoFactura es un campo de tipo select', () => {
  expect(campoPorClave('tipoFactura')?.tipo).toBe('select')
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/lib/campos.test.ts -t tipoFactura`
Expected: FAIL — `campoPorClave('tipoFactura')` devuelve `undefined`

- [ ] **Step 3: Implementar**

En `src/lib/campos.ts`, agregar la entrada al final del array `CAMPOS`, después de `condcompra`:

```ts
  { clave: 'condcompra', label: 'Condición de compra', grupo: 'imputacion', span: 3,
    tipo: 'select', mono: false, extraePorIA: false, soloLectura: false },
  { clave: 'tipoFactura', label: 'Tipo de factura', grupo: 'imputacion', span: 3,
    tipo: 'select', mono: false, extraePorIA: false, soloLectura: false },
]
```

(Reemplaza el cierre `]` existente después de `condcompra` — la entrada de `tipoFactura` se agrega antes de ese `]`.)

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run tests/lib/campos.test.ts`
Expected: PASS (todos los tests del archivo)

- [ ] **Step 5: Commit**

```bash
git add src/lib/campos.ts tests/lib/campos.test.ts
git commit -m "$(cat <<'EOF'
Agregar tipoFactura al catálogo de campos

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Validación pura — `validarTipoFactura`

**Files:**
- Modify: `src/lib/validaciones.ts`
- Test: `tests/lib/validaciones.test.ts`

**Interfaces:**
- Consumes: `ResultadoValidacion` (ya existe en este archivo).
- Produces: `validarTipoFactura(valor: string | null | undefined): ResultadoValidacion`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `tests/lib/validaciones.test.ts`, junto al `import` existente (agregar `validarTipoFactura` a la lista de imports de `@/lib/validaciones`) y junto al `describe('validarCondCompra', ...)`:

```ts
describe('validarTipoFactura', () => {
  it('ok si es "conceptos" o "articulos"', () => {
    expect(validarTipoFactura('conceptos').estado).toBe('ok')
    expect(validarTipoFactura('articulos').estado).toBe('ok')
  })
  it('error si esta vacio o ausente', () => {
    expect(validarTipoFactura('').estado).toBe('error')
    expect(validarTipoFactura(null).estado).toBe('error')
    expect(validarTipoFactura(undefined).estado).toBe('error')
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/lib/validaciones.test.ts -t validarTipoFactura`
Expected: FAIL — `validarTipoFactura is not a function`

- [ ] **Step 3: Implementar**

En `src/lib/validaciones.ts`, agregar después de `validarCondCompra`:

```ts
export function validarTipoFactura(tipoFactura: string | null | undefined): ResultadoValidacion {
  const v = (tipoFactura ?? '').trim()
  if (!v) {
    return { estado: 'error', mensaje: 'Elegí el tipo de factura antes de registrar.' }
  }
  return { estado: 'ok', mensaje: 'Tipo de factura elegido.' }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/lib/validaciones.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/validaciones.ts tests/lib/validaciones.test.ts
git commit -m "$(cat <<'EOF'
Agregar validarTipoFactura

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Lectura de Tango — `buscarConceptoProveedor`

**Files:**
- Create: `src/server/tango/conceptos.ts`
- Test: `tests/server/tango/conceptos.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ConceptoProveedor = { codConcepto: string; descripcion: string }
  export async function buscarConceptoProveedor(codProvee: string): Promise<ConceptoProveedor | null>
  ```

- [ ] **Step 1: Escribir los tests que fallan**

Crear `tests/server/tango/conceptos.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { cerrarPool } from '@/server/db/pool'
import { buscarConceptoProveedor } from '@/server/tango/conceptos'

afterAll(async () => {
  await cerrarPool()
})

describe('buscarConceptoProveedor', () => {
  it('encuentra el concepto real de un proveedor cargado (010151, AMX/Claro)', async () => {
    const r = await buscarConceptoProveedor('010151')
    expect(r).not.toBeNull()
    expect(r!.codConcepto).toBe('712')
    expect(r!.descripcion).toBe('TELEFONOS LOCALES')
  })

  it('devuelve null si el proveedor no tiene concepto configurado', async () => {
    const r = await buscarConceptoProveedor('999999')
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/tango/conceptos.test.ts`
Expected: FAIL — no se puede resolver el módulo `@/server/tango/conceptos`

- [ ] **Step 3: Implementar**

Crear `src/server/tango/conceptos.ts`:

```ts
import sql from 'mssql'
import { getPool } from '../db/pool'

export type ConceptoProveedor = { codConcepto: string; descripcion: string }

/**
 * CPA_CONCEPTOS_PROVEEDOR es 1:1 por proveedor en toda la base hoy (ningun
 * COD_PROVEE tiene mas de una fila) -- no hace falta manejar ambiguedad como
 * con las percepciones de Fase 4. ID_CPA45 enlaza al maestro de conceptos
 * (CPA45), de donde sale la descripcion para mostrarle al operador cual
 * concepto se va a grabar, no solo el codigo.
 */
export async function buscarConceptoProveedor(codProvee: string): Promise<ConceptoProveedor | null> {
  const cod = codProvee.trim()
  if (!cod) return null

  const pool = await getPool()
  const r = await pool
    .request()
    .input('cod', sql.VarChar(6), cod)
    .query(`
      SELECT cp.COD_CONCEPT AS codConcepto, LTRIM(RTRIM(ISNULL(c.DESC_CONCE,''))) AS descripcion
      FROM CPA_CONCEPTOS_PROVEEDOR cp
      LEFT JOIN CPA45 c ON c.ID_CPA45 = cp.ID_CPA45
      WHERE cp.COD_PROVEE = @cod
    `)

  if (r.recordset.length === 0) return null
  const row = r.recordset[0]
  return { codConcepto: String(row.codConcepto).trim(), descripcion: String(row.descripcion) }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/tango/conceptos.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/tango/conceptos.ts tests/server/tango/conceptos.test.ts
git commit -m "$(cat <<'EOF'
Agregar la lectura de conceptos de proveedor (CPA_CONCEPTOS_PROVEEDOR)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Orquestación — extender "Listo para registrar"

**Files:**
- Modify: `src/server/app/validaciones.ts`
- Test: `tests/server/app/validaciones.test.ts`

**Interfaces:**
- Consumes: `validarTipoFactura` (Task 2), `buscarConceptoProveedor` (Task 3).
- Produces: `ResultadoListoParaRegistrar` gana dos campos:
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

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `tests/server/app/validaciones.test.ts`, dentro de `describe('validarListoParaRegistrarEn', ...)`, junto a los tests existentes:

```ts
it('bloqueante si falta tipoFactura', async () => {
  await conRollback(async (tx) => {
    const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
    await guardarCampoEn(tx, id, 'condcompra', '60')

    const r = await validarListoParaRegistrarEn(tx, id)
    expect(r.tipoFactura.estado).toBe('error')
    expect(r.bloqueante).toBe(true)
  })
})

it('concepto no aplica si tipoFactura es "articulos"', async () => {
  await conRollback(async (tx) => {
    const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
    await guardarCampoEn(tx, id, 'condcompra', '60')
    await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')

    const r = await validarListoParaRegistrarEn(tx, id)
    expect(r.tipoFactura.estado).toBe('ok')
    expect(r.concepto.estado).toBe('ok')
    expect(r.concepto.mensaje).toBe('No aplica.')
  })
})

it('bloqueante si tipoFactura es "conceptos" y el proveedor no tiene concepto configurado', async () => {
  await conRollback(async (tx) => {
    const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
    await guardarCampoEn(tx, id, 'condcompra', '60')
    await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
    await guardarCampoEn(tx, id, 'codprovee', '999999')

    const r = await validarListoParaRegistrarEn(tx, id)
    expect(r.concepto.estado).toBe('error')
    expect(r.bloqueante).toBe(true)
  })
})

it('ok si tipoFactura es "conceptos" y el proveedor tiene concepto configurado (010151)', async () => {
  await conRollback(async (tx) => {
    const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
    await guardarCampoEn(tx, id, 'condcompra', '60')
    await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
    await guardarCampoEn(tx, id, 'codprovee', '010151')

    const r = await validarListoParaRegistrarEn(tx, id)
    expect(r.concepto.estado).toBe('ok')
  })
})
```

Además, **corregir el test existente** `'no bloqueante si todo esta completo'` (ya en el archivo, dentro del mismo `describe`) — hoy no setea `tipoFactura`, y con este cambio eso lo va a dejar bloqueante. Agregar la línea que falta:

```ts
  it('no bloqueante si todo esta completo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0011')
      await guardarCampoEn(tx, id, 'nro', '63576')
      await guardarCampoEn(tx, id, 'condcompra', '60')
      await guardarCampoEn(tx, id, 'perciibb', '13.248,69')
      await guardarCampoEn(tx, id, 'codpercibb', '60')
      await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')  // <- agregar esta línea

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.condCompra.estado).toBe('ok')
      expect(r.percepcionIibb.estado).toBe('ok')
      expect(r.percepcionIva3.estado).toBe('ok')
      expect(r.formatoComp.estado).toBe('ok')
      expect(r.bloqueante).toBe(false)
    })
  })
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/app/validaciones.test.ts -t "tipoFactura|concepto"`
Expected: FAIL — `r.tipoFactura`/`r.concepto` son `undefined`

- [ ] **Step 3: Implementar**

En `src/server/app/validaciones.ts`, agregar el import de `validarTipoFactura` a la lista existente que ya trae de `@/lib/validaciones`, y agregar el import de `buscarConceptoProveedor`:

```ts
import {
  letraComprobante,
  nComp as armarNComp,
  validarProveedor,
  validarDuplicado,
  validarTotales,
  validarCae,
  validarFormatoNComp,
  validarCondCompra,
  validarPercepcionIva,
  validarTipoFactura,
  type ResultadoValidacion,
} from '@/lib/validaciones'
import { buscarConceptoProveedor } from '@/server/tango/conceptos'
```

Extender el tipo `ResultadoListoParaRegistrar`:

```ts
export type ResultadoListoParaRegistrar = {
  condCompra: ResultadoValidacion
  percepcionIibb: ResultadoValidacion
  percepcionIva3: ResultadoValidacion
  formatoComp: ResultadoValidacion
  tipoFactura: ResultadoValidacion
  concepto: ResultadoValidacion
  bloqueante: boolean
}
```

Extender `validarListoParaRegistrarEn`:

```ts
export async function validarListoParaRegistrarEn(
  e: Ejecutor,
  id: number,
  detallePrevio?: Detalle,
): Promise<ResultadoListoParaRegistrar> {
  const detalle = detallePrevio ?? (await obtenerDetalleEn(e, id))
  const valores: Record<string, string | null | undefined> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const condCompra = validarCondCompra(valores.condcompra)
  const percepcionIibb = validarPercepcionIva('IIBB', valores.perciibb, valores.codpercibb)
  const slotIva3 = [1, 2, 3, 4, 5].find((i) => Number(valores[`porciva${i}`]) === 3)
  const importeIva3 = slotIva3 ? valores[`impiva${slotIva3}`] : null
  const percepcionIva3 = validarPercepcionIva('IVA3', importeIva3, valores.codpercepiva)
  const formatoComp = validarFormatoNComp(valores.ptovta, valores.nro)
  const tipoFactura = validarTipoFactura(valores.tipoFactura)

  // El concepto solo aplica si se eligio "por conceptos" -- igual criterio
  // que percepcionIva3 cuando no hay slot al 3%: 'ok'/"No aplica." en vez de
  // forzar un chequeo que no corresponde.
  let concepto: ResultadoValidacion = { estado: 'ok', mensaje: 'No aplica.' }
  if (valores.tipoFactura === 'conceptos') {
    const codProvee = (valores.codprovee ?? '').trim()
    const encontrado = codProvee ? await buscarConceptoProveedor(codProvee) : null
    concepto = encontrado
      ? { estado: 'ok', mensaje: `Concepto: ${encontrado.codConcepto} — ${encontrado.descripcion}.` }
      : { estado: 'error', mensaje: 'Este proveedor no tiene un concepto configurado en Tango.' }
  }

  const bloqueante = [condCompra, percepcionIibb, percepcionIva3, formatoComp, tipoFactura, concepto].some(
    (v) => v.estado === 'error',
  )

  return { condCompra, percepcionIibb, percepcionIva3, formatoComp, tipoFactura, concepto, bloqueante }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/app/validaciones.test.ts`
Expected: PASS (todos los tests del archivo, incluido el que se corrigió)

- [ ] **Step 5: Correr tsc**

Run: `npx tsc --noEmit`
Expected: sin errores

- [ ] **Step 6: Commit**

```bash
git add src/server/app/validaciones.ts tests/server/app/validaciones.test.ts
git commit -m "$(cat <<'EOF'
Agregar tipoFactura y concepto al panel "Listo para registrar"

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Escritura — insertar en `CPA47`

**Files:**
- Modify: `src/server/tango/comprobantes.ts`
- Test: `tests/server/tango/comprobantes.test.ts`

**Interfaces:**
- Consumes: `buscarConceptoProveedor` (Task 3).
- No cambia la firma pública de `registrarComprobanteEn`/`registrarComprobante`.

- [ ] **Step 1: Escribir el test que falla**

Agregar a `tests/server/tango/comprobantes.test.ts`, un nuevo `describe` después de `describe('registrarComprobanteEn con remito asignado', ...)`:

```ts
describe('registrarComprobanteEn con tipoFactura=conceptos', () => {
  it('inserta un renglon en CPA47 con el concepto del proveedor', async () => {
    await conRollback(async (tx) => {
      // 010151 (AMX/Claro) es el unico proveedor con concepto configurado
      // hoy en CPA_CONCEPTOS_PROVEEDOR (concepto 712, "TELEFONOS LOCALES").
      const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const condCompra = String(condicion.recordset[0].COD_CONDIC)

      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0077')
      await guardarCampoEn(tx, id, 'nro', '00011111')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'codprovee', '010151')
      await guardarCampoEn(tx, id, 'condcompra', condCompra)
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'neto', '10.000,00')
      await guardarCampoEn(tx, id, 'exento', '500,00')
      await guardarCampoEn(tx, id, 'total', '10.500,00')

      const registro = await registrarComprobanteEn(tx, id)

      const cpa47 = await tx.request()
        .input('t', sql.VarChar(2), 'FP').input('n', sql.Float, registro.ncompInC)
        .query(`SELECT * FROM CPA47 WHERE TCOMP_IN_C=@t AND NCOMP_IN_C=@n`)
      expect(cpa47.recordset).toHaveLength(1)
      expect(cpa47.recordset[0].COD_CONCEP.trim()).toBe('712')
      expect(Number(cpa47.recordset[0].N_RENGL_C)).toBe(1)
      expect(Number(cpa47.recordset[0].IMPORTE_GRAVADO)).toBe(10000)
      expect(Number(cpa47.recordset[0].IMPORTE_EXENTO)).toBe(500)
      expect(Number(cpa47.recordset[0].IMPORTE_NE)).toBe(10500)
      expect(Number(cpa47.recordset[0].IMPORT_PAN)).toBe(10500)
      expect(Number(cpa47.recordset[0].IMP_NETO_P)).toBe(10500)
    })
  }, 90000)

  it('bloquea el registro si el proveedor no tiene concepto configurado', async () => {
    await conRollback(async (tx) => {
      const prov = await tx.request().query(`
        SELECT TOP 1 p.COD_PROVEE FROM CPA01 p
        WHERE p.COD_PROVEE NOT IN (SELECT COD_PROVEE FROM CPA_CONCEPTOS_PROVEEDOR)
        ORDER BY p.COD_PROVEE`)
      const codProvee = String(prov.recordset[0].COD_PROVEE).trim()

      const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const condCompra = String(condicion.recordset[0].COD_CONDIC)

      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0077')
      await guardarCampoEn(tx, id, 'nro', '00022222')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'codprovee', codProvee)
      await guardarCampoEn(tx, id, 'condcompra', condCompra)
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'total', '100,00')

      await expect(registrarComprobanteEn(tx, id)).rejects.toThrow(/no tiene un concepto configurado/i)
    })
  }, 30000)
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/tango/comprobantes.test.ts -t "tipoFactura=conceptos"`
Expected: FAIL — `CPA47` queda vacía (el código todavía no la escribe) / no se tira el error esperado

- [ ] **Step 3: Implementar**

En `src/server/tango/comprobantes.ts`, agregar el import de `buscarConceptoProveedor`:

```ts
import { buscarConceptoProveedor } from './conceptos'
```

Agregar el bloque nuevo dentro de `registrarComprobanteEn`, después del bloque `// 6. CPA54 (vencimientos)...` y antes de `// 7. Renglones con remito asignado (solo si hay).`:

```ts
  // 6b. CPA47 (renglon de concepto), solo si tipoFactura='conceptos'. Un
  // solo renglon por comprobante -- confirmado contra la base real: 13.030
  // de 13.062 facturas de conceptos (99,75%) tienen exactamente un renglon
  // en CPA47. La ruta "por articulos" (bloque 7, mas abajo) sigue corriendo
  // igual sin condicionarla a esto -- ver spec, "Caso borde aceptado".
  if (valores.tipoFactura === 'conceptos') {
    const concepto = await buscarConceptoProveedor(codProvee)
    if (!concepto) {
      throw new Error(`El proveedor ${codProvee} no tiene un concepto configurado en Tango.`)
    }
    const importeNeRenglon = Math.round((neto + exento) * 100) / 100

    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('codConcep', sql.VarChar(3), concepto.codConcepto).input('fechaMov', sql.DateTime, fechaEmision)
      .input('importeNe', sql.Decimal(18, 2), importeNeRenglon)
      .input('gravado', sql.Decimal(18, 2), neto).input('exentoRenglon', sql.Decimal(18, 2), exento)
      .query(`
        INSERT INTO CPA47 (
          TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, COD_CONCEP, FECHA_MOV,
          IMPORTE_NE, IMPORT_PAN, IMP_NETO_P, IMPORTE_GRAVADO, IMPORTE_EXENTO,
          COD_CLASIF, FILLER
        ) VALUES (
          @tcompInC, @ncompInC, 1, @codConcep, @fechaMov,
          @importeNe, @importeNe, @importeNe, @gravado, @exentoRenglon,
          '', ''
        )`)
  }

```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/tango/comprobantes.test.ts`
Expected: PASS (todos los tests del archivo)

- [ ] **Step 5: Correr tsc**

Run: `npx tsc --noEmit`
Expected: sin errores

- [ ] **Step 6: Commit**

```bash
git add src/server/tango/comprobantes.ts tests/server/tango/comprobantes.test.ts
git commit -m "$(cat <<'EOF'
Registrar en CPA47 cuando el comprobante es "por conceptos"

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: UI — selector, panel y ocultar remitos

**Files:**
- Modify: `src/components/revision/listo-para-registrar.tsx`
- Modify: `src/components/revision/formulario.tsx`
- Modify: `src/app/comprobantes/[id]/page.tsx`

**Interfaces:**
- Consumes: `ResultadoListoParaRegistrar.tipoFactura`/`.concepto` (Task 4).

- [ ] **Step 1: Mostrar los dos chequeos nuevos en el panel**

En `src/components/revision/listo-para-registrar.tsx`, agregar `resultado.tipoFactura` y `resultado.concepto` al array `items`:

```ts
  const items = [
    resultado.condCompra,
    resultado.percepcionIibb,
    resultado.percepcionIva3,
    resultado.formatoComp,
    resultado.tipoFactura,
    resultado.concepto,
  ]
```

- [ ] **Step 2: Agregar las opciones fijas del selector**

En `src/components/revision/formulario.tsx`, agregar el caso `tipoFactura` dentro de `opcionesPara()`, antes del `return undefined` final:

```ts
function opcionesPara(
  clave: string,
  condicionesCompra: CondicionCompra[],
  codigosIibb: CodigoImpuesto[],
  codigosPercepcionIva3: AlicuotaIva[],
): Opcion[] | undefined {
  if (clave === 'condcompra') {
    return condicionesCompra.map((c) => ({ valor: String(c.codigo), label: c.descripcion }))
  }
  if (clave === 'codpercibb') {
    return codigosIibb.map((c) => ({ valor: String(c.codigo), label: c.descripcion }))
  }
  if (clave === 'codpercepiva') {
    return codigosPercepcionIva3.map((a) => ({ valor: String(a.codigo), label: a.descripcion }))
  }
  if (clave === 'tipoFactura') {
    return [
      { valor: 'conceptos', label: 'Por conceptos' },
      { valor: 'articulos', label: 'Por artículos' },
    ]
  }
  return undefined
}
```

- [ ] **Step 3: No traer remitos pendientes cuando `tipoFactura='conceptos'`**

En `src/app/comprobantes/[id]/page.tsx`, modificar el cálculo de `remitosPendientes` para que también dependa del valor final de `tipoFactura`:

```ts
  const codProveeCampo = detalle.campos.find((c) => c.clave === 'codprovee')?.valorFinal ?? null
  const tipoFacturaValor = detalle.campos.find((c) => c.clave === 'tipoFactura')?.valorFinal ?? null
  const remitosPendientes =
    tipoFacturaValor !== 'conceptos' && codProveeCampo && detalle.renglones.length > 0
      ? await buscarRemitosPendientes(codProveeCampo)
      : []
```

(Reemplaza el bloque `codProveeCampo`/`remitosPendientes` que ya existe ahí — no hace falta tocar `pantalla.tsx`: `RemitosPendientes` ya hace `if (remitos.length === 0 ...) return null`, así que pasarle un array vacío alcanza para ocultarlo.)

- [ ] **Step 4: Correr tsc**

Run: `npx tsc --noEmit`
Expected: sin errores

- [ ] **Step 5: Correr la suite completa**

Run: `pnpm test`
Expected: todo en verde

- [ ] **Step 6: Verificación manual en el navegador**

Levantar `pnpm dev`. Abrir (o crear) un comprobante `confirmado` con proveedor `010151` (AMX/Claro) resuelto. En el formulario:
1. Elegir "Tipo de factura" → "Por conceptos". Confirmar que el panel "Listo para registrar" muestra el chequeo de concepto en verde ("Concepto: 712 — TELEFONOS LOCALES.") y que "Remitos pendientes" no aparece.
2. Cambiar a "Por artículos" y confirmar que el chequeo de concepto pasa a "No aplica." y ya no bloquea nada por ese lado.
3. Volver a "Por conceptos", completar el resto de los campos bloqueantes (condición de compra, formato de N_COMP), y registrar. Confirmar contra la base (`SELECT * FROM CPA47 WHERE NCOMP_IN_C=<el que devolvió el toast>`) que la fila quedó con el concepto `712`.

- [ ] **Step 7: Commit**

```bash
git add src/components/revision/listo-para-registrar.tsx src/components/revision/formulario.tsx "src/app/comprobantes/[id]/page.tsx"
git commit -m "$(cat <<'EOF'
Agregar el selector de tipo de factura y ocultar remitos para conceptos

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Verificación final

- [ ] Correr la suite completa: `pnpm test` — todos los archivos en verde (con la flakiness conocida de `migrate.test.ts` por contención de SQL Server, ya documentada).
- [ ] `npx tsc --noEmit` limpio.
- [ ] Confirmar que la ruta "por artículos" sigue exactamente igual: registrar un comprobante con renglón+remito asignado y `tipoFactura='articulos'`, verificar que `CPA46`/`CPA48`/`STA20` se comportan como antes de este plan (mismo test ya existente de Task 5 de Fase 4, sin modificar).
- [ ] Actualizar `docs/superpowers/RETOMAR.md`: agregar una sección breve documentando esta feature (qué se agregó, que el caso borde de renglón-con-remito-y-luego-cambiado-a-conceptos quedó aceptado tal como dice la spec, y que hoy solo `010151` tiene concepto configurado en Tango — el resto de los proveedores va a bloquear "por conceptos" hasta que se cargue más data ahí).

---

## Notas para quien ejecute este plan

- Las columnas de `CPA47` de este plan salen de una consulta real contra la base (13.097 filas existentes) durante el diseño — no son una interpretación de la documentación de Axoft, que no detalla su semántica exacta. Si algo no cuadra al implementar, verificar con `SELECT * FROM CPA47 WHERE NCOMP_IN_C=<algo real>` antes de asumir que el plan está mal.
- El único proveedor con concepto configurado hoy (`010151`) puede dejar de ser el único si alguien carga más data en `CPA_CONCEPTOS_PROVEEDOR` en Tango mientras se ejecuta este plan — no debería romper nada (los tests descubren el proveedor sin concepto en runtime, no lo asumen fijo), pero vale la pena tenerlo presente.
