# Vista previa del asiento contable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un botón "Ver asiento" en la pantalla de revisión que muestra, en un modal de solo lectura, el asiento contable que Tango generaría si el comprobante se registrara ahora — sin escribir nada.

**Architecture:** Un módulo nuevo de solo lectura (`src/server/tango/asiento.ts`) simula el motor de asientos de Tango combinando `RENGLON_MODELO_CP`/`TIPO_CONTABLE`/`CUENTA` (el modelo `ID_ASIENTO_MODELO_CP=1`) con `CONCEPTO_CP`/`ARTICULO_CUENTA` (para el reemplazo de cuenta del subtotal). Reutiliza sin modificar las mismas funciones de resolución (`resolverAlicuotas`, `resolverPercepciones`, `resolverVarios`) que ya usa `registrarComprobanteEn`, así que la vista previa nunca puede divergir del registro real. Un server action delgado en `acciones.ts` expone la función al cliente; un componente modal nuevo la muestra.

**Tech Stack:** Next.js 15 App Router, TypeScript, `mssql`, Vitest (contra SQL Server real, sin mocks), CSS Modules.

**Spec:** `docs/superpowers/specs/2026-08-21-vista-previa-asiento-contable-design.md`

## Global Constraints

- Toda tabla del ERP se toca solo desde `src/server/tango/`. Este plan agrega `src/server/tango/asiento.ts`, que es el único archivo que va a nombrar `RENGLON_MODELO_CP`, `TIPO_CONTABLE`, `CUENTA`, `ASIENTO_MODELO_CP`, `CONCEPTO_CP`, `ARTICULO_CUENTA`, `CPA45`.
- `TIPO_CONTABLE`, `CUENTA` y `ASIENTO_MODELO_CP` están autorizadas de solo lectura por excepción explícita (ver `CLAUDE.md`, decisión del 2026-08-20/21) — no figuran en la documentación de Axoft para Compras/Stock, pero son tablas de configuración real, no espejos `CTA*`.
- Toda consulta va parametrizada con `.input(...)`.
- Es una vista previa de **solo lectura**: ningún paso de este plan escribe en `PHF_*` ni en el ERP.
- `ID_ASIENTO_MODELO_CP` fijo en `1` — es el único modelo que pidió el usuario.
- IBM Plex Mono para los importes del modal (regla tipográfica central del proyecto). Español rioplatense en todo el copy.
- Tests contra la base real, sin mocks. Los que insertan datos van dentro de `conRollback`.

---

### Task 1: El modelo de asiento (`cargarModeloAsiento`)

**Files:**
- Create: `src/server/tango/asiento.ts`
- Test: `tests/server/tango/asiento.test.ts`

**Interfaces:**
- Produces: `export type RenglonModelo = { codCuenta: string; descCuenta: string; leyenda: string; dh: 'D' | 'H'; reemplazaCuenta: boolean }`
- Produces: `export async function cargarModeloAsiento(): Promise<Map<string, RenglonModelo>>` — clave = `TIPO_CONTABLE.COD_TIPO_CONTABLE`.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/server/tango/asiento.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { cargarModeloAsiento } from '@/server/tango/asiento'
import { cerrarPool } from '@/server/db/pool'

afterAll(async () => {
  await cerrarPool()
})

describe('cargarModeloAsiento', () => {
  it('trae el modelo 1 con las cuentas reales verificadas contra la base', async () => {
    const modelo = await cargarModeloAsiento()

    expect(modelo.get('SB')).toMatchObject({
      codCuenta: '14003',
      descCuenta: 'COMPRAS - MERCADERIA',
      dh: 'D',
      reemplazaCuenta: true,
    })
    expect(modelo.get('EX')).toMatchObject({
      codCuenta: '14003',
      dh: 'D',
      reemplazaCuenta: true,
    })
    // Los codigos de IVA del modelo son los mismos codigos de CPA14 que ya
    // usa el formulario en porciva1..5 -- es el hallazgo central del spec.
    expect(modelo.get('1')).toMatchObject({ codCuenta: '13405', descCuenta: 'DGI - IVA CREDITO FISCAL', dh: 'D' })
    expect(modelo.get('4')).toMatchObject({ codCuenta: '13405', dh: 'D' })
    // Percepcion IIBB Tucuman, mismo codigo que codpercibb.
    expect(modelo.get('60')).toMatchObject({ codCuenta: '13411', descCuenta: 'PERCEPCIONES SUFRIDAS IIBB', dh: 'D' })
    // Total del comprobante: Haber, cuenta de proveedores, reemplazable
    // (el reemplazo en si no esta implementado -- ver el spec).
    expect(modelo.get('TO')).toMatchObject({
      codCuenta: '20002',
      descCuenta: 'PROVEEDORES',
      dh: 'H',
      reemplazaCuenta: true,
    })
  })

  it('no trae nada fuera del modulo CP', async () => {
    const modelo = await cargarModeloAsiento()
    // Sanity check: el modelo 1 tiene 26 renglones reales verificados el
    // 2026-08-21. Un numero muy distinto significa que cambio la
    // configuracion de Tango o el filtro de la query esta mal.
    expect(modelo.size).toBe(26)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/server/tango/asiento.test.ts`
Expected: FAIL — `Cannot find module '@/server/tango/asiento'` (el archivo no existe todavía).

- [ ] **Step 3: Implementar `cargarModeloAsiento`**

Crear `src/server/tango/asiento.ts`:

```ts
import sql from 'mssql'
import { getPool } from '../db/pool'

/**
 * Simula, de solo lectura, el asiento contable que Tango generaria al
 * registrar un comprobante -- sin escribir nada, ni en PHF_* ni en el ERP.
 * El asiento real lo genera un proceso aparte de Tango cuando contabiliza
 * (`ASIENTO_COMPROBANTE_CP`, fuera de alcance -- ver el spec original §2);
 * esto es una vista previa para el operador, calculada desde las tablas de
 * configuracion del motor de asientos.
 *
 * Excepcion documentada en CLAUDE.md (2026-08-20/21): TIPO_CONTABLE, CUENTA
 * y ASIENTO_MODELO_CP no figuran en la documentacion de Axoft para Compras
 * ni Stock, pero son tablas de configuracion real -- no espejos CTA* -- y
 * estan autorizadas de solo lectura.
 */

/** El unico modelo que pidio el usuario: "FACTURAS / NOTAS DE DEBITO". */
const ID_ASIENTO_MODELO_CP = 1

export type RenglonModelo = {
  codCuenta: string
  descCuenta: string
  leyenda: string
  dh: 'D' | 'H'
  /** Si esta cuenta se puede reemplazar por la del concepto o el articulo. */
  reemplazaCuenta: boolean
}

/**
 * El modelo de asiento 1, indexado por `TIPO_CONTABLE.COD_TIPO_CONTABLE`.
 * Ese codigo es la clave: para IVA (`1`-`4`) y percepcion IIBB (`60`,`61`,
 * `62`,`68`, entre otros) son los MISMOS codigos de CPA14 que ya resuelven
 * `resolverAlicuotas`/`resolverPercepciones`/`resolverVarios` -- no hace
 * falta ningun mapeo nuevo, se busca directo por ese codigo.
 */
export async function cargarModeloAsiento(): Promise<Map<string, RenglonModelo>> {
  const pool = await getPool()
  const r = await pool
    .request()
    .input('idModelo', sql.Int, ID_ASIENTO_MODELO_CP)
    .query<Record<string, unknown>>(`
      SELECT
        t.COD_TIPO_CONTABLE                                     AS codTipoContable,
        c.COD_CUENTA                                             AS codCuenta,
        LTRIM(RTRIM(ISNULL(c.DESC_CUENTA,'')))                   AS descCuenta,
        LTRIM(RTRIM(ISNULL(r.DESC_LEYENDA_RENGLON, t.DESC_TIPO_CONTABLE))) AS leyenda,
        r.D_H                                                    AS dh,
        r.REEMPLAZA_CUENTA                                       AS reemplazaCuenta
      FROM RENGLON_MODELO_CP r
      JOIN TIPO_CONTABLE t ON t.ID_TIPO_CONTABLE = r.ID_TIPO_CONTABLE
      JOIN CUENTA c ON c.ID_CUENTA = r.ID_CUENTA
      WHERE r.ID_ASIENTO_MODELO_CP = @idModelo
    `)

  const modelo = new Map<string, RenglonModelo>()
  for (const f of r.recordset) {
    modelo.set(String(f.codTipoContable).trim(), {
      codCuenta: String(f.codCuenta).trim(),
      descCuenta: String(f.descCuenta),
      leyenda: String(f.leyenda),
      dh: f.dh === 'H' ? 'H' : 'D',
      reemplazaCuenta: f.reemplazaCuenta === 'S',
    })
  }
  return modelo
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run tests/server/tango/asiento.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Typecheck y commit**

Run: `npx tsc --noEmit`

```bash
git add src/server/tango/asiento.ts tests/server/tango/asiento.test.ts
git commit -m "$(cat <<'EOF'
Agregar el modelo de asiento contable (RENGLON_MODELO_CP)

Primer paso de la vista previa del asiento: carga el modelo 1
("FACTURAS / NOTAS DE DEBITO") indexado por TIPO_CONTABLE, la clave que
despues resuelve cada linea. Solo lectura.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Cuenta del concepto y cuenta del artículo

**Files:**
- Modify: `src/server/tango/asiento.ts`
- Test: `tests/server/tango/asiento.test.ts`

**Interfaces:**
- Consumes: nada de la Task 1 (funciones independientes del modelo).
- Produces: `export type CuentaContable = { codCuenta: string; descCuenta: string }`
- Produces: `export async function cuentaDelConcepto(codConcepto: string): Promise<CuentaContable | null>`
- Produces: `export async function cuentasDeArticulos(codigos: string[]): Promise<Map<string, CuentaContable>>`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `tests/server/tango/asiento.test.ts`:

```ts
import { cargarModeloAsiento, cuentaDelConcepto, cuentasDeArticulos } from '@/server/tango/asiento'

// ... (mantener el describe de cargarModeloAsiento arriba)

describe('cuentaDelConcepto', () => {
  it('resuelve la cuenta real del concepto 712 (TELEFONOS LOCALES)', async () => {
    const cuenta = await cuentaDelConcepto('712')
    expect(cuenta).toEqual({ codCuenta: '51460', descCuenta: 'TELEFONOS LOCALES' })
  })

  it('devuelve null para un concepto que no existe', async () => {
    const cuenta = await cuentaDelConcepto('999999')
    expect(cuenta).toBeNull()
  })
})

describe('cuentasDeArticulos', () => {
  it('resuelve la cuenta de compras real de un articulo conocido', async () => {
    const cuentas = await cuentasDeArticulos(['106817'])
    expect(cuentas.get('106817')).toEqual({ codCuenta: '14003', descCuenta: 'COMPRAS - MERCADERIA' })
  })

  it('no incluye un codigo que no tiene ARTICULO_CUENTA', async () => {
    const cuentas = await cuentasDeArticulos(['no-existe-123'])
    expect(cuentas.has('no-existe-123')).toBe(false)
  })

  it('devuelve un mapa vacio para una lista vacia', async () => {
    const cuentas = await cuentasDeArticulos([])
    expect(cuentas.size).toBe(0)
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/tango/asiento.test.ts`
Expected: FAIL — `cuentaDelConcepto`/`cuentasDeArticulos` no existen.

- [ ] **Step 3: Implementar**

Agregar a `src/server/tango/asiento.ts` (después de `cargarModeloAsiento`):

```ts
export type CuentaContable = { codCuenta: string; descCuenta: string }

/**
 * La cuenta que reemplaza a Subtotal gravado/exento cuando el comprobante
 * es de conceptos o de tarjeta. `CPA45.COD_CONCEP` es el mismo codigo que
 * ya resuelve `buscarConceptoProveedor`/`buscarConceptoTarjeta`
 * (`src/server/tango/conceptos.ts`); el join a `CONCEPTO_CP` va por
 * `ID_CPA45`, no por el codigo de texto.
 */
export async function cuentaDelConcepto(codConcepto: string): Promise<CuentaContable | null> {
  const cod = codConcepto.trim()
  if (!cod) return null

  const pool = await getPool()
  const r = await pool
    .request()
    .input('cod', sql.VarChar(3), cod)
    .query<Record<string, unknown>>(`
      SELECT c.COD_CUENTA AS codCuenta, LTRIM(RTRIM(ISNULL(c.DESC_CUENTA,''))) AS descCuenta
      FROM CPA45 cp45
      JOIN CONCEPTO_CP cc ON cc.ID_CPA45 = cp45.ID_CPA45
      JOIN CUENTA c ON c.ID_CUENTA = cc.ID_CUENTA
      WHERE LTRIM(RTRIM(cp45.COD_CONCEP)) = @cod
    `)

  if (r.recordset.length === 0) return null
  const f = r.recordset[0]
  return { codCuenta: String(f.codCuenta).trim(), descCuenta: String(f.descCuenta) }
}

/**
 * La cuenta de compras de cada articulo, para reemplazar Subtotal gravado
 * en facturas de articulos. Una query por codigo (la lista es a lo sumo
 * los articulos distintos de un comprobante, tipicamente unos pocos) en
 * vez de un IN dinamico: mas simple y sigue parametrizado.
 */
export async function cuentasDeArticulos(codigos: string[]): Promise<Map<string, CuentaContable>> {
  const mapa = new Map<string, CuentaContable>()
  if (codigos.length === 0) return mapa

  const pool = await getPool()
  for (const codigo of codigos) {
    const r = await pool
      .request()
      .input('cod', sql.VarChar(20), codigo)
      .query<Record<string, unknown>>(`
        SELECT c.COD_CUENTA AS codCuenta, LTRIM(RTRIM(ISNULL(c.DESC_CUENTA,''))) AS descCuenta
        FROM ARTICULO_CUENTA ac
        JOIN CUENTA c ON c.ID_CUENTA = ac.ID_CUENTA_COMPRAS
        WHERE LTRIM(RTRIM(ac.COD_STA11)) = @cod
      `)
    if (r.recordset.length > 0) {
      const f = r.recordset[0]
      mapa.set(codigo, { codCuenta: String(f.codCuenta).trim(), descCuenta: String(f.descCuenta) })
    }
  }
  return mapa
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/tango/asiento.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck y commit**

Run: `npx tsc --noEmit`

```bash
git add src/server/tango/asiento.ts tests/server/tango/asiento.test.ts
git commit -m "$(cat <<'EOF'
Resolver la cuenta del concepto y del articulo para el asiento

cuentaDelConcepto y cuentasDeArticulos son el reemplazo de cuenta que
REEMPLAZA_CUENTA='S' habilita para Subtotal gravado/exento: CONCEPTO_CP
para facturas de conceptos/tarjeta, ARTICULO_CUENTA para las de articulos.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Armar el asiento completo (`previsualizarAsientoEn`/`previsualizarAsiento`)

**Files:**
- Modify: `src/server/tango/asiento.ts`
- Test: `tests/server/tango/asiento.test.ts`

**Interfaces:**
- Consumes: `cargarModeloAsiento`, `cuentaDelConcepto`, `cuentasDeArticulos`, `RenglonModelo`, `CuentaContable` (Tasks 1-2). `obtenerDetalleEn`/`obtenerDetalle` y `RenglonGuardado` de `@/server/app/detalle`. `resolverAlicuotas` de `@/lib/alicuotas`. `resolverPercepciones`/`resolverVarios` de `@/lib/percepciones`. `listarAlicuotasIva`/`listarCodigosImpuesto` de `./impuestos`. `conceptoDelComprobante` de `./conceptos`. `parsearImporte` de `@/lib/formato`. `insertarComprobantePrueba`/`insertarRenglonPrueba` de `@/server/app/comprobantes` (en el test). `guardarCampoEn` de `@/server/app/detalle` (en el test). `conRollback` de `@/server/db/tx` (en el test).
- Produces: `export type LineaAsiento = { codCuenta: string; descCuenta: string; leyenda: string; debe: number; haber: number }`
- Produces: `export type AsientoPreview = { lineas: LineaAsiento[]; totalDebe: number; totalHaber: number; balanceado: boolean }`
- Produces: `export type Ejecutor = { request(): sql.Request }` (mismo contrato que el resto del proyecto)
- Produces: `export async function previsualizarAsientoEn(e: Ejecutor, comprobanteId: number): Promise<AsientoPreview>`
- Produces: `export async function previsualizarAsiento(comprobanteId: number): Promise<AsientoPreview>`

**Por qué `_En`/wrapper acá:** aunque esta función solo lee, necesita leer `PHF_CAMPO`/`PHF_RENGLON` del comprobante de prueba que el test inserta dentro de un `conRollback` sin commitear. La base tiene `READ_COMMITTED_SNAPSHOT` activo (ver `docs/superpowers/RETOMAR.md`, "Fase 3: completa"): una lectura desde el pool real, en una conexión separada, **no ve** una fila insertada por una transacción que todavía no hizo commit — no se cuelga, pero devuelve vacío, que rompería el test en silencio. `obtenerDetalleEn(e, id)` ya acepta un ejecutor por esto mismo; `previsualizarAsientoEn` recibe el `tx` del test y se lo pasa. Las consultas contra Tango (`cargarModeloAsiento`, `cuentaDelConcepto`, `cuentasDeArticulos`) siguen usando `getPool()` directo: son datos de configuración reales, ya comiteados, sin relación con la transacción del test.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `tests/server/tango/asiento.test.ts` (agregar los imports que falten arriba del archivo):

```ts
import sql from 'mssql'
import { conRollback } from '@/server/db/tx'
import { insertarComprobantePrueba, insertarRenglonPrueba } from '@/server/app/comprobantes'
import { guardarCampoEn } from '@/server/app/detalle'
import { previsualizarAsientoEn } from '@/server/tango/asiento'

// ... (mantener los describe de arriba)

describe('previsualizarAsientoEn', () => {
  it('factura de conceptos: Subtotal gravado va a la cuenta del concepto', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'codprovee', '010151')
      await guardarCampoEn(tx, id, 'neto', '10000,00')
      await guardarCampoEn(tx, id, 'total', '12100,00')
      await guardarCampoEn(tx, id, 'porciva1', '21')
      await guardarCampoEn(tx, id, 'impiva1', '2100,00')

      const asiento = await previsualizarAsientoEn(tx, id)

      const sb = asiento.lineas.find((l) => l.descCuenta === 'TELEFONOS LOCALES')
      expect(sb).toMatchObject({ codCuenta: '51460', debe: 10000, haber: 0 })

      const iva = asiento.lineas.find((l) => l.codCuenta === '13405')
      expect(iva).toMatchObject({ debe: 2100, haber: 0 })

      const total = asiento.lineas.find((l) => l.codCuenta === '20002')
      expect(total).toMatchObject({ debe: 0, haber: 12100 })

      expect(asiento.totalDebe).toBe(12100)
      expect(asiento.totalHaber).toBe(12100)
      expect(asiento.balanceado).toBe(true)
    })
  })

  it('factura de articulos: Subtotal gravado va a la cuenta del articulo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')
      await guardarCampoEn(tx, id, 'neto', '80745,57')
      await guardarCampoEn(tx, id, 'total', '80745,57')
      await insertarRenglonPrueba(tx, id, {
        codigo: '106817', descripcion: 'Microondas', cantidad: '1',
        precioUnitario: '80745,57', importe: '80745.57',
      })

      const asiento = await previsualizarAsientoEn(tx, id)

      const sb = asiento.lineas.find((l) => l.descCuenta === 'COMPRAS - MERCADERIA')
      expect(sb).toMatchObject({ codCuenta: '14003', debe: 80745.57, haber: 0 })
    })
  })

  it('percepcion IIBB Tucuman va a la cuenta del modelo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'neto', '1000,00')
      await guardarCampoEn(tx, id, 'total', '1025,00')
      await guardarCampoEn(tx, id, 'percep1', 'Tucumán')
      await guardarCampoEn(tx, id, 'codpercep1', '60')
      await guardarCampoEn(tx, id, 'imppercep1', '25,00')

      const asiento = await previsualizarAsientoEn(tx, id)

      const percep = asiento.lineas.find((l) => l.codCuenta === '13411')
      expect(percep).toMatchObject({ debe: 25, haber: 0 })
    })
  })

  it('un comprobante sin campos no rompe: devuelve un asiento vacio', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      const asiento = await previsualizarAsientoEn(tx, id)
      expect(asiento.lineas).toEqual([])
      expect(asiento.totalDebe).toBe(0)
      expect(asiento.totalHaber).toBe(0)
      expect(asiento.balanceado).toBe(true)
    })
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/tango/asiento.test.ts`
Expected: FAIL — `previsualizarAsientoEn` no existe.

- [ ] **Step 3: Implementar**

Agregar a `src/server/tango/asiento.ts` (arriba del archivo, sumar imports; el resto al final):

```ts
import { obtenerDetalleEn, type RenglonGuardado } from '@/server/app/detalle'
import { resolverAlicuotas } from '@/lib/alicuotas'
import { resolverPercepciones, resolverVarios } from '@/lib/percepciones'
import { parsearImporte } from '@/lib/formato'
import { listarAlicuotasIva, listarCodigosImpuesto } from './impuestos'
import { conceptoDelComprobante } from './conceptos'
```

Y al final del archivo:

```ts
export type Ejecutor = { request(): sql.Request }

export type LineaAsiento = {
  codCuenta: string
  descCuenta: string
  leyenda: string
  debe: number
  haber: number
}

export type AsientoPreview = {
  lineas: LineaAsiento[]
  totalDebe: number
  totalHaber: number
  balanceado: boolean
}

/**
 * Agrupa los renglones de una factura de articulos por la cuenta de
 * compras que le resuelve ARTICULO_CUENTA, sumando el importe de cada
 * grupo -- una linea de Debe por cada cuenta distinta que aparezca (caso
 * dominante: un solo grupo, 9.059/9.060 articulos comparten la cuenta
 * 120). Si un articulo no tiene ARTICULO_CUENTA cargada, cae a la cuenta
 * de Subtotal gravado del modelo -- mejor mostrar el fallback que romper
 * la vista previa.
 */
async function agruparRenglonesPorCuenta(
  renglones: RenglonGuardado[],
  sb: RenglonModelo | undefined,
): Promise<{ cuenta: CuentaContable; importe: number }[]> {
  const codigos = [
    ...new Set(
      renglones
        .map((r) => (r.codigoFinal ?? r.codigo)?.trim())
        .filter((c): c is string => Boolean(c)),
    ),
  ]
  const cuentasPorArticulo = await cuentasDeArticulos(codigos)
  const fallback: CuentaContable | null = sb ? { codCuenta: sb.codCuenta, descCuenta: sb.descCuenta } : null

  const porCuenta = new Map<string, { cuenta: CuentaContable; importe: number }>()
  for (const r of renglones) {
    const codigo = (r.codigoFinal ?? r.codigo)?.trim()
    const importe = parsearImporte(r.importe)
    if (!codigo || importe <= 0) continue

    const cuenta = cuentasPorArticulo.get(codigo) ?? fallback
    if (!cuenta) continue

    const acumulado = porCuenta.get(cuenta.codCuenta)
    if (acumulado) acumulado.importe = Math.round((acumulado.importe + importe) * 100) / 100
    else porCuenta.set(cuenta.codCuenta, { cuenta, importe })
  }
  return [...porCuenta.values()]
}

/**
 * Arma la vista previa completa. No bloquea por datos faltantes o
 * codigos sin resolver -- a diferencia de `registrarComprobanteEn`, que
 * tiene que ser estricto porque escribe en Tango, esto es una vista
 * previa: una linea que no se puede resolver simplemente no aparece.
 */
export async function previsualizarAsientoEn(e: Ejecutor, comprobanteId: number): Promise<AsientoPreview> {
  const [modelo, detalle] = await Promise.all([
    cargarModeloAsiento(),
    obtenerDetalleEn(e, comprobanteId),
  ])

  const valores: Record<string, string | null | undefined> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const tipoFactura = valores.tipoFactura ?? null
  const codProvee = (valores.codprovee ?? '').trim() || null

  const lineas: LineaAsiento[] = []

  // --- Subtotal gravado (SB) y exento (EX): la cuenta se puede reemplazar. ---
  const sb = modelo.get('SB')
  const ex = modelo.get('EX')
  const neto = parsearImporte(valores.neto)
  const exento = parsearImporte(valores.exento)

  let cuentaSubtotal: CuentaContable | null = null
  let gruposArticulo: { cuenta: CuentaContable; importe: number }[] = []

  if (tipoFactura === 'conceptos' || tipoFactura === 'tarjeta') {
    const concepto = await conceptoDelComprobante(tipoFactura, codProvee)
    cuentaSubtotal = concepto ? await cuentaDelConcepto(concepto.codConcepto) : null
  } else if (tipoFactura === 'articulos') {
    gruposArticulo = await agruparRenglonesPorCuenta(detalle.renglones, sb)
    if (gruposArticulo.length > 0) {
      cuentaSubtotal = gruposArticulo.reduce((a, b) => (b.importe > a.importe ? b : a)).cuenta
    }
  }

  if (sb && neto > 0) {
    if (gruposArticulo.length > 1) {
      // Una linea de Debe por cada cuenta distinta que aparece entre los
      // articulos -- caso raro (1/9.060), pero es lo que Tango haria.
      for (const g of gruposArticulo) {
        lineas.push({ codCuenta: g.cuenta.codCuenta, descCuenta: g.cuenta.descCuenta, leyenda: sb.leyenda, debe: g.importe, haber: 0 })
      }
    } else {
      const cuenta = cuentaSubtotal ?? { codCuenta: sb.codCuenta, descCuenta: sb.descCuenta }
      lineas.push({ codCuenta: cuenta.codCuenta, descCuenta: cuenta.descCuenta, leyenda: sb.leyenda, debe: neto, haber: 0 })
    }
  }
  if (ex && exento > 0) {
    const cuenta = cuentaSubtotal ?? { codCuenta: ex.codCuenta, descCuenta: ex.descCuenta }
    lineas.push({ codCuenta: cuenta.codCuenta, descCuenta: cuenta.descCuenta, leyenda: ex.leyenda, debe: exento, haber: 0 })
  }

  // --- IVA, percepciones IIBB, impuestos varios: cuenta fija del modelo. ---
  const [alicuotas, codigosImpuesto] = await Promise.all([listarAlicuotasIva(), listarCodigosImpuesto()])
  const genericas = new Map<string, number>()

  for (const l of resolverAlicuotas(valores, alicuotas)) {
    if (l.estado === 'registra' && l.alicuota) {
      const cod = String(l.alicuota.codigo)
      genericas.set(cod, Math.round(((genericas.get(cod) ?? 0) + l.importe) * 100) / 100)
    }
  }
  for (const l of resolverPercepciones(valores, tipoFactura)) {
    if (l.estado === 'registra' && l.codigo) {
      genericas.set(l.codigo.codigo, Math.round(((genericas.get(l.codigo.codigo) ?? 0) + l.importe) * 100) / 100)
    }
  }
  for (const l of resolverVarios(valores, codigosImpuesto)) {
    if (l.estado === 'registra') {
      genericas.set(l.codigo, Math.round(((genericas.get(l.codigo) ?? 0) + l.importe) * 100) / 100)
    }
  }

  for (const [codTipo, importe] of genericas) {
    const renglon = modelo.get(codTipo)
    if (!renglon || importe <= 0) continue
    lineas.push({
      codCuenta: renglon.codCuenta,
      descCuenta: renglon.descCuenta,
      leyenda: renglon.leyenda,
      debe: renglon.dh === 'D' ? importe : 0,
      haber: renglon.dh === 'H' ? importe : 0,
    })
  }

  // --- Total del comprobante (TO): siempre Haber, cuenta del modelo. ---
  const to = modelo.get('TO')
  const total = parsearImporte(valores.total)
  if (to && total > 0) {
    lineas.push({ codCuenta: to.codCuenta, descCuenta: to.descCuenta, leyenda: to.leyenda, debe: 0, haber: total })
  }

  const totalDebe = Math.round(lineas.reduce((a, l) => a + l.debe, 0) * 100) / 100
  const totalHaber = Math.round(lineas.reduce((a, l) => a + l.haber, 0) * 100) / 100

  return {
    lineas,
    totalDebe,
    totalHaber,
    balanceado: Math.abs(totalDebe - totalHaber) < 0.01,
  }
}

export async function previsualizarAsiento(comprobanteId: number): Promise<AsientoPreview> {
  return previsualizarAsientoEn(await getPool(), comprobanteId)
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/tango/asiento.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Typecheck y suite completa**

Run: `npx tsc --noEmit`
Run: `pnpm test`
Expected: sin regresiones en el resto de la suite.

- [ ] **Step 6: Commit**

```bash
git add src/server/tango/asiento.ts tests/server/tango/asiento.test.ts
git commit -m "$(cat <<'EOF'
Armar la vista previa completa del asiento (previsualizarAsiento)

Combina el modelo (Task 1) y las cuentas de concepto/articulo (Task 2)
con las mismas funciones de resolucion de alicuotas, percepciones e
impuestos varios que ya usa registrarComprobanteEn -- la vista previa no
puede divergir del registro real porque usa exactamente el mismo camino
de resolucion, solo cambia el destino (lineas de asiento en vez de
INSERTs en CPA04/CPA18/CPA63).

_En/wrapper para que el test pueda leer un comprobante insertado dentro
de conRollback: la base tiene READ_COMMITTED_SNAPSHOT activo y una
lectura desde el pool real no ve una fila sin commitear.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Server action `verAsiento`

**Files:**
- Modify: `src/server/app/acciones.ts`

**Interfaces:**
- Consumes: `previsualizarAsiento`, `AsientoPreview` de `@/server/tango/asiento` (Task 3).
- Produces: `export async function verAsiento(comprobanteId: number): Promise<AsientoPreview>` y re-exporta `export type { AsientoPreview, LineaAsiento } from '@/server/tango/asiento'`.

- [ ] **Step 1: Agregar el import y la función**

En `src/server/app/acciones.ts`, sumar al bloque de imports (junto al de `remitos`):

```ts
import { previsualizarAsiento, type AsientoPreview } from '@/server/tango/asiento'

export type { AsientoPreview, LineaAsiento } from '@/server/tango/asiento'
```

Y agregar la función al final del archivo (después de `actualizarCantidadesRemito`):

```ts
/**
 * Vista previa de solo lectura del asiento contable. No escribe nada --
 * a diferencia del resto de las acciones de este archivo, no hace falta
 * revalidatePath ni entrada de auditoria.
 */
export async function verAsiento(comprobanteId: number): Promise<AsientoPreview> {
  return previsualizarAsiento(comprobanteId)
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: sin errores. `'use server'` exige que todo export sea funcion async -- `verAsiento` lo es; el `export type` de arriba es un type-only export, permitido (no rompe la regla, ya lo hace el archivo con otros tipos si los hubiera -- si `tsc` marca error por esto, mover el `export type` a un archivo aparte como `src/server/app/tipos-asiento.ts` que re-exporte desde `@/server/tango/asiento`, y ajustar el import del componente en la Task 5 en consecuencia).

- [ ] **Step 3: Commit**

```bash
git add src/server/app/acciones.ts
git commit -m "$(cat <<'EOF'
Exponer verAsiento como server action

Pasamanos fino a previsualizarAsiento: mismo criterio que el resto del
archivo, los componentes cliente importan todo de acciones.ts, nunca de
src/server/tango/ directo.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Modal "Ver asiento"

**Files:**
- Create: `src/components/revision/modal-asiento.tsx`
- Create: `src/components/revision/modal-asiento.module.css`

**Interfaces:**
- Consumes: `verAsiento`, `AsientoPreview` de `@/server/app/acciones` (Task 4). `formatMoneda` de `@/lib/formato`.
- Produces: `export function ModalAsiento({ id, abierto, onCerrar }: { id: number; abierto: boolean; onCerrar: () => void })`

- [ ] **Step 1: Crear el CSS**

Crear `src/components/revision/modal-asiento.module.css`:

```css
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
  width: 640px;
  max-height: 80vh;
  overflow-y: auto;
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

.mensaje {
  font-size: 13px;
  color: var(--texto-3);
  padding: 20px 0;
  text-align: center;
}

.mensajeError {
  font-size: 13px;
  color: var(--error);
  padding: 20px 0;
  text-align: center;
}

.header,
.fila,
.totales {
  display: grid;
  grid-template-columns: 1fr 110px 110px;
  gap: 10px;
  align-items: baseline;
}

.header {
  padding: 8px 0;
  border-bottom: 1px solid var(--borde-sutil-3);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--texto-4);
}

.fila {
  padding: 8px 0;
  border-top: 1px solid var(--borde-sutil-2);
  font-size: 12.5px;
}

.cuenta {
  font-family: var(--mono);
}

.leyenda {
  color: var(--texto-3);
  font-size: 11.5px;
}

.monto {
  font-family: var(--mono);
  text-align: right;
}

.totales {
  padding: 10px 0 6px;
  border-top: 2px solid var(--borde);
  font-weight: 600;
}

.aviso {
  margin: 10px 0 0;
  padding: 8px 10px;
  background: var(--error-fondo);
  border: 1px solid var(--error-borde);
  border-radius: 6px;
  color: var(--error);
  font-size: 12.5px;
}

.acciones {
  display: flex;
  justify-content: flex-end;
  margin-top: 18px;
}

.cerrar {
  height: 36px;
  padding: 0 15px;
  border-radius: 7px;
  font-size: 13px;
  border: 1px solid var(--borde);
  background: var(--fondo-app);
  color: #4a4e56;
  cursor: pointer;
}
```

- [ ] **Step 2: Crear el componente**

Crear `src/components/revision/modal-asiento.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { verAsiento, type AsientoPreview } from '@/server/app/acciones'
import { formatMoneda } from '@/lib/formato'
import styles from './modal-asiento.module.css'

/**
 * Vista previa de solo lectura del asiento contable. Carga al abrirse --
 * no antes, no tiene sentido calcularlo si el operador nunca hace click.
 */
export function ModalAsiento({
  id,
  abierto,
  onCerrar,
}: {
  id: number
  abierto: boolean
  onCerrar: () => void
}) {
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'error'>('cargando')
  const [asiento, setAsiento] = useState<AsientoPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!abierto) return
    let vigente = true
    setEstado('cargando')
    verAsiento(id)
      .then((r) => {
        if (!vigente) return
        setAsiento(r)
        setEstado('listo')
      })
      .catch((err) => {
        if (!vigente) return
        setError(err instanceof Error ? err.message : 'No se pudo calcular el asiento.')
        setEstado('error')
      })
    return () => {
      vigente = false
    }
  }, [abierto, id])

  if (!abierto) return null

  return (
    <div className={styles.overlay} onClick={onCerrar}>
      <div className={styles.caja} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.titulo}>Vista previa del asiento</h2>
        <p className={styles.subtitulo}>
          Simulado a partir del modelo contable de Tango. No se registra nada.
        </p>

        {estado === 'cargando' && <p className={styles.mensaje}>Calculando…</p>}
        {estado === 'error' && <p className={styles.mensajeError}>{error}</p>}

        {estado === 'listo' && asiento && (
          <>
            {asiento.lineas.length === 0 ? (
              <p className={styles.mensaje}>
                Todavía no hay datos suficientes para armar el asiento.
              </p>
            ) : (
              <>
                <div className={styles.header}>
                  <span>Cuenta</span>
                  <span className={styles.monto}>Debe</span>
                  <span className={styles.monto}>Haber</span>
                </div>
                {asiento.lineas.map((l, i) => (
                  <div key={i} className={styles.fila}>
                    <span>
                      <span className={styles.cuenta}>
                        {l.codCuenta} · {l.descCuenta}
                      </span>
                      <br />
                      <span className={styles.leyenda}>{l.leyenda}</span>
                    </span>
                    <span className={styles.monto}>{formatMoneda(l.debe)}</span>
                    <span className={styles.monto}>{formatMoneda(l.haber)}</span>
                  </div>
                ))}
                <div className={styles.totales}>
                  <span>Totales</span>
                  <span className={styles.monto}>{formatMoneda(asiento.totalDebe)}</span>
                  <span className={styles.monto}>{formatMoneda(asiento.totalHaber)}</span>
                </div>
                {!asiento.balanceado && (
                  <p className={styles.aviso}>
                    El asiento no cierra: revisá los importes cargados.
                  </p>
                )}
              </>
            )}
          </>
        )}

        <div className={styles.acciones}>
          <button type="button" className={styles.cerrar} onClick={onCerrar}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add src/components/revision/modal-asiento.tsx src/components/revision/modal-asiento.module.css
git commit -m "$(cat <<'EOF'
Agregar el modal de vista previa del asiento

Mismo patron visual que modal-observacion.tsx. Carga al abrirse, no
antes. Marca en rojo si el asiento no cierra (no deberia pasar nunca,
pero es una señal util mientras el comprobante se sigue corrigiendo).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Conectar el botón en la barra de acciones

**Files:**
- Modify: `src/components/revision/barra-acciones.tsx`

**Interfaces:**
- Consumes: `ModalAsiento` de `./modal-asiento` (Task 5).

- [ ] **Step 1: Agregar el estado, el botón y el modal**

En `src/components/revision/barra-acciones.tsx`:

Agregar el import junto a los otros modales:

```ts
import { ModalAsiento } from './modal-asiento'
```

Agregar el estado junto a `modalAbierto`/`modalEliminar`:

```ts
const [modalAsiento, setModalAsiento] = useState(false)
```

Agregar la variable de visibilidad junto a `puedeObservar`/`puedeConfirmar` (el botón vale durante toda la revisión, antes de registrar -- no depende de que las validaciones estén en verde, es justamente para revisar antes de eso):

```ts
const puedeVerAsiento = estado === 'leido' || estado === 'observacion' || estado === 'confirmado'
```

Agregar el botón en `.derecha`, antes de `<BotonPrimario`:

```tsx
{puedeVerAsiento && (
  <button
    type="button"
    className={styles.verAsiento}
    onClick={() => setModalAsiento(true)}
  >
    Ver asiento
  </button>
)}
```

Agregar el modal junto a `<ModalObservacion>`/`<ModalEliminar>`, al final del JSX:

```tsx
<ModalAsiento id={id} abierto={modalAsiento} onCerrar={() => setModalAsiento(false)} />
```

El resultado completo de la función `BarraAcciones` queda así (para copiar/pegar sin ambigüedad):

```tsx
export function BarraAcciones({
  id,
  estado,
  proveedor,
  comprobante,
  bloqueante,
  sinConexion,
  bloqueanteRegistro,
  tangoNComp,
  anteriorHref,
  siguienteHref,
}: {
  id: number
  estado: Estado
  proveedor: string
  comprobante: string
  bloqueante: boolean
  sinConexion: boolean
  bloqueanteRegistro: boolean
  /** El asiento en Tango, para advertir al eliminar uno ya registrado. */
  tangoNComp: string | null
  anteriorHref: string | null
  siguienteHref: string | null
}) {
  const [modalAbierto, setModalAbierto] = useState(false)
  const [modalEliminar, setModalEliminar] = useState(false)
  const [modalAsiento, setModalAsiento] = useState(false)
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()
  const toast = useToast()
  const puedeObservar = estado === 'leido' || estado === 'observacion'
  const puedeConfirmar = puedeObservar && !bloqueante
  const puedeRegistrar = estado === 'confirmado' && !sinConexion && !bloqueanteRegistro
  const puedeVerAsiento = estado === 'leido' || estado === 'observacion' || estado === 'confirmado'

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

  function registrar() {
    if (!puedeRegistrar || pendiente) return
    arrancar(async () => {
      try {
        await registrarComprobante(id)
        toast('Comprobante registrado en Tango.')
        router.refresh()
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo registrar el comprobante.')
      }
    })
  }

  function accionPrimaria() {
    if (estado === 'confirmado') registrar()
    else confirmar()
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
          className={styles.eliminar}
          title="Eliminar el comprobante de la app"
          onClick={() => setModalEliminar(true)}
        >
          Eliminar
        </button>
        <button
          type="button"
          className={styles.observacion}
          disabled={!puedeObservar}
          title={puedeObservar ? undefined : 'No disponible en este estado'}
          onClick={() => setModalAbierto(true)}
        >
          Marcar en observación
        </button>
        {puedeVerAsiento && (
          <button
            type="button"
            className={styles.verAsiento}
            onClick={() => setModalAsiento(true)}
          >
            Ver asiento
          </button>
        )}
        <BotonPrimario
          estado={estado}
          bloqueante={bloqueante}
          pendiente={pendiente}
          sinConexion={sinConexion}
          bloqueanteRegistro={bloqueanteRegistro}
          onClick={accionPrimaria}
        />
      </div>

      <ModalObservacion id={id} abierto={modalAbierto} onCerrar={() => setModalAbierto(false)} />
      <ModalAsiento id={id} abierto={modalAsiento} onCerrar={() => setModalAsiento(false)} />
      <ModalEliminar
        id={id}
        abierto={modalEliminar}
        comprobante={comprobante}
        proveedor={proveedor}
        estado={estado}
        tangoNComp={tangoNComp}
        onCerrar={() => setModalEliminar(false)}
        alTerminar={() => router.push('/comprobantes')}
      />
    </div>
  )
}
```

**Nota sobre el estilo reusado:** `styles.verAsiento` ya existe en `barra-acciones.module.css` (el botón deshabilitado "Ver asiento en Tango" del estado `registrado`, línea 96). Es el mismo estilo neutral de botón secundario -- se reusa a propósito, sin agregar una clase nueva. No hay colisión visual: uno se muestra solo en `registrado`, el otro en `leido`/`observacion`/`confirmado`, nunca los dos a la vez.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add src/components/revision/barra-acciones.tsx
git commit -m "$(cat <<'EOF'
Agregar el boton "Ver asiento" a la barra de acciones

Visible durante toda la revision (leido/observacion/confirmado), no solo
cuando las validaciones estan en verde -- es justamente para revisar
antes de eso. Reusa el estilo .verAsiento ya existente (el boton
deshabilitado "Ver asiento en Tango" del estado registrado): mismo peso
visual, nunca se muestran los dos a la vez.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Verificación en el navegador y cierre

**Files:**
- Modify: `docs/superpowers/RETOMAR.md`

- [ ] **Step 1: Correr la suite completa**

Run: `pnpm test`
Expected: todos los tests en verde, incluidos los 11 nuevos de `asiento.test.ts`.

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 2: Verificar en el navegador contra un comprobante real**

Con el dev server corriendo (`pnpm dev` si no está levantado), abrir un comprobante real de artículos con IVA y percepción IIBB cargados (por ejemplo, el `8731` o el `7015` usados en sesiones anteriores — ver `docs/superpowers/RETOMAR.md`). Click en "Ver asiento": confirmar que el modal abre, muestra líneas con cuenta+descripción+leyenda+Debe/Haber, que el subtotal gravado usa la cuenta del artículo (no la 120 del modelo, salvo que el artículo no tenga `ARTICULO_CUENTA`), que el total va a 20002 · PROVEEDORES en Haber, y que "Totales" cierra (`balanceado`). Repetir con un comprobante de conceptos (proveedor `010151`) y confirmar que el subtotal va a `51460 · TELEFONOS LOCALES`.

Verificar también: el botón no aparece en un comprobante `registrado` (queda el viejo "Ver asiento en Tango" deshabilitado, sin cambios), y sí aparece en `leido`.

- [ ] **Step 3: Actualizar `docs/superpowers/RETOMAR.md`**

Agregar una sección nueva arriba de "## Fase 4: completa" (o la sección más reciente que corresponda al momento de implementar), con el mismo formato que las entradas existentes: qué se pidió, qué tablas nuevas se leyeron, el hallazgo de los códigos compartidos entre `TIPO_CONTABLE` y `CPA14`, la excepción a la regla de tablas documentadas, y el resultado de la verificación en el navegador (con datos reales: cuentas y comprobantes concretos, no genérico).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/RETOMAR.md
git commit -m "$(cat <<'EOF'
Documentar la vista previa del asiento contable en RETOMAR.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (completado antes de entregar el plan)

**Cobertura del spec:** Excepción de tablas documentadas → Task 1 (comentario + `CLAUDE.md` ya actualizado en la sesión de brainstorming). Modelo `RENGLON_MODELO_CP`/`TIPO_CONTABLE`/`CUENTA` → Task 1. Reemplazo de cuenta por concepto/artículo → Task 2. Agrupación por cuenta distinta en artículos → Task 3 (`agruparRenglonesPorCuenta`). Omisión de Flete/Intereses/Bonificación → Task 3 (no se arma ninguna entrada para `FL`/`IN`/`BO`, simplemente no existen en la lista de campos que se recorre). Exento a la misma cuenta que gravado → Task 3 (confirmado con el usuario, `cuentaSubtotal` se usa para los dos). Cuenta fija 20002 para el Total → Task 3. Botón "Ver asiento" en la revisión → Task 6. Modal de solo lectura con Debe/Haber y aviso de balance → Task 5. Testing con datos reales → Tasks 1-3.

**Placeholders:** ninguno — cada step tiene código completo, sin "TODO" ni "similar a la Task N".

**Consistencia de tipos:** `LineaAsiento`/`AsientoPreview`/`RenglonModelo`/`CuentaContable`/`Ejecutor` se definen una sola vez (Tasks 1 y 3) y se consumen igual en las Tasks 4-6 (`AsientoPreview` re-exportado desde `acciones.ts`, consumido por `modal-asiento.tsx`). `previsualizarAsientoEn`/`previsualizarAsiento` siguen el mismo nombre en la Task 3 y en la Task 4.
