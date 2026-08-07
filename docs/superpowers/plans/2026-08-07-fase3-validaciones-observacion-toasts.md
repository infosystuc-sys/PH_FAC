# Fase 3 — Validaciones, observación, toasts y atajos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar todo lo que decide si un comprobante `leido` está listo para confirmarse: las 4 validaciones server-side, la resolución manual de proveedor, el modal de observación, un sistema de toasts, `condcompra` como select, y los atajos de teclado.

**Architecture:** Sigue la frontera de carpetas ya establecida (`src/lib/` lógica pura, `src/server/app/` tablas propias, `src/server/tango/` única capa que toca el ERP, `src/components/`/`src/app/` sin SQL directo). Cada validación se calcula server-side en dos momentos: al abrir la pantalla de revisión y de nuevo al confirmar. Ningún dato nuevo requiere migración — `MOTIVO_OBSERVACION`/`NOTA_OBSERVACION` ya existen en `PHF_COMPROBANTE`.

**Tech Stack:** Next.js 15 (App Router, Server Components + Server Actions), TypeScript, `mssql`, Vitest, CSS Modules.

## Global Constraints

- Todas las tablas propias llevan prefijo `PHF_`. No se crea ninguna tabla nueva en esta fase.
- Solo `src/server/tango/` puede emitir SQL contra `CPA*`/`STA*`/`GVA*`/`SBA*`. `src/server/tango/comprobantes.ts` (nuevo) es el único lugar que nombra `CPA04`.
- Toda consulta va parametrizada con `.input(...)`. Nunca concatenar valores de usuario en el SQL.
- IBM Plex Sans para la UI, IBM Plex Mono para todo dato que el operador cotejá contra el PDF (importes, CUIT, CAE, números, fechas). Los colores salen de las variables CSS de `src/app/globals.css` (`--exito`/`--exito-fondo`, `--alerta`/`--alerta-fondo`/`--alerta-borde`/`--alerta-hover`, `--error`/`--error-fondo`, `--ia`/`--ia-fondo`, `--oscuro`, `--borde`, `--texto-2`.. `--texto-6`).
- Sin Tailwind: CSS Modules, medidas exactas en píxeles tomadas de `design/README.md`. Diseñado para ≥1280px, sin diseño mobile.
- Copy en español rioplatense, sobrio y técnico.
- Commits en español, imperativo, terminando en `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Tests: la mayoría pegan contra SQL Server real (`PUNTO_HOGAR_1`). Los que escriben van dentro de `conRollback` (`src/server/db/tx.ts`) y no asumen que las tablas están vacías — miden contra una línea de base.
- Fórmula de "totales cuadran": `totalImputado()` de `src/lib/formato.ts` (cabecera), no suma de renglones — decisión ya tomada en el spec (sección 2).
- `N_COMP` en `CPA04` codifica `letra(1) + puntoVenta(5, zero-padded) + numeroComprobante(8, zero-padded)` — verificado contra datos reales de 4 proveedores distintos (ver Task 2, nota de verificación).

---

## Mapa de archivos

| Archivo | Qué hace |
|---|---|
| `src/lib/validaciones.ts` (nuevo) | Las 4 reglas puras + helpers `letraComprobante`, `nComp` |
| `src/server/tango/proveedores.ts` (extender) | `buscarProveedoresPorCuit` (plural, todos los matches) |
| `src/server/tango/comprobantes.ts` (nuevo) | Lectura de `CPA04` para el chequeo de duplicados |
| `src/server/app/validaciones.ts` (nuevo) | Orquesta: junta detalle + Tango + `PHF_COMPROBANTE`, arma el resultado de las 4 validaciones |
| `src/server/app/acciones.ts` (extender) | `marcarObservacion`, `elegirProveedor`; `confirmarComprobante` re-valida antes de confirmar |
| `src/server/app/comprobantes.ts` (extender) | `obtenerVecinosEn`/`obtenerVecinos` para J/K |
| `src/components/revision/validaciones.tsx` (nuevo) | Panel de validaciones (server component) |
| `src/components/revision/validaciones.module.css` (nuevo) | Estilos del panel |
| `src/components/revision/selector-proveedor.tsx` (nuevo) | Buscador + lista de candidatos (client) |
| `src/components/revision/selector-proveedor.module.css` (nuevo) | Estilos del selector |
| `src/components/revision/modal-observacion.tsx` (nuevo) | Modal de observación (client) |
| `src/components/revision/modal-observacion.module.css` (nuevo) | Estilos del modal |
| `src/components/revision/barra-acciones.tsx` (modificar) | Habilita "Marcar en observación", gatea el botón primario |
| `src/components/revision/pantalla.tsx` (modificar) | Pasa validaciones/condiciones/vecinos a los hijos |
| `src/components/revision/campo.tsx` (modificar) | Soporta `tipo: 'select'` |
| `src/components/revision/formulario.tsx` (modificar) | Pasa opciones de `condcompra` a `Campo` |
| `src/components/revision/atajos.ts` (nuevo) | Hook de atajos de teclado |
| `src/components/toast/toast-provider.tsx` (nuevo) | Contexto + hook `useToast()` |
| `src/components/toast/toast.module.css` (nuevo) | Estilos del toast |
| `src/lib/campos.ts` (modificar) | Tipo `'select'`, `condcompra` pasa a ese tipo |
| `src/app/layout.tsx` (modificar) | Envuelve con `ToastProvider` |
| `src/app/comprobantes/[id]/page.tsx` (modificar) | Trae validaciones, condiciones de compra, vecinos; lee `filtro`/`q` de `searchParams` |
| `src/components/bandeja/tabla.tsx` (modificar) | El link a la revisión conserva `filtro`/`q` |
| `src/components/bandeja/importar.tsx` (modificar) | Dispara toast al terminar de importar |

---

### Task 1: Validaciones puras

**Files:**
- Create: `src/lib/validaciones.ts`
- Test: `tests/lib/validaciones.test.ts`

**Interfaces:**
- Consumes: `totalImputado`, `parsearImporte` de `src/lib/formato.ts` (ya existen).
- Produces:
  - `type ResultadoValidacion = { estado: 'ok' | 'advertencia' | 'error'; mensaje: string }`
  - `letraComprobante(tipo: string): string | null`
  - `nComp(letra: string, ptovta: string, nro: string): string`
  - `validarTotales(valores: Record<string, string | null | undefined>): ResultadoValidacion`
  - `validarCae(cae: string | null | undefined, vtocae: string | null | undefined, hoy: Date): ResultadoValidacion`
  - `validarProveedor(cantidadMatches: number): ResultadoValidacion`
  - `validarDuplicado(hayDuplicado: boolean, referencia: string | null): ResultadoValidacion`

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// tests/lib/validaciones.test.ts
import { describe, it, expect } from 'vitest'
import {
  letraComprobante,
  nComp,
  validarTotales,
  validarCae,
  validarProveedor,
  validarDuplicado,
} from '@/lib/validaciones'

describe('letraComprobante', () => {
  it('reconoce la letra al final de "FAC A"', () => {
    expect(letraComprobante('FAC A')).toBe('A')
  })
  it('reconoce la letra en "FACTURA A 0011-00063576"', () => {
    expect(letraComprobante('FACTURA A 0011-00063576')).toBe('A')
  })
  it('reconoce la letra sola', () => {
    expect(letraComprobante('C')).toBe('C')
  })
  it('es insensible a mayusculas/minusculas', () => {
    expect(letraComprobante('factura b')).toBe('B')
  })
  it('devuelve null si no encuentra ninguna letra de comprobante valida', () => {
    expect(letraComprobante('Factura electronica')).toBe(null)
    expect(letraComprobante('')).toBe(null)
  })
})

describe('nComp', () => {
  it('arma el N_COMP con padding de 5 y 8 digitos', () => {
    expect(nComp('A', '0011', '63576')).toBe('A0011800063576'.slice(0, 1) + '00011' + '00063576')
  })
  it('no trunca si ptovta o nro ya vienen mas largos que el padding', () => {
    expect(nComp('A', '123456', '123456789')).toBe('A123456123456789')
  })
})

describe('validarProveedor', () => {
  it('ok con exactamente un match', () => {
    expect(validarProveedor(1)).toEqual({ estado: 'ok', mensaje: 'Proveedor resuelto.' })
  })
  it('error sin ningun match', () => {
    const r = validarProveedor(0)
    expect(r.estado).toBe('error')
  })
  it('error con mas de un match', () => {
    const r = validarProveedor(3)
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('3')
  })
})

describe('validarDuplicado', () => {
  it('ok si no hay duplicado', () => {
    expect(validarDuplicado(false, null)).toEqual({ estado: 'ok', mensaje: 'Sin duplicados.' })
  })
  it('error con la referencia si hay duplicado', () => {
    const r = validarDuplicado(true, 'comprobante interno 16591')
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('16591')
  })
})

describe('validarTotales', () => {
  it('ok si totalImputado coincide con el total leido (tolerancia de un centavo)', () => {
    const v = { neto: '529.947,50', porciva1: '21.0', impiva1: '39.190,99',
      porciva2: '27.0', impiva2: '92.697,41', porciva3: '3', impiva3: '15.898,43',
      perciibb: '13.248,69', total: '690.983,02' }
    expect(validarTotales(v).estado).toBe('ok')
  })
  it('advertencia con la diferencia exacta si no coinciden', () => {
    const v = { neto: '100.000,00', total: '112.480,00' }
    const r = validarTotales(v)
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('12.480,00')
  })
})

describe('validarCae', () => {
  const hoy = new Date('2026-08-07T00:00:00')

  it('ok con CAE de 14 digitos y vencimiento futuro', () => {
    expect(validarCae('76123456789012', '31/12/2026', hoy)).toEqual({ estado: 'ok', mensaje: 'CAE válido.' })
  })
  it('advertencia si el CAE no tiene 14 digitos', () => {
    const r = validarCae('123', '31/12/2026', hoy)
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('formato')
  })
  it('advertencia si el CAE vencio', () => {
    const r = validarCae('76123456789012', '01/01/2026', hoy)
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('vencido')
  })
  it('advertencia si no hay CAE', () => {
    expect(validarCae('', '', hoy).estado).toBe('advertencia')
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/lib/validaciones.test.ts`
Expected: FAIL — `Cannot find module '@/lib/validaciones'`

- [ ] **Step 3: Implementar**

```ts
// src/lib/validaciones.ts
import { totalImputado, parsearImporte } from './formato'

export type ResultadoValidacion = {
  estado: 'ok' | 'advertencia' | 'error'
  mensaje: string
}

const LETRAS_VALIDAS = ['A', 'B', 'C', 'E', 'M', 'T']
const RE_LETRA = /\b([ABCEMT])\b/i

/**
 * El campo `tipo` lo devuelve la IA en texto libre ("FAC A", "FACTURA A
 * 0011-00063576", "C"...) porque el prompt no le fuerza un formato exacto.
 * Se busca una letra de comprobante valida como palabra suelta en vez de
 * asumir que siempre esta al final o al principio.
 */
export function letraComprobante(tipo: string): string | null {
  const m = RE_LETRA.exec(tipo.toUpperCase())
  return m && LETRAS_VALIDAS.includes(m[1]) ? m[1] : null
}

/**
 * Reconstruye el N_COMP tal como Tango lo guarda en CPA04: letra + punto
 * de venta a 5 digitos + numero a 8 digitos (verificado contra 5 años de
 * facturas reales de un mismo proveedor, ver plan Task 2). Si ptovta o
 * nro ya vienen mas largos que el padding no se truncan -- un dato mas
 * largo que lo esperado tiene que fallar el match, no esconderse.
 */
export function nComp(letra: string, ptovta: string, nro: string): string {
  return `${letra}${ptovta.padStart(5, '0')}${nro.padStart(8, '0')}`
}

export function validarProveedor(cantidadMatches: number): ResultadoValidacion {
  if (cantidadMatches === 1) return { estado: 'ok', mensaje: 'Proveedor resuelto.' }
  if (cantidadMatches === 0) {
    return { estado: 'error', mensaje: 'Sin coincidencia por CUIT. Elegí el proveedor manualmente.' }
  }
  return {
    estado: 'error',
    mensaje: `Hay ${cantidadMatches} proveedores con este CUIT. Elegí cuál corresponde.`,
  }
}

export function validarDuplicado(hayDuplicado: boolean, referencia: string | null): ResultadoValidacion {
  if (!hayDuplicado) return { estado: 'ok', mensaje: 'Sin duplicados.' }
  return {
    estado: 'error',
    mensaje: `Ya existe un comprobante igual: ${referencia ?? 'referencia no disponible'}.`,
  }
}

const TOLERANCIA_CENTAVOS = 0.01

export function validarTotales(valores: Record<string, string | null | undefined>): ResultadoValidacion {
  const imputado = totalImputado(valores)
  const total = parsearImporte(valores.total)
  const diferencia = Math.abs(imputado - total)
  if (diferencia <= TOLERANCIA_CENTAVOS) {
    return { estado: 'ok', mensaje: 'Los importes cierran contra el total.' }
  }
  const fmt = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return {
    estado: 'advertencia',
    mensaje: `La suma de los importes difiere en $ ${fmt.format(diferencia)} del total leído.`,
  }
}

const RE_CAE = /^\d{14}$/

function parsearFechaArg(f: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(f.trim())
  if (!m) return null
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
  return Number.isNaN(d.getTime()) ? null : d
}

export function validarCae(
  cae: string | null | undefined,
  vtocae: string | null | undefined,
  hoy: Date,
): ResultadoValidacion {
  const c = (cae ?? '').trim()
  if (!RE_CAE.test(c)) {
    return { estado: 'advertencia', mensaje: 'CAE con formato inválido: debe tener 14 dígitos.' }
  }
  const vto = parsearFechaArg((vtocae ?? '').trim())
  if (vto && vto < new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())) {
    return { estado: 'advertencia', mensaje: `CAE vencido el ${vtocae}.` }
  }
  return { estado: 'ok', mensaje: 'CAE válido.' }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/lib/validaciones.test.ts`
Expected: PASS (17 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/validaciones.ts tests/lib/validaciones.test.ts
git commit -m "$(cat <<'EOF'
Agregar las 4 validaciones puras de la Fase 3

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Lectura de Tango — todos los proveedores por CUIT, y duplicados en CPA04

**Files:**
- Modify: `src/server/tango/proveedores.ts`
- Create: `src/server/tango/comprobantes.ts`
- Modify: `tests/server/tango/proveedores.test.ts`
- Create: `tests/server/tango/comprobantes.test.ts`

**Interfaces:**
- Consumes: `normalizarCuit` de `@/lib/formato` (ya existe), `Proveedor` type ya definido en `proveedores.ts`.
- Produces:
  - `buscarProveedoresPorCuit(cuit: string): Promise<Proveedor[]>`
  - `type ComprobanteCpa04 = { nComp: string; codProvee: string; total: number; fechaEmision: Date }`
  - `buscarFacturaEnCpa04(codProvee: string, nComp: string): Promise<ComprobanteCpa04 | null>`

**Nota de verificación (ya hecha, no repetir):** `CPA04.N_COMP` es `varchar(14)` y codifica `letra(1) + puntoVenta(5, zero-padded) + numeroComprobante(8, zero-padded)`. Verificado corriendo estas dos consultas contra la base real:

```sql
-- Confirma que T_COMP = 'FAC' agrupa todas las facturas (15.625 filas) y que
-- el resto de tipos (O/P, NC2, NC1, ND1) no son facturas de compra.
SELECT DISTINCT T_COMP, COUNT(*) AS n FROM CPA04 GROUP BY T_COMP ORDER BY n DESC;

-- Contra el proveedor 010151 (AMX ARGENTINA, CUIT 30-66328849-7, 59 facturas
-- entre 2021 y 2026): los 5 caracteres tras la letra se mantienen
-- constantes por punto de venta y solo cambian cuando cambia de talonario
-- (ej. '01331' en 2025-2026, '01326' en 2024, '01305' en 2023, '01281' en
-- 2021-2022), y los ultimos 8 son un numero de comprobante que crece de
-- forma estrictamente secuencial dentro de cada punto de venta. Un solo
-- caso (2025-01, N_COMP='A1326200252367') rompe el patron con los dos
-- primeros digitos del punto de venta invertidos ('13262' en vez de
-- '01326') -- es consistente con un error de tipeo real en 15.625 filas,
-- no con una convencion distinta.
SELECT T_COMP, N_COMP, IMPORTE_TO, FECHA_EMIS FROM CPA04
WHERE COD_PROVEE = '010151' AND T_COMP = 'FAC' ORDER BY NCOMP_IN_C DESC;
```

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// Agregar a tests/server/tango/proveedores.test.ts (al lado de los tests existentes de buscarProveedorPorCuit)
import { buscarProveedoresPorCuit } from '@/server/tango/proveedores'

describe('buscarProveedoresPorCuit', () => {
  it('devuelve un array con el unico match cuando el CUIT no esta duplicado', async () => {
    // CUIT real de AMX ARGENTINA, usado en otros tests de la suite.
    const r = await buscarProveedoresPorCuit('30-66328849-7')
    expect(r.length).toBe(1)
    expect(r[0].razonSocial).toContain('AMX')
  })

  it('devuelve un array vacio si no matchea ningun proveedor', async () => {
    const r = await buscarProveedoresPorCuit('20-11111111-1')
    expect(r).toEqual([])
  })

  it('devuelve mas de un resultado para un CUIT duplicado real de la base', async () => {
    // Descubierto en la revision final de Fase 1: hay 7 CUIT duplicados en
    // CPA01. Se busca uno en vez de hardcodear un CUIT: la base es real y
    // el conjunto de duplicados puede cambiar.
    const dup = await getPool().then((p) => p.request().query(`
      SELECT TOP 1 REPLACE(REPLACE(REPLACE(N_CUIT,'-',''),' ',''),'.','') AS cuit
      FROM CPA01
      WHERE N_CUIT IS NOT NULL AND N_CUIT <> ''
      GROUP BY REPLACE(REPLACE(REPLACE(N_CUIT,'-',''),' ',''),'.','')
      HAVING COUNT(*) > 1
    `))
    if (dup.recordset.length === 0) return // no hay duplicados hoy: no hay nada que probar
    const r = await buscarProveedoresPorCuit(dup.recordset[0].cuit)
    expect(r.length).toBeGreaterThan(1)
  })
})
```

Agregar el import de `getPool` que falte arriba del archivo (`import { getPool } from '@/server/db/pool'`).

```ts
// tests/server/tango/comprobantes.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { getPool } from '@/server/db/pool'
import { cerrarPool } from '@/server/db/pool'
import { buscarFacturaEnCpa04 } from '@/server/tango/comprobantes'

afterAll(async () => {
  await cerrarPool()
})

describe('buscarFacturaEnCpa04', () => {
  it('encuentra una factura real por proveedor + N_COMP', async () => {
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT TOP 1 COD_PROVEE, N_COMP FROM CPA04 WHERE T_COMP = 'FAC' ORDER BY NCOMP_IN_C DESC
    `)
    const fila = r.recordset[0]
    const encontrado = await buscarFacturaEnCpa04(fila.COD_PROVEE, fila.N_COMP)
    expect(encontrado).not.toBeNull()
    expect(encontrado!.nComp).toBe(fila.N_COMP.trim())
  })

  it('devuelve null si no hay ninguna factura con ese N_COMP', async () => {
    const r = await buscarFacturaEnCpa04('999999', 'Z9999999999999')
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/tango/comprobantes.test.ts tests/server/tango/proveedores.test.ts`
Expected: FAIL — `buscarProveedoresPorCuit`/`buscarFacturaEnCpa04` no existen, y `comprobantes.ts` no existe.

- [ ] **Step 3: Implementar `buscarProveedoresPorCuit`**

Agregar en `src/server/tango/proveedores.ts`, después de `buscarProveedorPorCuit`:

```ts
/**
 * A diferencia de `buscarProveedorPorCuit` (que deduce determinísticamente
 * el primero por COD_PROVEE para el camino automático de la cola), esta
 * devuelve TODOS los matches -- la Fase 3 la usa para mostrarle al
 * operador la lista completa cuando hay mas de un proveedor con el mismo
 * CUIT, en vez de elegir en silencio.
 */
export async function buscarProveedoresPorCuit(cuit: string): Promise<Proveedor[]> {
  const norm = normalizarCuit(cuit)
  if (!norm) return []

  const pool = await getPool()
  const r = await pool
    .request()
    .input('cuit', sql.VarChar(11), norm)
    .query(`
      ${SELECT}
      WHERE REPLACE(REPLACE(REPLACE(ISNULL(N_CUIT,''), '-', ''), ' ', ''), '.', '') = @cuit
      ORDER BY COD_PROVEE
    `)

  return r.recordset.map(aProveedor)
}
```

- [ ] **Step 4: Implementar `src/server/tango/comprobantes.ts`**

```ts
import sql from 'mssql'
import { getPool } from '../db/pool'

export type ComprobanteCpa04 = {
  nComp: string
  codProvee: string
  total: number
  fechaEmision: Date
}

/**
 * Solo T_COMP = 'FAC': es el unico tipo que esta app procesa (facturas de
 * compra). N_COMP codifica letra+puntoVenta(5)+numero(8) -- ver la nota de
 * verificacion en el plan de la Fase 3. `nComp` viene ya armado por
 * `src/lib/validaciones.ts::nComp`, esta funcion no reconstruye nada.
 */
export async function buscarFacturaEnCpa04(
  codProvee: string,
  nComp: string,
): Promise<ComprobanteCpa04 | null> {
  const pool = await getPool()
  const r = await pool
    .request()
    .input('cp', sql.VarChar(6), codProvee)
    .input('nc', sql.VarChar(14), nComp)
    .query(`
      SELECT TOP 1 N_COMP, COD_PROVEE, IMPORTE_TO, FECHA_EMIS
      FROM CPA04
      WHERE T_COMP = 'FAC' AND COD_PROVEE = @cp AND N_COMP = @nc
    `)

  if (r.recordset.length === 0) return null
  const row = r.recordset[0]
  return {
    nComp: String(row.N_COMP).trim(),
    codProvee: String(row.COD_PROVEE).trim(),
    total: Number(row.IMPORTE_TO),
    fechaEmision: new Date(row.FECHA_EMIS),
  }
}
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/tango/comprobantes.test.ts tests/server/tango/proveedores.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/tango/proveedores.ts src/server/tango/comprobantes.ts tests/server/tango/proveedores.test.ts tests/server/tango/comprobantes.test.ts
git commit -m "$(cat <<'EOF'
Leer todos los proveedores por CUIT y las facturas existentes en CPA04

buscarProveedoresPorCuit devuelve todos los matches (antes solo el
primero) para poder ofrecerle la lista al operador cuando hay mas de
uno. buscarFacturaEnCpa04 es la lectura nueva para el chequeo de
duplicados: verificada contra 5 años de facturas reales de un mismo
proveedor, N_COMP codifica letra + punto de venta (5 digitos) +
numero de comprobante (8 digitos).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Orquestación de las validaciones

**Files:**
- Create: `src/server/app/validaciones.ts`
- Test: `tests/server/app/validaciones.test.ts`

**Interfaces:**
- Consumes:
  - `obtenerDetalleEn(e, id): Promise<Detalle>` de `@/server/app/detalle` (existe).
  - `buscarProveedoresPorCuit(cuit): Promise<Proveedor[]>` de `@/server/tango/proveedores` (Task 2).
  - `buscarFacturaEnCpa04(codProvee, nComp): Promise<ComprobanteCpa04 | null>` de `@/server/tango/comprobantes` (Task 2).
  - `letraComprobante`, `nComp`, `validarProveedor`, `validarDuplicado`, `validarTotales`, `validarCae`, `type ResultadoValidacion` de `@/lib/validaciones` (Task 1).
- Produces:
  - `type Validaciones = { proveedor: ResultadoValidacion; duplicado: ResultadoValidacion; totales: ResultadoValidacion; cae: ResultadoValidacion; candidatosProveedor: Proveedor[]; bloqueante: boolean }`
  - `validarComprobanteEn(e: Ejecutor, id: number): Promise<Validaciones>`
  - `validarComprobante(id: number): Promise<Validaciones>`

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// tests/server/app/validaciones.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { conRollback } from '@/server/db/tx'
import { getPool, cerrarPool } from '@/server/db/pool'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { guardarCampoEn } from '@/server/app/detalle'
import { validarComprobanteEn } from '@/server/app/validaciones'

afterAll(async () => {
  await cerrarPool()
})

describe('validarComprobanteEn', () => {
  it('proveedor en error y bloqueante si el CUIT no matchea ningun proveedor', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'cuit', '20-11111111-1')
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '1')
      await guardarCampoEn(tx, id, 'nro', '1')
      await guardarCampoEn(tx, id, 'total', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.proveedor.estado).toBe('error')
      expect(v.bloqueante).toBe(true)
      expect(v.candidatosProveedor).toEqual([])
    })
  })

  it('proveedor ok y sin duplicado cuando el CUIT matchea uno solo y el N_COMP no existe en CPA04', async () => {
    await conRollback(async (tx) => {
      const cuitAmx = await tx.request().query(`SELECT TOP 1 N_CUIT FROM CPA01 WHERE COD_PROVEE = '010151'`)
      const cuit = String(cuitAmx.recordset[0].N_CUIT)

      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'cuit', cuit)
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '99999')
      await guardarCampoEn(tx, id, 'nro', '99999999')
      await guardarCampoEn(tx, id, 'total', '100,00')
      await guardarCampoEn(tx, id, 'neto', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.proveedor.estado).toBe('ok')
      expect(v.duplicado.estado).toBe('ok')
      expect(v.totales.estado).toBe('ok')
      expect(v.bloqueante).toBe(false)
    })
  })

  it('duplicado en error si el N_COMP ya existe en CPA04 para ese proveedor', async () => {
    await conRollback(async (tx) => {
      const existente = await tx.request().query(`
        SELECT TOP 1 c.COD_PROVEE, c.N_COMP, p.N_CUIT
        FROM CPA04 c JOIN CPA01 p ON p.COD_PROVEE = c.COD_PROVEE
        WHERE c.T_COMP = 'FAC' AND p.N_CUIT IS NOT NULL AND p.N_CUIT <> ''
        ORDER BY c.NCOMP_IN_C DESC
      `)
      const fila = existente.recordset[0]
      const nComp = String(fila.N_COMP).trim()
      const letra = nComp[0]
      const ptovta = nComp.slice(1, 6)
      const nro = nComp.slice(6)

      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'cuit', String(fila.N_CUIT))
      await guardarCampoEn(tx, id, 'tipo', `FAC ${letra}`)
      await guardarCampoEn(tx, id, 'ptovta', ptovta)
      await guardarCampoEn(tx, id, 'nro', nro)
      await guardarCampoEn(tx, id, 'total', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.duplicado.estado).toBe('error')
      expect(v.bloqueante).toBe(true)
    })
  })

  it('duplicado en error si ya existe otro PHF_COMPROBANTE con el mismo proveedor+tipo+ptovta+numero', async () => {
    await conRollback(async (tx) => {
      const otro = await insertarComprobantePrueba(tx, {
        estado: 'confirmado', tipo: 'FAC A', puntoVenta: '00001', numero: '00000001',
      })
      await tx.request().input('id', sql.Int, otro).input('cp', sql.VarChar(20), '010151')
        .query(`UPDATE PHF_COMPROBANTE SET COD_PROVEE = @cp WHERE ID = @id`)

      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const cuitAmx = await tx.request().query(`SELECT TOP 1 N_CUIT FROM CPA01 WHERE COD_PROVEE = '010151'`)
      await guardarCampoEn(tx, id, 'cuit', String(cuitAmx.recordset[0].N_CUIT))
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '00001')
      await guardarCampoEn(tx, id, 'nro', '00000001')
      await guardarCampoEn(tx, id, 'total', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.duplicado.estado).toBe('error')
    })
  })

  it('totales en advertencia si no cierran, sin bloquear la confirmacion', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const cuitAmx = await tx.request().query(`SELECT TOP 1 N_CUIT FROM CPA01 WHERE COD_PROVEE = '010151'`)
      await guardarCampoEn(tx, id, 'cuit', String(cuitAmx.recordset[0].N_CUIT))
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '99998')
      await guardarCampoEn(tx, id, 'nro', '99999998')
      await guardarCampoEn(tx, id, 'neto', '100,00')
      await guardarCampoEn(tx, id, 'total', '999,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.totales.estado).toBe('advertencia')
      expect(v.bloqueante).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/app/validaciones.test.ts`
Expected: FAIL — `Cannot find module '@/server/app/validaciones'`

- [ ] **Step 3: Implementar**

```ts
// src/server/app/validaciones.ts
import sql from 'mssql'
import { getPool } from '../db/pool'
import { obtenerDetalleEn } from './detalle'
import { buscarProveedoresPorCuit, type Proveedor } from '@/server/tango/proveedores'
import { buscarFacturaEnCpa04 } from '@/server/tango/comprobantes'
import {
  letraComprobante,
  nComp as armarNComp,
  validarProveedor,
  validarDuplicado,
  validarTotales,
  validarCae,
  type ResultadoValidacion,
} from '@/lib/validaciones'

type Ejecutor = { request(): sql.Request }

export type Validaciones = {
  proveedor: ResultadoValidacion
  duplicado: ResultadoValidacion
  totales: ResultadoValidacion
  cae: ResultadoValidacion
  candidatosProveedor: Proveedor[]
  bloqueante: boolean
}

export async function validarComprobanteEn(e: Ejecutor, id: number): Promise<Validaciones> {
  const detalle = await obtenerDetalleEn(e, id)
  const valores: Record<string, string | null> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const cuit = valores.cuit ?? ''
  const candidatosProveedor = cuit ? await buscarProveedoresPorCuit(cuit) : []
  const proveedor = validarProveedor(candidatosProveedor.length)

  let hayDuplicado = false
  let referenciaDuplicado: string | null = null

  if (candidatosProveedor.length === 1) {
    const codProvee = candidatosProveedor[0].codProvee
    const letra = letraComprobante(valores.tipo ?? '')
    const ptovta = valores.ptovta ?? ''
    const nro = valores.nro ?? ''

    if (letra && ptovta && nro) {
      const candidato = armarNComp(letra, ptovta, nro)

      const enTango = await buscarFacturaEnCpa04(codProvee, candidato)
      if (enTango) {
        hayDuplicado = true
        referenciaDuplicado = `factura ${enTango.nComp} ya registrada en Tango`
      } else {
        const enApp = await e
          .request()
          .input('id', sql.Int, id)
          .input('cp', sql.VarChar(20), codProvee)
          .input('tipo', sql.VarChar(10), valores.tipo ?? null)
          .input('pv', sql.VarChar(10), ptovta)
          .input('nro', sql.VarChar(20), nro)
          .query(`
            SELECT TOP 1 ID FROM PHF_COMPROBANTE
            WHERE ID <> @id AND COD_PROVEE = @cp AND TIPO = @tipo
              AND PUNTO_VENTA = @pv AND NUMERO = @nro
          `)
        if (enApp.recordset.length > 0) {
          hayDuplicado = true
          referenciaDuplicado = `comprobante interno ${enApp.recordset[0].ID}`
        }
      }
    }
  }

  const duplicado = validarDuplicado(hayDuplicado, referenciaDuplicado)
  const totales = validarTotales(valores)
  const cae = validarCae(valores.cae, valores.vtocae, new Date())

  return {
    proveedor,
    duplicado,
    totales,
    cae,
    candidatosProveedor,
    bloqueante: proveedor.estado === 'error' || duplicado.estado === 'error',
  }
}

export async function validarComprobante(id: number): Promise<Validaciones> {
  return validarComprobanteEn(await getPool(), id)
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/app/validaciones.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/app/validaciones.ts tests/server/app/validaciones.test.ts
git commit -m "$(cat <<'EOF'
Orquestar las 4 validaciones contra el detalle, Tango y PHF_COMPROBANTE

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Panel de validaciones + selector manual de proveedor

**Files:**
- Create: `src/components/revision/validaciones.tsx`
- Create: `src/components/revision/validaciones.module.css`
- Create: `src/components/revision/selector-proveedor.tsx`
- Create: `src/components/revision/selector-proveedor.module.css`
- Modify: `src/server/app/acciones.ts` (agregar `elegirProveedor`, `buscarProveedores`)
- Modify: `src/components/revision/pantalla.tsx`
- Modify: `src/app/comprobantes/[id]/page.tsx`
- Test: `tests/server/app/acciones.test.ts` (agregar casos de `elegirProveedor`)

**Interfaces:**
- Consumes: `Validaciones`/`validarComprobante` (Task 3), `Proveedor`/`buscarProveedoresPorRazonSocial` (`@/server/tango/proveedores`, ya existe), `guardarCampoEn`/`auditarEn` (`@/server/app/detalle`, ya existen).
- Produces:
  - `elegirProveedor(id: number, codProvee: string, razonSocial: string, corregido: boolean): Promise<void>` (server action)
  - `buscarProveedores(texto: string): Promise<Proveedor[]>` (server action, wrapper delgado sobre `buscarProveedoresPorRazonSocial` para poder llamarla desde un client component)
  - `<PanelValidaciones validaciones={Validaciones} comprobanteId={number} />` (server component)
  - `<SelectorProveedor comprobanteId={number} candidatos={Proveedor[]} />` (client component)

- [ ] **Step 1: Escribir el test que falla para `elegirProveedor`**

```ts
// Agregar a tests/server/app/acciones.test.ts
import { elegirProveedor } from '@/server/app/acciones'
import { obtenerDetalle } from '@/server/app/detalle'

describe('elegirProveedor', () => {
  it('guarda codprovee, desnormaliza RAZON_SOCIAL/COD_PROVEE y audita', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await elegirProveedor(id, '010151', 'AMX ARGENTINA SOCIEDAD ANONIMA', true)

      const detalle = await obtenerDetalle(id)
      const campo = detalle.campos.find((c) => c.clave === 'codprovee')
      expect(campo?.valorFinal).toBe('010151')
      expect(campo?.corregido).toBe(true)

      const fila = await getPool().then((p) =>
        p.request().input('id', sql.Int, id).query(`SELECT COD_PROVEE, RAZON_SOCIAL FROM PHF_COMPROBANTE WHERE ID=@id`),
      )
      expect(fila.recordset[0].COD_PROVEE).toBe('010151')
      expect(fila.recordset[0].RAZON_SOCIAL).toBe('AMX ARGENTINA SOCIEDAD ANONIMA')

      expect(detalle.auditoria.some((a) => a.texto.includes('AMX'))).toBe(true)
    })
  })
})
```

(`elegirProveedor` usa el pool real, no la transacción del test — es un server action pensado para producción. El test verifica sus efectos leyendo con `obtenerDetalle`/`getPool` normales; como corre dentro de `conRollback`, el `INSERT` del comprobante de prueba se revierte igual al final aunque `elegirProveedor` no participe de esa transacción.)

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/server/app/acciones.test.ts -t elegirProveedor`
Expected: FAIL — `elegirProveedor` no existe

- [ ] **Step 3: Implementar `elegirProveedor` y `buscarProveedores` en `acciones.ts`**

Agregar a `src/server/app/acciones.ts` (junto a los demás `import`, agregar `buscarProveedoresPorRazonSocial` y `auditarEn`/`guardarCampoEn` si no están ya importados):

```ts
import { buscarProveedoresPorRazonSocial, type Proveedor } from '@/server/tango/proveedores'
import { guardarCampoEn, auditarEn } from '@/server/app/detalle'

/**
 * Wrapper delgado: un client component no puede llamar directo a
 * src/server/tango/ (esa capa no es 'use server'), asi que el buscador de
 * proveedores del selector manual pasa por este server action.
 */
export async function buscarProveedores(texto: string): Promise<Proveedor[]> {
  return buscarProveedoresPorRazonSocial(texto)
}

/**
 * El operador elige un proveedor a mano -- porque el CUIT no matcheo
 * ninguno, o matcheo varios. `corregido` distingue los dos casos: si vino
 * de desambiguar un CUIT que ya matcheaba (el sistema tenia la respuesta,
 * solo faltaba elegir cual), no es una correccion real y no debe
 * contaminar CORREGIDO_POR_USUARIO; si vino de buscar por razon social
 * porque el CUIT no encontro nada, si lo es. Mismo criterio que
 * resolverProveedorEn en cola.ts.
 */
export async function elegirProveedor(
  id: number,
  codProvee: string,
  razonSocial: string,
  corregido: boolean,
): Promise<void> {
  const pool = await getPool()
  await guardarCampoEn(pool, id, 'codprovee', codProvee, { corregidoPorUsuario: corregido })
  await pool
    .request()
    .input('id', sql.Int, id)
    .input('cod', sql.VarChar(20), codProvee)
    .input('razon', sql.NVarChar(200), razonSocial)
    .query(`UPDATE PHF_COMPROBANTE SET COD_PROVEE = @cod, RAZON_SOCIAL = @razon WHERE ID = @id`)
  await auditarEn(pool, id, `Proveedor elegido a mano: ${codProvee} — ${razonSocial}`)

  revalidatePath(`/comprobantes/${id}`)
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run tests/server/app/acciones.test.ts -t elegirProveedor`
Expected: PASS

- [ ] **Step 5: Construir `SelectorProveedor` (client)**

```ts
// src/components/revision/selector-proveedor.tsx
'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
import { buscarProveedores, elegirProveedor } from '@/server/app/acciones'
import type { Proveedor } from '@/server/tango/proveedores'
import { formatCuit } from '@/lib/formato'
import styles from './selector-proveedor.module.css'

export function SelectorProveedor({
  comprobanteId,
  candidatos,
}: {
  comprobanteId: number
  candidatos: Proveedor[]
}) {
  const [query, setQuery] = useState('')
  const [resultados, setResultados] = useState<Proveedor[]>([])
  const [pendiente, arrancar] = useTransition()
  const debounce = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    clearTimeout(debounce.current)
    if (query.trim().length < 2) {
      setResultados([])
      return
    }
    debounce.current = setTimeout(() => {
      buscarProveedores(query).then(setResultados)
    }, 250)
    return () => clearTimeout(debounce.current)
  }, [query])

  function elegir(p: Proveedor, corregido: boolean) {
    arrancar(async () => {
      await elegirProveedor(comprobanteId, p.codProvee, p.razonSocial, corregido)
    })
  }

  return (
    <div className={styles.selector}>
      {candidatos.length > 0 && (
        <ul className={styles.candidatos}>
          {candidatos.map((p) => (
            <li key={p.codProvee}>
              <button type="button" disabled={pendiente} onClick={() => elegir(p, false)} className={styles.candidato}>
                <span className={styles.razon}>{p.razonSocial}</span>
                <span className={styles.detalle}>{p.codProvee} · {formatCuit(p.cuit)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        type="text"
        className={styles.buscador}
        placeholder="Buscar proveedor por razón social…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {resultados.length > 0 && (
        <ul className={styles.candidatos}>
          {resultados.map((p) => (
            <li key={p.codProvee}>
              <button type="button" disabled={pendiente} onClick={() => elegir(p, true)} className={styles.candidato}>
                <span className={styles.razon}>{p.razonSocial}</span>
                <span className={styles.detalle}>{p.codProvee} · {formatCuit(p.cuit)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

```css
/* src/components/revision/selector-proveedor.module.css */
.selector {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.buscador {
  height: 36px;
  padding: 0 11px;
  border-radius: 7px;
  border: 1px solid var(--borde-input);
  font-size: 13.5px;
  outline: none;
}

.buscador:focus {
  border-color: #2b4fd0;
  box-shadow: 0 0 0 3px rgba(43, 79, 208, 0.12);
}

.candidatos {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.candidato {
  width: 100%;
  text-align: left;
  padding: 8px 11px;
  border: 1px solid var(--borde);
  border-radius: 7px;
  background: var(--superficie);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.candidato:hover:not(:disabled) {
  border-color: #2b4fd0;
  background: #f4f6fd;
}

.candidato:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.razon {
  font-size: 13px;
  font-weight: 500;
}

.detalle {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--texto-6);
}
```

- [ ] **Step 6: Construir `PanelValidaciones` (server component)**

```ts
// src/components/revision/validaciones.tsx
import type { Validaciones } from '@/server/app/validaciones'
import { SelectorProveedor } from './selector-proveedor'
import styles from './validaciones.module.css'

const GLIFO = { ok: '✓', advertencia: '!', error: '✕' } as const

function Item({
  estado,
  mensaje,
  extra,
}: {
  estado: 'ok' | 'advertencia' | 'error'
  mensaje: string
  extra?: React.ReactNode
}) {
  return (
    <div className={styles.item}>
      <div className={styles.fila}>
        <span className={`${styles.punto} ${styles[estado]}`}>{GLIFO[estado]}</span>
        <span className={styles.mensaje}>{mensaje}</span>
      </div>
      {extra}
    </div>
  )
}

export function PanelValidaciones({
  comprobanteId,
  validaciones,
}: {
  comprobanteId: number
  validaciones: Validaciones
}) {
  return (
    <section className={styles.tarjeta}>
      <h3 className={styles.titulo}>Validaciones</h3>
      <div className={styles.lista}>
        <Item
          estado={validaciones.proveedor.estado}
          mensaje={validaciones.proveedor.mensaje}
          extra={
            validaciones.proveedor.estado === 'error' ? (
              <SelectorProveedor comprobanteId={comprobanteId} candidatos={validaciones.candidatosProveedor} />
            ) : undefined
          }
        />
        <Item estado={validaciones.duplicado.estado} mensaje={validaciones.duplicado.mensaje} />
        <Item estado={validaciones.totales.estado} mensaje={validaciones.totales.mensaje} />
        <Item estado={validaciones.cae.estado} mensaje={validaciones.cae.mensaje} />
      </div>
    </section>
  )
}
```

```css
/* src/components/revision/validaciones.module.css */
.tarjeta {
  max-width: 760px;
  margin: 0 auto 16px;
  background: var(--superficie);
  border: 1px solid var(--borde);
  border-radius: 9px;
  padding: 0 15px;
}

.titulo {
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--texto-4);
  padding: 13px 0 10px;
  border-bottom: 1px solid var(--borde-sutil-3);
  margin: 0;
  font-weight: 600;
}

.lista {
  display: flex;
  flex-direction: column;
}

.item {
  padding: 10px 0;
  border-bottom: 1px solid var(--borde-sutil-2);
}

.item:last-child {
  border-bottom: none;
}

.fila {
  display: flex;
  align-items: center;
  gap: 10px;
}

.punto {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
}

.punto.ok {
  background: var(--exito-fondo);
  color: var(--exito);
}

.punto.advertencia {
  background: var(--alerta-fondo);
  color: var(--alerta);
}

.punto.error {
  background: var(--error-fondo);
  color: var(--error);
}

.mensaje {
  font-size: 13px;
  color: var(--texto-2);
}
```

- [ ] **Step 7: Enhebrar en `Pantalla` y `page.tsx`**

En `src/components/revision/pantalla.tsx`, agregar la prop `validaciones: Validaciones` y renderizar `<PanelValidaciones comprobanteId={comprobanteId} validaciones={validaciones} />` entre `<AvisoIA>` y `<Formulario>`:

```ts
// pantalla.tsx — agregar el import y la prop
import { PanelValidaciones } from './validaciones'
import type { Validaciones } from '@/server/app/validaciones'

// en las props de Pantalla:
  validaciones: Validaciones

// en el JSX, despues de <AvisoIA .../> y antes de <Formulario .../>:
        <PanelValidaciones comprobanteId={comprobanteId} validaciones={validaciones} />
```

En `src/app/comprobantes/[id]/page.tsx`, importar `validarComprobante` y pasarlo a `Pantalla` solo cuando el estado no es `procesando`/`error` (los mismos dos estados que ya excluyen el render de `Pantalla` hoy):

```ts
import { validarComprobante } from '@/server/app/validaciones'

// junto a la carga de obtenerDetalle, agregar:
const validaciones = await validarComprobante(id)

// y pasar validaciones={validaciones} a <Pantalla .../>
```

- [ ] **Step 8: Correr toda la suite de la carpeta afectada**

Run: `npx vitest run tests/server/app/acciones.test.ts tests/server/app/validaciones.test.ts && npx tsc --noEmit`
Expected: PASS, sin errores de tipos

- [ ] **Step 9: Verificación manual en navegador**

Con `pnpm dev` corriendo, abrir un comprobante `leido` real y confirmar: el panel de validaciones aparece arriba del formulario, con los 4 ítems y sus glifos de color; si el CUIT no matchea, aparece el buscador; buscar y elegir un proveedor actualiza la razón social y hace desaparecer el error.

- [ ] **Step 10: Commit**

```bash
git add src/components/revision/validaciones.tsx src/components/revision/validaciones.module.css \
  src/components/revision/selector-proveedor.tsx src/components/revision/selector-proveedor.module.css \
  src/server/app/acciones.ts src/components/revision/pantalla.tsx "src/app/comprobantes/[id]/page.tsx" \
  tests/server/app/acciones.test.ts
git commit -m "$(cat <<'EOF'
Agregar el panel de validaciones y el selector manual de proveedor

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Gatear "Confirmar datos" contra las validaciones bloqueantes

**Files:**
- Modify: `src/server/app/acciones.ts` (`confirmarComprobante` re-valida antes de confirmar)
- Modify: `src/components/revision/barra-acciones.tsx`
- Modify: `src/components/revision/pantalla.tsx` (pasar `bloqueante` a `BarraAcciones` — en realidad `BarraAcciones` está montada desde `page.tsx`, no desde `Pantalla`; ver Step 3)
- Modify: `src/app/comprobantes/[id]/page.tsx`
- Test: `tests/server/app/acciones.test.ts`

**Interfaces:**
- Consumes: `validarComprobanteEn`/`Validaciones` (Task 3).
- Produces: `confirmarComprobante` lanza `Error('Hay validaciones bloqueantes sin resolver.')` si `bloqueante` es `true`; `BarraAcciones` recibe una prop nueva `bloqueante: boolean`.

- [ ] **Step 1: Escribir el test que falla**

```ts
// Agregar a tests/server/app/acciones.test.ts
describe('confirmarComprobante con validaciones bloqueantes', () => {
  it('rechaza confirmar si el proveedor no esta resuelto', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      // Sin CUIT resuelto: 0 matches de proveedor -> bloqueante.
      await expect(confirmarComprobante(id)).rejects.toThrow(/validaciones/i)
    })
  })
})
```

(Ojo: `confirmarComprobante` usa el pool real, no `tx` — el `insertarComprobantePrueba` sí corre dentro de `conRollback`, así que la fila desaparece al terminar el test aunque la validación se haya leído contra el pool real durante la ejecución.)

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/server/app/acciones.test.ts -t "validaciones bloqueantes"`
Expected: FAIL — hoy `confirmarComprobante` no valida nada, así que no lanza.

- [ ] **Step 3: Implementar el gate en `confirmarComprobante`**

Modificar `src/server/app/acciones.ts`:

```ts
import { validarComprobante } from '@/server/app/validaciones'

export async function confirmarComprobante(id: number): Promise<void> {
  const validaciones = await validarComprobante(id)
  if (validaciones.bloqueante) {
    throw new Error('Hay validaciones bloqueantes sin resolver.')
  }

  await conTransaccion(async (tx) => {
    // ... resto sin cambios
  })
  // ... resto sin cambios
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run tests/server/app/acciones.test.ts`
Expected: PASS. `tests/server/app/acciones.test.ts` no tiene, a la fecha de este plan, ningún test que llame a `confirmarComprobante` directamente (solo cubre `importarComprobanteEn`/`importarComprobantes`), así que el gate nuevo no puede romper un test preexistente de ese archivo.

- [ ] **Step 5: Deshabilitar "Confirmar datos" en el cliente cuando es bloqueante**

Modificar `src/components/revision/barra-acciones.tsx`:

```ts
function BotonPrimario({
  id,
  estado,
  bloqueante,
}: {
  id: number
  estado: Estado
  bloqueante: boolean
}) {
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()

  if (estado === 'leido' || estado === 'observacion') {
    return (
      <button
        type="button"
        className={styles.confirmar}
        disabled={pendiente || bloqueante}
        title={bloqueante ? 'Resolvé las validaciones en error antes de confirmar' : undefined}
        onClick={() =>
          arrancar(async () => {
            await confirmarComprobante(id)
            router.refresh()
          })
        }
      >
        {pendiente ? 'Confirmando…' : 'Confirmar datos'}
      </button>
    )
  }
  // ... resto sin cambios
}

export function BarraAcciones({
  id,
  estado,
  proveedor,
  comprobante,
  bloqueante,
}: {
  id: number
  estado: Estado
  proveedor: string
  comprobante: string
  bloqueante: boolean
}) {
  return (
    <div className={styles.barra}>
      {/* ... sin cambios ... */}
      <div className={styles.derecha}>
        <button type="button" className={styles.observacion} disabled title="Llega en la Fase 3">
          Marcar en observación
        </button>
        <BotonPrimario id={id} estado={estado} bloqueante={bloqueante} />
      </div>
    </div>
  )
}
```

En `src/app/comprobantes/[id]/page.tsx`, pasar `bloqueante={validaciones.bloqueante}` a `<BarraAcciones .../>` (ya se calculó `validaciones` en la Task 4).

- [ ] **Step 6: Correr tsc y la suite de la carpeta**

Run: `npx tsc --noEmit && npx vitest run tests/server/app/acciones.test.ts`
Expected: sin errores, todo verde

- [ ] **Step 7: Verificación manual en navegador**

Abrir un comprobante con CUIT sin match: "Confirmar datos" aparece deshabilitado con el título explicando por qué. Resolver el proveedor con el selector y recargar: el botón se habilita.

- [ ] **Step 8: Commit**

```bash
git add src/server/app/acciones.ts src/components/revision/barra-acciones.tsx "src/app/comprobantes/[id]/page.tsx" tests/server/app/acciones.test.ts
git commit -m "$(cat <<'EOF'
Bloquear "Confirmar datos" si hay validaciones en error

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Modal "Marcar en observación"

**Files:**
- Create: `src/components/revision/modal-observacion.tsx`
- Create: `src/components/revision/modal-observacion.module.css`
- Modify: `src/server/app/acciones.ts` (agregar `marcarObservacion`)
- Modify: `src/components/revision/barra-acciones.tsx` (habilitar el botón, montar el modal)
- Test: `tests/server/app/acciones.test.ts`

**Interfaces:**
- Consumes: `auditarEn` (`@/server/app/detalle`, ya existe).
- Produces: `marcarObservacion(id: number, motivo: string, nota: string): Promise<void>` (server action). `MOTIVOS_OBSERVACION: string[]` (constante exportada desde `acciones.ts`, usada tanto por la validación server-side como por el modal).

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// Agregar a tests/server/app/acciones.test.ts
import { marcarObservacion, MOTIVOS_OBSERVACION } from '@/server/app/acciones'

describe('marcarObservacion', () => {
  it('rechaza un motivo que no esta en la lista cerrada', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await expect(marcarObservacion(id, 'motivo inventado', '')).rejects.toThrow(/motivo/i)
    })
  })

  it('escribe estado, motivo, nota y la entrada de auditoria', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await marcarObservacion(id, MOTIVOS_OBSERVACION[0], 'nota de prueba')

      const fila = await getPool().then((p) =>
        p.request().input('id', sql.Int, id)
          .query(`SELECT ESTADO, MOTIVO_OBSERVACION, NOTA_OBSERVACION FROM PHF_COMPROBANTE WHERE ID=@id`),
      )
      expect(fila.recordset[0].ESTADO).toBe('observacion')
      expect(fila.recordset[0].MOTIVO_OBSERVACION).toBe(MOTIVOS_OBSERVACION[0])
      expect(fila.recordset[0].NOTA_OBSERVACION).toBe('nota de prueba')

      const detalle = await obtenerDetalle(id)
      expect(detalle.auditoria.some((a) => a.texto.includes(MOTIVOS_OBSERVACION[0]))).toBe(true)
    })
  })

  it('rechaza marcar en observacion un comprobante registrado', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'registrado' })
      await expect(marcarObservacion(id, MOTIVOS_OBSERVACION[0], '')).rejects.toThrow()
    })
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/app/acciones.test.ts -t marcarObservacion`
Expected: FAIL — `marcarObservacion` no existe

- [ ] **Step 3: Implementar**

Agregar a `src/server/app/acciones.ts`:

```ts
export const MOTIVOS_OBSERVACION = [
  'Diferencia de importe con la O/C',
  'Proveedor inexistente en Tango',
  'Falta remito asociado',
  'CAE vencido o inválido',
  'Precio distinto al acordado',
] as const

export async function marcarObservacion(id: number, motivo: string, nota: string): Promise<void> {
  if (!MOTIVOS_OBSERVACION.includes(motivo as (typeof MOTIVOS_OBSERVACION)[number])) {
    throw new Error('Motivo de observación inválido.')
  }

  await conTransaccion(async (tx) => {
    const r = await tx
      .request()
      .input('id', sql.Int, id)
      .input('motivo', sql.NVarChar(60), motivo)
      .input('nota', sql.NVarChar(1000), nota.trim() === '' ? null : nota.trim())
      .query(`
        UPDATE PHF_COMPROBANTE
        SET ESTADO = 'observacion', MOTIVO_OBSERVACION = @motivo, NOTA_OBSERVACION = @nota,
            FECHA_MODIF = SYSDATETIME()
        WHERE ID = @id AND ESTADO IN ('leido', 'observacion')
      `)
    if (r.rowsAffected[0] === 0) {
      throw new Error('El comprobante no está en un estado que permita marcarlo en observación.')
    }
    await auditarEn(tx, id, `En observación: ${motivo}`)
  })

  revalidatePath('/comprobantes')
  revalidatePath(`/comprobantes/${id}`)
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/app/acciones.test.ts`
Expected: PASS

- [ ] **Step 5: Construir el modal (client)**

```ts
// src/components/revision/modal-observacion.tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { marcarObservacion, MOTIVOS_OBSERVACION } from '@/server/app/acciones'
import styles from './modal-observacion.module.css'

export function ModalObservacion({
  id,
  abierto,
  onCerrar,
}: {
  id: number
  abierto: boolean
  onCerrar: () => void
}) {
  const [motivo, setMotivo] = useState<string | null>(null)
  const [nota, setNota] = useState('')
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()

  if (!abierto) return null

  function confirmar() {
    if (!motivo) return
    arrancar(async () => {
      await marcarObservacion(id, motivo, nota)
      onCerrar()
      router.push('/comprobantes')
    })
  }

  return (
    <div className={styles.overlay} onClick={onCerrar}>
      <div className={styles.caja} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.titulo}>Marcar en observación</h2>
        <p className={styles.subtitulo}>
          El comprobante queda pendiente y no se registra en Tango hasta resolverlo.
        </p>

        <div className={styles.motivos}>
          {MOTIVOS_OBSERVACION.map((m) => (
            <button
              key={m}
              type="button"
              className={`${styles.motivo} ${motivo === m ? styles.motivoElegido : ''}`}
              onClick={() => setMotivo(m)}
            >
              {m}
            </button>
          ))}
        </div>

        <textarea
          className={styles.nota}
          placeholder="Nota para el equipo (opcional)"
          value={nota}
          onChange={(e) => setNota(e.target.value)}
        />

        <div className={styles.acciones}>
          <button type="button" className={styles.cancelar} onClick={onCerrar} disabled={pendiente}>
            Cancelar
          </button>
          <button type="button" className={styles.confirmar} onClick={confirmar} disabled={!motivo || pendiente}>
            {pendiente ? 'Guardando…' : 'Marcar en observación'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

```css
/* src/components/revision/modal-observacion.module.css */
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(23, 25, 29, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}

.caja {
  width: 520px;
  background: var(--superficie);
  border-radius: 12px;
  padding: 24px;
  animation: riseIn 0.18s ease-out;
}

@keyframes riseIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}

.titulo {
  font-size: 17px;
  font-weight: 600;
  margin: 0 0 4px;
}

.subtitulo {
  font-size: 13px;
  color: var(--texto-3);
  margin: 0 0 16px;
}

.motivos {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}

.motivo {
  text-align: left;
  padding: 10px 13px;
  border-radius: 7px;
  font-size: 13px;
  border: 1px solid var(--borde);
  background: var(--superficie);
  cursor: pointer;
}

.motivoElegido {
  border-color: #2b4fd0;
  background: #f4f6fd;
}

.nota {
  width: 100%;
  height: 74px;
  border: 1px solid var(--borde);
  border-radius: 7px;
  padding: 10px 12px;
  font-size: 13px;
  resize: none;
  box-sizing: border-box;
  margin-bottom: 16px;
}

.acciones {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
}

.acciones button {
  height: 36px;
  padding: 0 15px;
  border-radius: 7px;
  font-size: 13px;
  border: none;
  cursor: pointer;
}

.cancelar {
  background: var(--fondo-app);
  border: 1px solid var(--borde) !important;
  color: #4a4e56;
}

.confirmar {
  background: var(--alerta);
  color: #fff;
}

.confirmar:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 6: Habilitar el botón en `BarraAcciones` y montar el modal**

Modificar `src/components/revision/barra-acciones.tsx`: el componente pasa de server a necesitar estado de UI (abrir/cerrar el modal), así que se agrega `'use client'` si no lo tenía — ya lo tiene, es `'use client'` desde el inicio. Agregar:

```ts
import { useState } from 'react'
import { ModalObservacion } from './modal-observacion'

// dentro de BarraAcciones, antes del return:
  const [modalAbierto, setModalAbierto] = useState(false)
  const puedeObservar = estado === 'leido' || estado === 'observacion'

// reemplazar el boton deshabilitado por:
        <button
          type="button"
          className={styles.observacion}
          disabled={!puedeObservar}
          title={puedeObservar ? undefined : 'No disponible en este estado'}
          onClick={() => setModalAbierto(true)}
        >
          Marcar en observación
        </button>
        <BotonPrimario id={id} estado={estado} bloqueante={bloqueante} />
      </div>
      <ModalObservacion id={id} abierto={modalAbierto} onCerrar={() => setModalAbierto(false)} />
```

(El `</div>` de `.derecha` y el `<ModalObservacion>` van fuera de `.derecha` pero dentro de `.barra` — ajustar el cierre de tags según el JSX real del archivo.)

- [ ] **Step 7: Correr tsc y verificación manual**

Run: `npx tsc --noEmit`
Expected: sin errores

En el navegador: abrir un comprobante `leido`, click en "Marcar en observación", elegir un motivo, confirmar, verificar que vuelve a la bandeja y que el comprobante aparece con badge "En observación". Reabrirlo y confirmar que el historial muestra la entrada.

- [ ] **Step 8: Commit**

```bash
git add src/components/revision/modal-observacion.tsx src/components/revision/modal-observacion.module.css \
  src/server/app/acciones.ts src/components/revision/barra-acciones.tsx tests/server/app/acciones.test.ts
git commit -m "$(cat <<'EOF'
Habilitar el modal de marcar en observación

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Sistema de toasts

**Files:**
- Create: `src/components/toast/toast-provider.tsx`
- Create: `src/components/toast/toast.module.css`
- Modify: `src/app/layout.tsx`
- Modify: `src/components/revision/barra-acciones.tsx` (toast al confirmar)
- Modify: `src/components/revision/modal-observacion.tsx` (toast al marcar en observación)
- Modify: `src/components/bandeja/importar.tsx` (toast al importar)

**Interfaces:**
- Produces: `<ToastProvider>{children}</ToastProvider>`, hook `useToast(): (mensaje: string) => void`.

- [ ] **Step 1: Construir el provider**

No hay test automatizado de UI en este proyecto (sin jsdom/testing-library, ver Fase 2 Task 11) — se verifica en navegador, igual que el resto de componentes visuales de esta fase.

```ts
// src/components/toast/toast-provider.tsx
'use client'

import { createContext, useCallback, useContext, useRef, useState } from 'react'
import styles from './toast.module.css'

const ToastContext = createContext<((mensaje: string) => void) | null>(null)

const DURACION_MS = 2600

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [mensaje, setMensaje] = useState<string | null>(null)
  const timeout = useRef<ReturnType<typeof setTimeout>>()

  const mostrar = useCallback((m: string) => {
    clearTimeout(timeout.current)
    setMensaje(m)
    timeout.current = setTimeout(() => setMensaje(null), DURACION_MS)
  }, [])

  return (
    <ToastContext.Provider value={mostrar}>
      {children}
      {mensaje && <div className={styles.toast}>{mensaje}</div>}
    </ToastContext.Provider>
  )
}

export function useToast(): (mensaje: string) => void {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast debe usarse dentro de ToastProvider')
  return ctx
}
```

```css
/* src/components/toast/toast.module.css */
.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  background: var(--oscuro);
  color: #fff;
  font-size: 13px;
  padding: 12px 20px;
  border-radius: 9px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22);
  z-index: 70;
  animation: riseIn 0.2s ease-out;
}

@keyframes riseIn {
  from { opacity: 0; transform: translate(-50%, 8px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
```

- [ ] **Step 2: Envolver el layout raíz**

```ts
// src/app/layout.tsx
import { ToastProvider } from '@/components/toast/toast-provider'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR">
      <body style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <HeaderGlobal />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  )
}
```

- [ ] **Step 3: Confirmar tipos y arranque**

Run: `npx tsc --noEmit && pnpm dev` (verificar en navegador que la app sigue arrancando y renderizando la bandeja sin errores en consola)
Expected: sin errores

- [ ] **Step 4: Commit del provider**

```bash
git add src/components/toast/toast-provider.tsx src/components/toast/toast.module.css src/app/layout.tsx
git commit -m "$(cat <<'EOF'
Agregar el sistema de toasts (ToastProvider + useToast)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Disparar el toast en "Confirmar datos" y capturar el error de validaciones bloqueantes**

Modificar `BotonPrimario` en `src/components/revision/barra-acciones.tsx`:

```ts
import { useToast } from '@/components/toast/toast-provider'

function BotonPrimario({ id, estado, bloqueante }: { id: number; estado: Estado; bloqueante: boolean }) {
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()
  const toast = useToast()

  if (estado === 'leido' || estado === 'observacion') {
    return (
      <button
        type="button"
        className={styles.confirmar}
        disabled={pendiente || bloqueante}
        title={bloqueante ? 'Resolvé las validaciones en error antes de confirmar' : undefined}
        onClick={() =>
          arrancar(async () => {
            try {
              await confirmarComprobante(id)
              toast('Comprobante confirmado.')
              router.refresh()
            } catch (err) {
              toast(err instanceof Error ? err.message : 'No se pudo confirmar el comprobante.')
            }
          })
        }
      >
        {pendiente ? 'Confirmando…' : 'Confirmar datos'}
      </button>
    )
  }
  // ... resto sin cambios
}
```

- [ ] **Step 6: Disparar el toast al marcar en observación**

Modificar `src/components/revision/modal-observacion.tsx`:

```ts
import { useToast } from '@/components/toast/toast-provider'

// dentro de ModalObservacion:
  const toast = useToast()

  function confirmar() {
    if (!motivo) return
    arrancar(async () => {
      await marcarObservacion(id, motivo, nota)
      toast('Comprobante marcado en observación.')
      onCerrar()
      router.push('/comprobantes')
    })
  }
```

- [ ] **Step 7: Disparar el toast al terminar de importar**

Leer `src/components/bandeja/importar.tsx` antes de tocarlo, para ubicar el punto exacto donde el modal cierra tras terminar el `import`. Agregar el hook `useToast()` y llamarlo con `` `${importados} comprobante${importados === 1 ? '' : 's'} importado${importados === 1 ? '' : 's'}.` `` (usando el `importados: number` que ya devuelve `importarComprobantes`) en el mismo punto donde hoy se cierra el modal.

- [ ] **Step 8: Verificación manual en navegador**

Confirmar un comprobante: aparece el toast "Comprobante confirmado." y desaparece solo a los ~2.6s. Marcar en observación: toast correspondiente. Importar uno o más PDFs: toast con la cantidad.

- [ ] **Step 9: Commit**

```bash
git add src/components/revision/barra-acciones.tsx src/components/revision/modal-observacion.tsx src/components/bandeja/importar.tsx
git commit -m "$(cat <<'EOF'
Disparar toasts al confirmar, marcar en observación e importar

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `condcompra` de texto libre a select

**Files:**
- Modify: `src/lib/campos.ts`
- Modify: `src/components/revision/campo.tsx`
- Modify: `src/components/revision/formulario.tsx`
- Modify: `src/components/revision/pantalla.tsx`
- Modify: `src/app/comprobantes/[id]/page.tsx`
- Test: `tests/lib/campos.test.ts`

**Interfaces:**
- Consumes: `listarCondicionesCompra(): Promise<CondicionCompra[]>` de `@/server/tango/condicionesCompra` (ya existe).
- Produces: `TipoCampo` gana el valor `'select'`; `Campo` acepta `opciones?: { valor: string; label: string }[]`.

- [ ] **Step 1: Escribir el test que falla**

```ts
// Agregar a tests/lib/campos.test.ts
import { campoPorClave } from '@/lib/campos'

it('condcompra es un campo de tipo select', () => {
  expect(campoPorClave('condcompra')?.tipo).toBe('select')
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/lib/campos.test.ts -t condcompra`
Expected: FAIL — hoy `tipo` es `'texto'`

- [ ] **Step 3: Actualizar el catálogo**

En `src/lib/campos.ts`:

```ts
export type TipoCampo = 'texto' | 'fecha' | 'decimal' | 'porcentaje' | 'select'
```

Y cambiar la definición de `condcompra`:

```ts
  { clave: 'condcompra', label: 'Condición de compra', grupo: 'imputacion', span: 3,
    tipo: 'select', mono: false, extraePorIA: false, soloLectura: false },
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run tests/lib/campos.test.ts`
Expected: PASS

- [ ] **Step 5: Soportar `tipo: 'select'` en `Campo`**

Modificar `src/components/revision/campo.tsx` para aceptar `opciones` y renderizar `<select>` en vez de `<input>` cuando `def.tipo === 'select'`:

```ts
export function Campo({
  def,
  valor,
  confianza,
  bloqueado = false,
  opciones,
  onCambio,
  onFoco,
  onDesenfoque,
}: {
  def: DefCampo
  valor: string
  confianza: number | null
  bloqueado?: boolean
  opciones?: { valor: string; label: string }[]
  onCambio: (v: string) => void
  onFoco: (v: string) => void
  onDesenfoque: () => void
}) {
  // ... local, tocado, useEffect de autosave: sin cambios ...

  const soloLectura = def.soloLectura || bloqueado
  // ... baja, nivel: sin cambios ...

  if (def.tipo === 'select') {
    return (
      <div className={styles.campo} style={{ gridColumn: `span ${def.span}` }}>
        <label className={styles.label} htmlFor={`campo-${def.clave}`}>
          {def.label}
        </label>
        <select
          id={`campo-${def.clave}`}
          className={styles.input}
          value={local}
          disabled={soloLectura}
          onChange={(e) => {
            tocado.current = true
            setLocal(e.target.value)
          }}
          onFocus={() => onFoco(local)}
          onBlur={onDesenfoque}
        >
          <option value="">—</option>
          {(opciones ?? []).map((o) => (
            <option key={o.valor} value={o.valor}>{o.label}</option>
          ))}
        </select>
      </div>
    )
  }

  return (
    // ... JSX existente del <input>, sin cambios ...
  )
}
```

Agregar a `formulario.module.css` (si `.input` no aplica bien a un `<select>`, verificar altura/padding/radio/borde iguales a los del input existente — reusar la misma clase `.input` es la intención, confirmar visualmente en el Step 8).

- [ ] **Step 6: Pasar las opciones desde `page.tsx` hasta `Campo`**

En `src/app/comprobantes/[id]/page.tsx`:

```ts
import { listarCondicionesCompra } from '@/server/tango/condicionesCompra'

// junto a las demas cargas de datos:
const condiciones = await listarCondicionesCompra()

// pasar condicionesCompra={condiciones} a <Pantalla .../>
```

En `src/components/revision/pantalla.tsx`, agregar la prop `condicionesCompra: CondicionCompra[]` y pasarla a `<Formulario .../>`.

En `src/components/revision/formulario.tsx`, agregar la prop `condicionesCompra: CondicionCompra[]` y, al renderizar `Campo`, pasarle `opciones` solo para `condcompra`:

```ts
<Campo
  key={def.clave}
  def={def}
  valor={valores[def.clave] ?? ''}
  confianza={iniciales[def.clave]?.confianza ?? null}
  bloqueado={soloLectura}
  opciones={
    def.clave === 'condcompra'
      ? condicionesCompra.map((c) => ({ valor: String(c.codigo), label: c.descripcion }))
      : undefined
  }
  onCambio={(v) => cambiar(def.clave, v)}
  onFoco={onEnfocar}
  onDesenfoque={() => onEnfocar(null)}
/>
```

- [ ] **Step 7: Correr tsc**

Run: `npx tsc --noEmit`
Expected: sin errores

- [ ] **Step 8: Verificación manual en navegador**

Abrir un comprobante: "Condición de pago" es ahora un `<select>` con la misma altura/borde/radio que los demás inputs, poblado con las condiciones reales de Tango. Elegir una opción dispara el autosave igual que un input de texto.

- [ ] **Step 9: Commit**

```bash
git add src/lib/campos.ts src/components/revision/campo.tsx src/components/revision/formulario.tsx \
  src/components/revision/pantalla.tsx "src/app/comprobantes/[id]/page.tsx" tests/lib/campos.test.ts
git commit -m "$(cat <<'EOF'
Convertir Condición de compra de texto libre a select contra Tango

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Atajos de teclado y navegación J/K con contexto de filtro

**Files:**
- Create: `src/components/revision/atajos.ts`
- Modify: `src/server/app/comprobantes.ts` (agregar `obtenerVecinosEn`/`obtenerVecinos`)
- Modify: `src/components/bandeja/tabla.tsx` (el link conserva `filtro`/`q`)
- Modify: `src/components/revision/pantalla.tsx` (monta el hook, recibe vecinos + callback de observación/confirmar)
- Modify: `src/app/comprobantes/[id]/page.tsx` (lee `searchParams`, calcula vecinos)
- Test: `tests/server/app/comprobantes.test.ts`

**Interfaces:**
- Consumes: `ClaveTab` (`@/lib/estados`, ya existe).
- Produces:
  - `type Vecinos = { anteriorId: number | null; siguienteId: number | null }`
  - `obtenerVecinosEn(e: Ejecutor, opts: { filtro: ClaveTab; query: string }, id: number): Promise<Vecinos>`
  - `obtenerVecinos(opts, id): Promise<Vecinos>`
  - `useAtajos(opts: { onConfirmar: () => void; onObservar: () => void; anteriorHref: string | null; siguienteHref: string | null })` (hook de cliente, sin valor de retorno — solo efectos)

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// Agregar a tests/server/app/comprobantes.test.ts
import { obtenerVecinosEn } from '@/server/app/comprobantes'

describe('obtenerVecinosEn', () => {
  it('encuentra el anterior y el siguiente dentro del mismo filtro', async () => {
    await conRollback(async (tx) => {
      const a = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const b = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const c = await insertarComprobantePrueba(tx, { estado: 'leido' })
      // Orden de la bandeja: FECHA_ALTA DESC, ID DESC -> mas nuevo primero: c, b, a.

      const vecinosDeB = await obtenerVecinosEn(tx, { filtro: 'leido', query: '' }, b)
      expect(vecinosDeB.anteriorId).toBe(c) // mas nuevo que b
      expect(vecinosDeB.siguienteId).toBe(a) // mas viejo que b

      const vecinosDeC = await obtenerVecinosEn(tx, { filtro: 'leido', query: '' }, c)
      expect(vecinosDeC.anteriorId).toBe(null) // c es el mas nuevo de los tres

      const vecinosDeA = await obtenerVecinosEn(tx, { filtro: 'leido', query: '' }, a)
      expect(vecinosDeA.siguienteId).toBe(null) // a es el mas viejo de los tres
    })
  })

  it('no cruza el filtro activo', async () => {
    await conRollback(async (tx) => {
      const a = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await insertarComprobantePrueba(tx, { estado: 'confirmado' }) // no deberia contar como vecino
      const c = await insertarComprobantePrueba(tx, { estado: 'leido' })

      const vecinosDeC = await obtenerVecinosEn(tx, { filtro: 'leido', query: '' }, c)
      expect(vecinosDeC.siguienteId).toBe(a) // salta el 'confirmado' del medio
    })
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/app/comprobantes.test.ts -t obtenerVecinos`
Expected: FAIL — `obtenerVecinosEn` no existe

- [ ] **Step 3: Implementar `obtenerVecinosEn`**

Agregar a `src/server/app/comprobantes.ts`, cerca de `listarComprobantesEn` (reusa `pedido`, `WHERE_ESTADO`, `WHERE_BUSQUEDA` ya definidas en el archivo):

```ts
export type Vecinos = { anteriorId: number | null; siguienteId: number | null }

export async function obtenerVecinosEn(
  e: Ejecutor,
  { filtro, query }: { filtro: ClaveTab; query: string },
  id: number,
): Promise<Vecinos> {
  const actual = await pedido(e, filtro, query)
    .input('id', sql.Int, id)
    .query<Record<string, unknown>>(`
      SELECT FECHA_ALTA FROM PHF_COMPROBANTE
      WHERE ID = @id AND ${WHERE_ESTADO} AND ${WHERE_BUSQUEDA}
    `)
  if (actual.recordset.length === 0) return { anteriorId: null, siguienteId: null }
  const fechaAlta = actual.recordset[0].FECHA_ALTA

  const [siguiente, anterior] = await Promise.all([
    pedido(e, filtro, query)
      .input('id', sql.Int, id)
      .input('fecha', sql.DateTime2, fechaAlta as Date)
      .query<Record<string, unknown>>(`
        SELECT TOP 1 ID FROM PHF_COMPROBANTE
        WHERE ${WHERE_ESTADO} AND ${WHERE_BUSQUEDA}
          AND (FECHA_ALTA < @fecha OR (FECHA_ALTA = @fecha AND ID < @id))
        ORDER BY FECHA_ALTA DESC, ID DESC
      `),
    pedido(e, filtro, query)
      .input('id', sql.Int, id)
      .input('fecha', sql.DateTime2, fechaAlta as Date)
      .query<Record<string, unknown>>(`
        SELECT TOP 1 ID FROM PHF_COMPROBANTE
        WHERE ${WHERE_ESTADO} AND ${WHERE_BUSQUEDA}
          AND (FECHA_ALTA > @fecha OR (FECHA_ALTA = @fecha AND ID > @id))
        ORDER BY FECHA_ALTA ASC, ID ASC
      `),
  ])

  return {
    siguienteId: siguiente.recordset.length ? Number(siguiente.recordset[0].ID) : null,
    anteriorId: anterior.recordset.length ? Number(anterior.recordset[0].ID) : null,
  }
}

export async function obtenerVecinos(opts: { filtro: ClaveTab; query: string }, id: number): Promise<Vecinos> {
  return obtenerVecinosEn(await getPool(), opts, id)
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/app/comprobantes.test.ts`
Expected: PASS

- [ ] **Step 5: El link de la bandeja conserva filtro y búsqueda**

Modificar `src/components/bandeja/tabla.tsx`: la firma cambia para recibir `filtro`/`query` y armarlos en el `href`.

```ts
export function Tabla({ filas, filtro, query }: { filas: FilaBandeja[]; filtro: ClaveTab; query: string }) {
  const qs = new URLSearchParams()
  if (filtro !== 'todos') qs.set('filtro', filtro)
  if (query) qs.set('q', query)
  const sufijo = qs.toString() ? `?${qs.toString()}` : ''

  // ... en el map de filas:
        <Link key={f.id} href={`/comprobantes/${f.id}${sufijo}`} className={styles.fila}>
```

Actualizar el llamador en `src/app/comprobantes/page.tsx`: `<Tabla filas={filas} filtro={filtro} query={query} />`.

- [ ] **Step 6: Construir el hook de atajos**

```ts
// src/components/revision/atajos.ts
'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

function estaEditando(): boolean {
  const activo = document.activeElement
  if (!activo) return false
  const tag = activo.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function useAtajos({
  onConfirmar,
  onObservar,
  anteriorHref,
  siguienteHref,
}: {
  onConfirmar: () => void
  onObservar: () => void
  anteriorHref: string | null
  siguienteHref: string | null
}) {
  const router = useRouter()

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (estaEditando()) return

      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault()
        onConfirmar()
        return
      }
      if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        onObservar()
        return
      }
      if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') {
        if (siguienteHref) router.push(siguienteHref)
        return
      }
      if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') {
        if (anteriorHref) router.push(anteriorHref)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onConfirmar, onObservar, anteriorHref, siguienteHref, router])
}
```

- [ ] **Step 7: Montar el hook en `BarraAcciones` y conectar con confirmar/observar**

El confirmar y el observar hoy viven en `BarraAcciones`/`ModalObservacion`, montados desde `page.tsx`, no desde `Pantalla`. Para que `Ctrl+Enter`/`Ctrl+O` disparen esas acciones sin duplicar el estado de "modal abierto"/"confirmando" en dos componentes, `BarraAcciones` pasa a concentrar el `useTransition` de confirmar (hoy vive dentro de `BotonPrimario`) y se lo pasa por props — así el atajo y el click del botón comparten una sola transición en vez de manejar dos independientes que podrían pisarse. Reemplazar el contenido completo de `src/components/revision/barra-acciones.tsx` por:

```ts
'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { confirmarComprobante } from '@/server/app/acciones'
import type { Estado } from '@/lib/estados'
import { BadgeEstado } from '@/components/badge-estado'
import { useToast } from '@/components/toast/toast-provider'
import { ModalObservacion } from './modal-observacion'
import { useAtajos } from './atajos'
import styles from './barra-acciones.module.css'

/**
 * Botón primario contextual según el estado. `leido`/`observacion` dejan
 * confirmar; `confirmado` y `registrado` muestran la acción que sigue pero
 * deshabilitada, con el título de la fase que la trae. `pendiente`/`onClick`
 * vienen de `BarraAcciones`: el atajo Ctrl+Enter y el click del botón
 * comparten la misma transición, no dos independientes.
 */
function BotonPrimario({
  estado,
  bloqueante,
  pendiente,
  onClick,
}: {
  estado: Estado
  bloqueante: boolean
  pendiente: boolean
  onClick: () => void
}) {
  if (estado === 'leido' || estado === 'observacion') {
    return (
      <button
        type="button"
        className={styles.confirmar}
        disabled={pendiente || bloqueante}
        title={bloqueante ? 'Resolvé las validaciones en error antes de confirmar' : undefined}
        onClick={onClick}
      >
        {pendiente ? 'Confirmando…' : 'Confirmar datos'}
      </button>
    )
  }

  if (estado === 'confirmado') {
    return (
      <button type="button" className={styles.registrar} disabled title="Llega en la Fase 4">
        Registrar en Tango
      </button>
    )
  }

  if (estado === 'registrado') {
    return (
      <button type="button" className={styles.verAsiento} disabled title="Llega en la Fase 4">
        Ver asiento en Tango
      </button>
    )
  }

  return null
}

export function BarraAcciones({
  id,
  estado,
  proveedor,
  comprobante,
  bloqueante,
  anteriorHref,
  siguienteHref,
}: {
  id: number
  estado: Estado
  proveedor: string
  comprobante: string
  bloqueante: boolean
  anteriorHref: string | null
  siguienteHref: string | null
}) {
  const [modalAbierto, setModalAbierto] = useState(false)
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()
  const toast = useToast()
  const puedeObservar = estado === 'leido' || estado === 'observacion'
  const puedeConfirmar = puedeObservar && !bloqueante

  function confirmar() {
    if (!puedeConfirmar || pendiente) return
    arrancar(async () => {
      try {
        await confirmarComprobante(id)
        toast('Comprobante confirmado.')
        router.refresh()
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo confirmar el comprobante.')
      }
    })
  }

  useAtajos({
    onConfirmar: confirmar,
    onObservar: () => {
      if (puedeObservar) setModalAbierto(true)
    },
    anteriorHref,
    siguienteHref,
  })

  return (
    <div className={styles.barra}>
      <Link href="/comprobantes" className={styles.volver}>
        ← Bandeja
      </Link>
      <span className={styles.proveedor}>{proveedor}</span>
      <span className={styles.comprobante}>{comprobante}</span>
      <BadgeEstado estado={estado} />

      <div className={styles.derecha}>
        <button
          type="button"
          className={styles.observacion}
          disabled={!puedeObservar}
          title={puedeObservar ? undefined : 'No disponible en este estado'}
          onClick={() => setModalAbierto(true)}
        >
          Marcar en observación
        </button>
        <BotonPrimario estado={estado} bloqueante={bloqueante} pendiente={pendiente} onClick={confirmar} />
      </div>

      <ModalObservacion id={id} abierto={modalAbierto} onCerrar={() => setModalAbierto(false)} />
    </div>
  )
}
```

Este reemplazo consolida en un solo archivo lo que las Tasks 5, 6 y 7 fueron agregando por partes (`bloqueante`, el modal, el toast) más lo nuevo de esta task (`anteriorHref`/`siguienteHref`, `useAtajos`, y el `useTransition` unificado). Verificar que el comportamiento visual (texto "Confirmando…", disabled, título del tooltip) se preserva idéntico al de las tasks anteriores.

- [ ] **Step 8: Calcular y pasar los vecinos desde `page.tsx`**

Primero, en `src/app/comprobantes/page.tsx`, exportar la función que ya existe:

```ts
export function leerFiltro(v: string | undefined): ClaveTab {
  const valido = ORDEN_TABS.some((t) => t.clave === v)
  return valido ? (v as ClaveTab) : 'todos'
}
```

Después, en `src/app/comprobantes/[id]/page.tsx`:

```ts
import { obtenerVecinos } from '@/server/app/comprobantes'
import { leerFiltro } from '@/app/comprobantes/page'

export default async function RevisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ filtro?: string; q?: string }>
}) {
  const { id: idParam } = await params
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) notFound()

  const sp = await searchParams
  const filtro = leerFiltro(sp.filtro)
  const query = sp.q ?? ''

  const encabezado = await obtenerEncabezado(id)
  if (!encabezado) notFound()

  const vecinos = await obtenerVecinos({ filtro, query }, id)
  const qs = new URLSearchParams()
  if (filtro !== 'todos') qs.set('filtro', filtro)
  if (query) qs.set('q', query)
  const sufijo = qs.toString() ? `?${qs.toString()}` : ''

  const anteriorHref = vecinos.anteriorId ? `/comprobantes/${vecinos.anteriorId}${sufijo}` : null
  const siguienteHref = vecinos.siguienteId ? `/comprobantes/${vecinos.siguienteId}${sufijo}` : null

  // pasar anteriorHref y siguienteHref a <BarraAcciones .../> junto con
  // el resto de las props que ya se le pasan (id, estado, proveedor,
  // comprobante, bloqueante de la Task 5)
}
```

`leerFiltro` está definida como función interna (no exportada) en `src/app/comprobantes/page.tsx`. Exportarla desde ahí (`export function leerFiltro(...)`) e importarla en `page.tsx` de la revisión, en vez de duplicarla.

- [ ] **Step 9: Correr tsc y toda la suite tocada**

Run: `npx tsc --noEmit && npx vitest run tests/server/app/comprobantes.test.ts`
Expected: sin errores, todo verde

- [ ] **Step 10: Verificación manual en navegador**

Con al menos 3 comprobantes `leido`: abrir el del medio, presionar `J` → navega al más viejo; `K` dos veces → navega al más nuevo y se detiene ahí (sin más `K` disponible, no pasa nada). Verificar que `J`/`K` no interceptan mientras se edita un input de texto (escribir la letra "j" en el campo de razón social no debe navegar). `Ctrl+Enter` confirma si el botón no está bloqueado; `Ctrl+O` abre el modal de observación.

- [ ] **Step 11: Commit**

```bash
git add src/components/revision/atajos.ts src/server/app/comprobantes.ts src/components/bandeja/tabla.tsx \
  src/app/comprobantes/page.tsx src/components/revision/barra-acciones.tsx "src/app/comprobantes/[id]/page.tsx" \
  tests/server/app/comprobantes.test.ts
git commit -m "$(cat <<'EOF'
Agregar atajos de teclado y navegacion J/K dentro del filtro activo

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verificación final de la fase

- [ ] Correr la suite completa: `pnpm test` — todos los archivos en verde (con la flakiness conocida de `migrate.test.ts` por contención de SQL Server, ya documentada).
- [ ] `npx tsc --noEmit` limpio.
- [ ] Verificación manual en navegador de punta a punta: un comprobante con CUIT sin match (resolver a mano), uno con totales que no cierran (advertencia, no bloquea), uno marcado en observación (vuelve a la bandeja, toast, badge actualizado), navegación J/K entre 3+ comprobantes del mismo filtro, `condcompra` como select poblado con datos reales.
- [ ] Actualizar `docs/superpowers/RETOMAR.md`: marcar Fase 3 completa, listar lo que quedó funcionando, y confirmar si el ítem "7 CUIT duplicados en CPA01" de la lista de cosas a arrastrar pasa de "pendiente de resolución" a "la app ahora se lo pregunta al operador" (el dato sucio en Tango sigue existiendo, pero ya no es un riesgo silencioso).
