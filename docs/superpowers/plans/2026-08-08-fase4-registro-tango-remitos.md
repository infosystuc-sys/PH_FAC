# Fase 4 — Registro en Tango y asociación de remitos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar un comprobante `confirmado` en Tango Gestión (11 tablas del ERP real) y asociar los renglones de factura a remitos pendientes de facturar cuando corresponda.

**Architecture:** Sigue la frontera de carpetas ya establecida. `src/server/tango/comprobantes.ts` (existe desde Fase 3) gana la única función de escritura de todo el proyecto contra tablas del ERP: `registrarComprobanteEn`/`registrarComprobante`. Todo lo demás (validaciones nuevas, UI, server actions de la app) vive en `src/lib/`, `src/server/app/` y `src/components/`, sin SQL directo contra `CPA*`/`STA*`.

**Tech Stack:** Next.js 15 (App Router, Server Components + Server Actions), TypeScript, `mssql`, Vitest, CSS Modules.

## Global Constraints

- Todas las tablas propias llevan prefijo `PHF_`. No se crea ninguna tabla nueva en esta fase — `PHF_RENGLON.REMITO_NCOMP_IN_S`/`REMITO_N_RENGL_S` ya existen desde Fase 1, sin usar hasta ahora.
- Solo `src/server/tango/` puede emitir SQL contra `CPA*`/`STA*`/`CTA*`/`GVA*`/`SBA*`. `src/server/tango/comprobantes.ts` es el único archivo de todo el proyecto que hace `INSERT`/`UPDATE` (no solo `SELECT`) contra esas tablas.
- Toda consulta va parametrizada con `.input(...)`. Nunca concatenar valores de usuario en el SQL.
- IBM Plex Sans para la UI, IBM Plex Mono para todo dato que el operador cotejá contra el PDF (importes, CUIT, CAE, números, fechas, códigos). Los colores salen de las variables CSS de `src/app/globals.css`.
- Sin Tailwind: CSS Modules, medidas exactas en píxeles tomadas de `design/README.md`. Diseñado para ≥1280px, sin diseño mobile.
- Copy en español rioplatense, sobrio y técnico.
- Commits en español, imperativo, terminando en `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Tests: la mayoría pegan contra SQL Server real (`PUNTO_HOGAR_1`). Los que escriben van dentro de `conRollback` (`src/server/db/tx.ts`) y no asumen que las tablas están vacías — miden contra una línea de base.
- Patrón `_En`/wrapper para toda función que escriba y necesite ser testeada dentro de `conRollback`: `xEn(e: Ejecutor, ...)` + `x(...)` (wrapper sobre el pool real), igual que `elegirProveedorEn`/`elegirProveedor` y `marcarObservacionEn`/`marcarObservacion` de Fase 3.
- `N_COMP` codifica `letra(1) + puntoVenta(5, zero-padded) + numeroComprobante(8, zero-padded)`, vía `nComp()`/`letraComprobante()` de `src/lib/validaciones.ts` (Fase 3) — reusar, no reimplementar.
- Todo `INSERT` replica el patrón de columnas de la factura de referencia (`NCOMP_IN_C = 16591`, `TCOMP_IN_C='FP'`, proveedor `010246`), verificado contra la base real durante el diseño de esta fase — no una interpretación de la documentación de Tango. Los valores exactos de esa fila están en cada task que los necesita.
- `STA20.CANT_PEND` no se puede derivar (verificado en Fase 1) — se lee y se actualiza directamente, nunca se recalcula desde `CANTIDAD - CANT_FACTU - CANT_DEV`.

---

## Mapa de archivos

| Archivo | Qué hace |
|---|---|
| `src/lib/campos.ts` (extender) | Dos campos nuevos: `codpercibb`, `codpercepiva` |
| `src/lib/validaciones.ts` (extender) | `validarFormatoNComp`, `validarCondCompra`, `validarPercepcionIva`; se exporta `parsearFechaArg` (ya existe, hoy privada) |
| `src/server/app/validaciones.ts` (extender) | `validarListoParaRegistrarEn`/`validarListoParaRegistrar` |
| `src/components/revision/listo-para-registrar.tsx` (nuevo) | Panel "Listo para registrar" (server component) |
| `src/components/revision/listo-para-registrar.module.css` (nuevo) | Estilos del panel (reusa el shell de `validaciones.module.css`) |
| `src/server/tango/comprobantes.ts` (extender) | `mapearAlicuotaIva`, `registrarComprobanteEn`/`registrarComprobante` — única función de escritura del ERP |
| `src/server/app/detalle.ts` (extender) | `RenglonGuardado` gana `id`/`remitoNcompInS`/`remitoNRenglS`; `obtenerDetalleEn` los selecciona (existían sin leerse desde Fase 1) |
| `src/server/app/comprobantes.ts` (extender) | `insertarRenglonPrueba` (helper de test) |
| `src/server/app/acciones.ts` (extender) | `registrarComprobante(id)` (wrapper de server action), `asignarRemitoEn`/`asignarRemito` |
| `src/components/revision/barra-acciones.tsx` (modificar) | Habilita "Registrar en Tango"; lo deshabilita si el indicador de conexión está caído |
| `src/components/revision/remitos-pendientes.tsx` (nuevo) | Selector de remito por renglón (client) |
| `src/components/revision/remitos-pendientes.module.css` (nuevo) | Estilos |
| `src/components/revision/pantalla.tsx` (modificar) | Pasa `remitosPendientes`/conexión/validaciones nuevas a los hijos |
| `src/app/comprobantes/[id]/page.tsx` (modificar) | Trae remitos pendientes, `validarListoParaRegistrar`, estado de conexión |

---

### Task 1: Catálogo de campos — `codpercibb` y `codpercepiva`

**Files:**
- Modify: `src/lib/campos.ts`
- Test: `tests/lib/campos.test.ts`

**Interfaces:**
- Produces: dos entradas nuevas en `CAMPOS`, claves `codpercibb` y `codpercepiva`, ambas `tipo: 'select'`.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// Agregar a tests/lib/campos.test.ts
it('codpercibb es un campo de tipo select', () => {
  expect(campoPorClave('codpercibb')?.tipo).toBe('select')
})

it('codpercepiva es un campo de tipo select', () => {
  expect(campoPorClave('codpercepiva')?.tipo).toBe('select')
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/lib/campos.test.ts -t codperc`
Expected: FAIL — ninguna de las dos claves existe todavía

- [ ] **Step 3: Agregar los campos**

En `src/lib/campos.ts`, insertar estas dos entradas en `CAMPOS` inmediatamente después de `perciibb` (que ya existe, `grupo: 'importes'`):

```ts
  { clave: 'codpercibb', label: 'Código percepción IIBB', grupo: 'importes', span: 3,
    tipo: 'select', mono: false, extraePorIA: false, soloLectura: false },
```

Y después de `impiva2`/`porciva2` (junto al par de la segunda alícuota, que en la práctica es donde suele venir la percepción de IVA del 3%), agregar:

```ts
  { clave: 'codpercepiva', label: 'Código percepción IVA 3%', grupo: 'importes', span: 3,
    tipo: 'select', mono: false, extraePorIA: false, soloLectura: false },
```

Ninguno de los dos lo extrae la IA — el operador los completa a mano, igual que `condcompra`. No hace falta tocar `schemaExtraccion()`: ya filtra por `CAMPOS_IA` (`extraePorIA: true`).

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/lib/campos.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/campos.ts tests/lib/campos.test.ts
git commit -m "$(cat <<'EOF'
Agregar codpercibb y codpercepiva al catálogo de campos

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Validaciones puras nuevas

**Files:**
- Modify: `src/lib/validaciones.ts`
- Test: `tests/lib/validaciones.test.ts`

**Interfaces:**
- Consumes: nada nuevo — reusa `ResultadoValidacion` (ya existe).
- Produces:
  - `parsearFechaArg(f: string): Date | null` (ya existe, se exporta)
  - `validarFormatoNComp(ptovta: string | null | undefined, nro: string | null | undefined): ResultadoValidacion`
  - `validarCondCompra(condcompra: string | null | undefined): ResultadoValidacion`
  - `validarPercepcionIva(clave: 'IIBB' | 'IVA3', importe: string | null | undefined, codigo: string | null | undefined): ResultadoValidacion`

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// Agregar a tests/lib/validaciones.test.ts
import {
  validarFormatoNComp,
  validarCondCompra,
  validarPercepcionIva,
} from '@/lib/validaciones'

describe('validarFormatoNComp', () => {
  it('ok si ptovta tiene hasta 5 digitos y nro hasta 8', () => {
    expect(validarFormatoNComp('0011', '63576').estado).toBe('ok')
    expect(validarFormatoNComp('11', '576').estado).toBe('ok')
  })
  it('error si ptovta supera 5 digitos', () => {
    const r = validarFormatoNComp('123456', '576')
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('punto de venta')
  })
  it('error si nro supera 8 digitos', () => {
    const r = validarFormatoNComp('0011', '123456789')
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('número')
  })
  it('error si ptovta o nro no son numericos', () => {
    expect(validarFormatoNComp('AB11', '576').estado).toBe('error')
    expect(validarFormatoNComp('0011', 'X576').estado).toBe('error')
  })
  it('error si falta ptovta o nro', () => {
    expect(validarFormatoNComp(null, '576').estado).toBe('error')
    expect(validarFormatoNComp('0011', undefined).estado).toBe('error')
  })
})

describe('validarCondCompra', () => {
  it('ok si tiene un valor', () => {
    expect(validarCondCompra('60').estado).toBe('ok')
  })
  it('error si esta vacio o ausente', () => {
    expect(validarCondCompra('').estado).toBe('error')
    expect(validarCondCompra(null).estado).toBe('error')
    expect(validarCondCompra(undefined).estado).toBe('error')
  })
})

describe('validarPercepcionIva', () => {
  it('ok si el importe esta vacio (no aplica)', () => {
    expect(validarPercepcionIva('IIBB', '', null).estado).toBe('ok')
    expect(validarPercepcionIva('IIBB', null, null).estado).toBe('ok')
  })
  it('ok si el importe tiene valor y el codigo tambien', () => {
    expect(validarPercepcionIva('IIBB', '13.248,69', '60').estado).toBe('ok')
  })
  it('error si el importe tiene valor pero falta el codigo', () => {
    const r = validarPercepcionIva('IIBB', '13.248,69', null)
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('IIBB')
  })
  it('mismo criterio para IVA3, con mensaje propio', () => {
    const r = validarPercepcionIva('IVA3', '9.689,47', '')
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('IVA')
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/lib/validaciones.test.ts -t "validarFormatoNComp|validarCondCompra|validarPercepcionIva"`
Expected: FAIL — ninguna de las tres funciones existe todavía

- [ ] **Step 3: Implementar**

Primero, en la declaración existente de `parsearFechaArg` (buscar `function parsearFechaArg` en `src/lib/validaciones.ts`), agregar `export`:

```ts
export function parsearFechaArg(f: string): Date | null {
```

Agregar al final del archivo:

```ts
export function validarFormatoNComp(
  ptovta: string | null | undefined,
  nro: string | null | undefined,
): ResultadoValidacion {
  const pv = (ptovta ?? '').trim()
  const n = (nro ?? '').trim()

  if (!pv || !n) {
    return { estado: 'error', mensaje: 'Falta punto de venta o número de comprobante.' }
  }
  if (!/^\d+$/.test(pv) || !/^\d+$/.test(n)) {
    return { estado: 'error', mensaje: 'El punto de venta y el número tienen que ser numéricos.' }
  }
  if (pv.length > 5) {
    return { estado: 'error', mensaje: `El punto de venta tiene ${pv.length} dígitos, el máximo son 5.` }
  }
  if (n.length > 8) {
    return { estado: 'error', mensaje: `El número tiene ${n.length} dígitos, el máximo son 8.` }
  }
  return { estado: 'ok', mensaje: 'Formato de comprobante correcto.' }
}

export function validarCondCompra(condcompra: string | null | undefined): ResultadoValidacion {
  const v = (condcompra ?? '').trim()
  if (!v) {
    return { estado: 'error', mensaje: 'Elegí una condición de compra antes de registrar.' }
  }
  return { estado: 'ok', mensaje: 'Condición de compra elegida.' }
}

const ETIQUETA_PERCEPCION: Record<'IIBB' | 'IVA3', string> = {
  IIBB: 'la percepción de IIBB',
  IVA3: 'la percepción de IVA del 3%',
}

export function validarPercepcionIva(
  clave: 'IIBB' | 'IVA3',
  importe: string | null | undefined,
  codigo: string | null | undefined,
): ResultadoValidacion {
  const imp = (importe ?? '').trim()
  if (!imp) {
    return { estado: 'ok', mensaje: 'No aplica.' }
  }
  const cod = (codigo ?? '').trim()
  if (!cod) {
    return {
      estado: 'error',
      mensaje: `Elegí el código de ${ETIQUETA_PERCEPCION[clave]} antes de registrar.`,
    }
  }
  return { estado: 'ok', mensaje: 'Código elegido.' }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/lib/validaciones.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/validaciones.ts tests/lib/validaciones.test.ts
git commit -m "$(cat <<'EOF'
Agregar validaciones puras para el registro en Tango

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Orquestación "Listo para registrar"

**Files:**
- Modify: `src/server/app/validaciones.ts`
- Test: `tests/server/app/validaciones.test.ts`

**Interfaces:**
- Consumes: `obtenerDetalleEn`/`obtenerDetalle` (ya existe), `validarFormatoNComp`/`validarCondCompra`/`validarPercepcionIva` (Task 2).
- Produces:
  - `type ResultadoListoParaRegistrar = { condCompra: ResultadoValidacion; percepcionIibb: ResultadoValidacion; percepcionIva3: ResultadoValidacion; formatoComp: ResultadoValidacion; bloqueante: boolean }`
  - `validarListoParaRegistrarEn(e: Ejecutor, id: number, detallePrevio?: Detalle): Promise<ResultadoListoParaRegistrar>`
  - `validarListoParaRegistrar(id: number, detallePrevio?: Detalle): Promise<ResultadoListoParaRegistrar>`

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// Agregar a tests/server/app/validaciones.test.ts
import { validarListoParaRegistrarEn } from '@/server/app/validaciones'
import { guardarCampoEn } from '@/server/app/detalle'

describe('validarListoParaRegistrarEn', () => {
  it('bloqueante si falta condcompra', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0011')
      await guardarCampoEn(tx, id, 'nro', '63576')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.condCompra.estado).toBe('error')
      expect(r.bloqueante).toBe(true)
    })
  })

  it('bloqueante si hay percepcion de IIBB sin codigo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0011')
      await guardarCampoEn(tx, id, 'nro', '63576')
      await guardarCampoEn(tx, id, 'condcompra', '60')
      await guardarCampoEn(tx, id, 'perciibb', '13.248,69')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.percepcionIibb.estado).toBe('error')
      expect(r.bloqueante).toBe(true)
    })
  })

  it('bloqueante si el numero de comprobante no calza en el formato', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '123456')
      await guardarCampoEn(tx, id, 'nro', '63576')
      await guardarCampoEn(tx, id, 'condcompra', '60')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.formatoComp.estado).toBe('error')
      expect(r.bloqueante).toBe(true)
    })
  })

  it('no bloqueante si todo esta completo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0011')
      await guardarCampoEn(tx, id, 'nro', '63576')
      await guardarCampoEn(tx, id, 'condcompra', '60')
      await guardarCampoEn(tx, id, 'perciibb', '13.248,69')
      await guardarCampoEn(tx, id, 'codpercibb', '60')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.condCompra.estado).toBe('ok')
      expect(r.percepcionIibb.estado).toBe('ok')
      expect(r.percepcionIva3.estado).toBe('ok')
      expect(r.formatoComp.estado).toBe('ok')
      expect(r.bloqueante).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/app/validaciones.test.ts -t validarListoParaRegistrarEn`
Expected: FAIL — `validarListoParaRegistrarEn` no existe

- [ ] **Step 3: Implementar**

En `src/server/app/validaciones.ts`, agregar (reusar el `Ejecutor`, `obtenerDetalleEn`/`obtenerDetalle` y el tipo `Detalle` que ya importa este archivo):

```ts
import { validarFormatoNComp, validarCondCompra, validarPercepcionIva } from '@/lib/validaciones'

export type ResultadoListoParaRegistrar = {
  condCompra: ResultadoValidacion
  percepcionIibb: ResultadoValidacion
  percepcionIva3: ResultadoValidacion
  formatoComp: ResultadoValidacion
  bloqueante: boolean
}

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
  const percepcionIva3 = validarPercepcionIva('IVA3', valores.impiva2, valores.codpercepiva)
  const formatoComp = validarFormatoNComp(valores.ptovta, valores.nro)

  const bloqueante = [condCompra, percepcionIibb, percepcionIva3, formatoComp].some(
    (v) => v.estado === 'error',
  )

  return { condCompra, percepcionIibb, percepcionIva3, formatoComp, bloqueante }
}

export async function validarListoParaRegistrar(
  id: number,
  detallePrevio?: Detalle,
): Promise<ResultadoListoParaRegistrar> {
  return validarListoParaRegistrarEn(await getPool(), id, detallePrevio)
}
```

**Nota:** `percepcionIva3` mira `impiva2` (el importe de la segunda alícuota) porque, en los datos reales verificados durante el diseño de esta fase, la percepción de IVA del 3% siempre ocupó ese slot en la factura de referencia. Si en la implementación real aparece en otro slot (`impiva3`, `impiva4`...), esto va a requerir revisarse — dejar un comentario en el código señalando esta asunción explícitamente.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/app/validaciones.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/app/validaciones.ts tests/server/app/validaciones.test.ts
git commit -m "$(cat <<'EOF'
Agregar la orquestación de "listo para registrar"

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Panel "Listo para registrar"

**Files:**
- Create: `src/components/revision/listo-para-registrar.tsx`
- Create: `src/components/revision/listo-para-registrar.module.css`
- Modify: `src/components/revision/pantalla.tsx`
- Modify: `src/app/comprobantes/[id]/page.tsx`

**Interfaces:**
- Consumes: `ResultadoListoParaRegistrar` (Task 3).
- Produces: `<ListoParaRegistrar resultado={ResultadoListoParaRegistrar} />`.

- [ ] **Step 1: Construir el componente**

Mismo shell visual que `validaciones.tsx` de Fase 3 (leer ese archivo primero para copiar exactamente su estructura de tarjeta/ítem/glifo — no reinventar el layout). Reemplazar su contenido de items por:

```tsx
// src/components/revision/listo-para-registrar.tsx
import type { ResultadoListoParaRegistrar } from '@/server/app/validaciones'
import styles from './listo-para-registrar.module.css'

function nivel(estado: 'ok' | 'advertencia' | 'error') {
  if (estado === 'ok') return { glifo: '✓', clase: styles.ok }
  if (estado === 'advertencia') return { glifo: '!', clase: styles.advertencia }
  return { glifo: '✕', clase: styles.error }
}

export function ListoParaRegistrar({ resultado }: { resultado: ResultadoListoParaRegistrar }) {
  const items = [
    resultado.condCompra,
    resultado.percepcionIibb,
    resultado.percepcionIva3,
    resultado.formatoComp,
  ]

  return (
    <div className={styles.panel}>
      <h3 className={styles.titulo}>Listo para registrar</h3>
      <div className={styles.items}>
        {items.map((r, i) => {
          const { glifo, clase } = nivel(r.estado)
          return (
            <div key={i} className={styles.item}>
              <span className={`${styles.glifo} ${clase}`}>{glifo}</span>
              <span>{r.mensaje}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

Copiar el CSS de `validaciones.module.css` a `listo-para-registrar.module.css` tal cual (mismas clases `.panel`/`.titulo`/`.items`/`.item`/`.glifo`/`.ok`/`.advertencia`/`.error`) — es el mismo shell visual, solo cambia el contenido.

- [ ] **Step 2: Montar el panel condicionado a `confirmado`**

En `src/app/comprobantes/[id]/page.tsx`, junto a donde ya se llama `validarComprobante` (Fase 3), agregar:

```ts
import { validarListoParaRegistrar } from '@/server/app/validaciones'

// junto a las demas cargas de datos, condicionado a que el estado sea 'confirmado':
const listoParaRegistrar =
  encabezado.estado === 'confirmado' ? await validarListoParaRegistrar(id, detalle) : null
```

Pasar `listoParaRegistrar` a `<Pantalla .../>`.

En `src/components/revision/pantalla.tsx`, agregar la prop `listoParaRegistrar: ResultadoListoParaRegistrar | null` y renderizar `<ListoParaRegistrar resultado={listoParaRegistrar} />` justo debajo del panel de `Validaciones` de Fase 3, solo cuando `listoParaRegistrar` no es `null`.

- [ ] **Step 3: Correr tsc**

Run: `npx tsc --noEmit`
Expected: sin errores

- [ ] **Step 4: Verificación manual en navegador**

Abrir un comprobante `confirmado` sin `condcompra` elegido: aparece el panel "Listo para registrar" con el ítem de condición de compra en rojo. Elegir una condición de compra, recargar: el ítem pasa a verde.

- [ ] **Step 5: Commit**

```bash
git add src/components/revision/listo-para-registrar.tsx src/components/revision/listo-para-registrar.module.css \
  src/components/revision/pantalla.tsx "src/app/comprobantes/[id]/page.tsx"
git commit -m "$(cat <<'EOF'
Agregar el panel "Listo para registrar"

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Mapeo de alícuotas de IVA

**Files:**
- Modify: `src/server/tango/comprobantes.ts`
- Test: `tests/server/tango/comprobantes.test.ts`

**Interfaces:**
- Consumes: `listarAlicuotasIva` (`@/server/tango/impuestos`, ya existe desde Fase 1).
- Produces: `mapearAlicuotaIva(porcentaje: number, codigoElegido: string | null): Promise<{ codigo: number; porcentaje: number } | null>`

Esta función resuelve, para un porcentaje de alícuota extraído de un comprobante (ej. `21`, `3`), a qué `COD_IVA` de `CPA14` corresponde. La complicación real, verificada contra la base durante el diseño de esta fase: al 3% hay dos códigos posibles (`15` "PERCEPCION R.G.3337" y `16` "PERCEP. DE IVA"), y no hay forma de distinguirlos solo por el porcentaje — por eso el operador elige (`codpercepiva`, Task 1) cuando corresponde.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// Agregar a tests/server/tango/comprobantes.test.ts
import { mapearAlicuotaIva } from '@/server/tango/comprobantes'

describe('mapearAlicuotaIva', () => {
  it('resuelve un porcentaje sin ambiguedad (21%) sin necesitar codigo elegido', async () => {
    const r = await mapearAlicuotaIva(21, null)
    expect(r).not.toBeNull()
    expect(r!.codigo).toBe(1)
    expect(r!.porcentaje).toBe(21)
  })

  it('resuelve 10,5% sin ambiguedad', async () => {
    const r = await mapearAlicuotaIva(10.5, null)
    expect(r!.codigo).toBe(3)
  })

  it('al 3% (ambiguo), usa el codigo elegido por el operador', async () => {
    const r16 = await mapearAlicuotaIva(3, '16')
    expect(r16!.codigo).toBe(16)

    const r15 = await mapearAlicuotaIva(3, '15')
    expect(r15!.codigo).toBe(15)
  })

  it('al 3% sin codigo elegido, devuelve null (el llamador debe haber bloqueado esto antes)', async () => {
    const r = await mapearAlicuotaIva(3, null)
    expect(r).toBeNull()
  })

  it('devuelve null si el porcentaje no matchea ningun codigo', async () => {
    const r = await mapearAlicuotaIva(99, null)
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/tango/comprobantes.test.ts -t mapearAlicuotaIva`
Expected: FAIL — `mapearAlicuotaIva` no existe

- [ ] **Step 3: Implementar**

Agregar a `src/server/tango/comprobantes.ts`:

```ts
import { listarAlicuotasIva } from './impuestos'

/**
 * Resuelve un porcentaje de alicuota extraido del comprobante al COD_IVA
 * real de CPA14. Verificado contra la base: la mayoria de los porcentajes
 * (0%, 10.5%, 21%, 27%) tienen un unico codigo posible. El 3% es ambiguo
 * entre COD_IVA 15 ("PERCEPCION R.G.3337") y 16 ("PERCEP. DE IVA") -- ahi
 * hace falta el codigo que eligio el operador (codpercepiva).
 */
export async function mapearAlicuotaIva(
  porcentaje: number,
  codigoElegido: string | null,
): Promise<{ codigo: number; porcentaje: number } | null> {
  const alicuotas = await listarAlicuotasIva()
  const candidatos = alicuotas.filter((a) => a.porcentaje === porcentaje)

  if (candidatos.length === 0) return null
  if (candidatos.length === 1) return { codigo: candidatos[0].codigo, porcentaje }

  const elegido = codigoElegido ? Number(codigoElegido) : null
  const match = candidatos.find((a) => a.codigo === elegido)
  return match ? { codigo: match.codigo, porcentaje } : null
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/tango/comprobantes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/tango/comprobantes.ts tests/server/tango/comprobantes.test.ts
git commit -m "$(cat <<'EOF'
Agregar el mapeo de alícuotas de IVA para el registro en Tango

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `registrarComprobanteEn` — cabecera, percepciones, IVA y vencimientos

**Files:**
- Modify: `src/server/tango/comprobantes.ts`
- Modify: `src/server/db/tx.ts` (verificar que `conTransaccion` acepta nivel de aislamiento — ya lo acepta, ver Step 3)
- Test: `tests/server/tango/comprobantes.test.ts`

**Interfaces:**
- Consumes: `nComp`/`letraComprobante` (`@/lib/validaciones`), `buscarProveedorPorCuit`-equivalente por código (nuevo helper chico, ver Step 3), `listarCondicionesCompra` (`@/server/tango/condicionesCompra`), `mapearAlicuotaIva` (Task 5), `obtenerDetalleEn` (`@/server/app/detalle`), `usuarioActual` (`@/lib/usuario`), `parsearImporte`/`parsearFechaArg` (`@/lib/formato`, `@/lib/validaciones`).
- Produces:
  - `type RegistroTango = { ncompInC: number; tComp: string; nComp: string }`
  - `registrarComprobanteEn(e: sql.Transaction, id: number): Promise<RegistroTango>` — **sin** manejo de remitos todavía, eso es Task 7.
  - `registrarComprobante(id: number): Promise<RegistroTango>`

Esta es la función más grande del proyecto. Antes de escribirla, leer **todos** los valores reales verificados abajo — son de la factura de referencia (`NCOMP_IN_C=16591`, proveedor `010246`), consultada contra la base durante el diseño de esta fase. Los campos marcados "dinámico" se calculan por comprobante; los marcados "constante" se copian tal cual — son columnas legacy de Tango que no varían entre comprobantes de este tipo en esta instalación.

- [ ] **Step 1: Escribir el test que falla (integración, contra la base real)**

```ts
// Agregar a tests/server/tango/comprobantes.test.ts
import { registrarComprobanteEn } from '@/server/tango/comprobantes'
import { conRollback } from '@/server/db/tx'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { guardarCampoEn } from '@/server/app/detalle'
import sql from 'mssql'

describe('registrarComprobanteEn', () => {
  it('registra un comprobante sin renglones: cabecera, percepciones, IVA y vencimiento', async () => {
    await conRollback(async (tx) => {
      // Proveedor real sin CUIT duplicado, descubierto en runtime (mismo patron que
      // el resto de la suite -- no hardcodear un codigo que puede cambiar).
      const prov = await tx.request().query(`
        SELECT TOP 1 COD_PROVEE, N_CUIT FROM CPA01
        WHERE N_CUIT IS NOT NULL AND LEN(REPLACE(REPLACE(N_CUIT,'-',''),' ','')) = 11
        ORDER BY COD_PROVEE`)
      const codProvee = String(prov.recordset[0].COD_PROVEE).trim()
      const cuit = String(prov.recordset[0].N_CUIT)

      const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const condCompra = String(condicion.recordset[0].COD_CONDIC)

      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0099')
      await guardarCampoEn(tx, id, 'nro', '00012345')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'cuit', cuit)
      await guardarCampoEn(tx, id, 'codprovee', codProvee)
      await guardarCampoEn(tx, id, 'condcompra', condCompra)
      await guardarCampoEn(tx, id, 'moneda', 'ARS')
      await guardarCampoEn(tx, id, 'cotizacion', '1')
      await guardarCampoEn(tx, id, 'neto', '10.000,00')
      await guardarCampoEn(tx, id, 'porciva1', '21')
      await guardarCampoEn(tx, id, 'impiva1', '2.100,00')
      await guardarCampoEn(tx, id, 'total', '12.100,00')

      const registro = await registrarComprobanteEn(tx, id)

      expect(registro.tComp).toBe('FAC')
      expect(registro.nComp).toBe('A0009900012345')
      expect(registro.ncompInC).toBeGreaterThan(0)

      const cpa04 = await tx.request()
        .input('n', sql.Float, registro.ncompInC)
        .query(`SELECT * FROM CPA04 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)
      expect(cpa04.recordset).toHaveLength(1)
      expect(cpa04.recordset[0].COD_PROVEE.trim()).toBe(codProvee)
      expect(Number(cpa04.recordset[0].IMPORTE_NE)).toBe(10000)
      expect(Number(cpa04.recordset[0].IMPORTE_TO)).toBe(12100)
      expect(Number(cpa04.recordset[0].COD_IVA1)).toBe(1) // 21% -> COD_IVA 1

      const cta05 = await tx.request()
        .input('n', sql.Float, registro.ncompInC)
        .query(`SELECT * FROM CTA05 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)
      expect(cta05.recordset).toHaveLength(1)

      const cpa54 = await tx.request()
        .input('t', sql.VarChar(10), registro.tComp)
        .input('n', sql.VarChar(20), registro.nComp)
        .query(`SELECT * FROM CPA54 WHERE T_COMP=@t AND N_COMP=@n`)
      expect(cpa54.recordset.length).toBeGreaterThan(0)

      const auditoria = await tx.request()
        .input('id', sql.Int, id)
        .query(`SELECT ESTADO, TANGO_NCOMP_IN_C FROM PHF_COMPROBANTE WHERE ID=@id`)
      expect(auditoria.recordset[0].ESTADO).toBe('registrado')
      expect(Number(auditoria.recordset[0].TANGO_NCOMP_IN_C)).toBe(registro.ncompInC)
    })
  })

  it('es idempotente: llamarla dos veces devuelve el mismo registro sin duplicar', async () => {
    await conRollback(async (tx) => {
      const prov = await tx.request().query(`
        SELECT TOP 1 COD_PROVEE, N_CUIT FROM CPA01
        WHERE N_CUIT IS NOT NULL AND LEN(REPLACE(REPLACE(N_CUIT,'-',''),' ','')) = 11
        ORDER BY COD_PROVEE`)
      const codProvee = String(prov.recordset[0].COD_PROVEE).trim()

      const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const condCompra = String(condicion.recordset[0].COD_CONDIC)

      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0099')
      await guardarCampoEn(tx, id, 'nro', '00099999')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'codprovee', codProvee)
      await guardarCampoEn(tx, id, 'condcompra', condCompra)
      await guardarCampoEn(tx, id, 'total', '1.000,00')

      const r1 = await registrarComprobanteEn(tx, id)
      const r2 = await registrarComprobanteEn(tx, id)
      expect(r2.ncompInC).toBe(r1.ncompInC)

      const cpa04 = await tx.request()
        .input('n', sql.Float, r1.ncompInC)
        .query(`SELECT COUNT(*) AS c FROM CPA04 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)
      expect(Number(cpa04.recordset[0].c)).toBe(1)
    })
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/tango/comprobantes.test.ts -t registrarComprobanteEn`
Expected: FAIL — `registrarComprobanteEn` no existe

- [ ] **Step 3: Implementar**

Primero, confirmar en `src/server/db/tx.ts` que `conTransaccion` ya acepta un segundo parámetro de nivel de aislamiento (lo hace, ver el archivo — `nivel: sql.IIsolationLevel = sql.ISOLATION_LEVEL.READ_COMMITTED`). No hace falta tocar ese archivo.

Agregar a `src/server/tango/comprobantes.ts`:

```ts
import sql from 'mssql'
import { getPool } from '../db/pool'
import { conTransaccion } from '../db/tx'
import { obtenerDetalleEn, type Detalle } from '@/server/app/detalle'
import { auditarEn } from '@/server/app/detalle'
import { nComp as armarNComp, letraComprobante, parsearFechaArg } from '@/lib/validaciones'
import { parsearImporte } from '@/lib/formato'
import { listarCondicionesCompra } from './condicionesCompra'
import { usuarioActual } from '@/lib/usuario'

export type RegistroTango = { ncompInC: number; tComp: string; nComp: string }

/**
 * Valores constantes de CPA04/CTA05, copiados tal cual de la factura de
 * referencia (NCOMP_IN_C=16591, proveedor 010246), verificados contra la
 * base durante el diseño de esta fase. Son columnas legacy de Tango que no
 * varian entre comprobantes de tipo FAC en esta instalacion -- replicar el
 * patron de la referencia, no interpretar la documentacion de Tango.
 */
const CPA04_CONSTANTES = {
  FILLER: '', BARRA_FON: 0, CAI: '', CITI_OPERA: 'O', CITI_TIPO: 'B', COD_GASTO: '',
  COD_SECTOR: '', COMP_AFIP: 0, CONTABILIZ: false, CONTFISCAL: false, DESPACHO: '',
  ESTADO: 'PEN', ESTADO_AUT: '', ESTADO_STK: 'R', IMPORTE_AN: 0, IMPORTE_BO: 0,
  IMPORTE_FL: 0, IMPORTE_IN: 0, INC_II: false, INC_IVA: false, LOTE: 0,
  N_COMP_FON: '', PORC_BONIF: 0, T_COMP_FON: '', TIPO_ASIEN: '', TIPO_IMPOR: '',
  DIFERENCIA: 'N', EXPORTADO: false, NRO_SUCURS: 0, CCONTROL: '', BO_AUTORIZ: 0,
  DOC_ELECTR: false, INF_IVA: 'S', CAICAE: '', MO_NO_CRED: '', T_DOC_DTE: '',
  N_INT_MES: 0, IVA_CHILE: '', SUCURS_SII: 0, CERRADO: true, COD_CLASIF: '',
  AFECTO_AF: 0, EXENTO_AF: 0, IVA_AF: 0, ACTIVOFIJO: 'N', ID_ASIENTO_MODELO_CP: 1,
  GENERA_ASIENTO: 'S', N_INT_ORI: 0, T_INT_ORI: '',
  RG_3572_TIPO_OPERACION_HABITUAL_COMPRAS: '', RG_3572_CUIT_INTERMEDIARIO: '',
  COD_NO_RECUP: '', BO_TIPO_COMPRA: 0, BO_ES_COMBUSTIBLE: false,
  RG_3572_DENOMINACION_INTERMEDIARIO: '', RG_3685_TIPO_OPERACION_COMPRAS: '0',
  RG_3685_COMPROBANTE_COMPRAS: '001', RG_3685_IVA_COMISION: 0,
  IMPORTE_FLETE_RENGLON: 0, SUBTOTAL_FLETE_RENGLON: 0, ESTADO_UNIDADES: 'PEN',
  OBSERVACIONES: '', OBSERVACIONES_COMERCIALES: '', LEYENDA_1: '', LEYENDA_2: '',
  LEYENDA_3: '', LEYENDA_4: '', LEYENDA_5: '', TALONARIO: 50,
  TIPO_TRANSACCION_VENTA: 0, TIPO_TRANSACCION_COMPRA: 0, MOTIVO_ANULACION_OP: '',
  HORA_ANULACION_OP: '', USUARIO_ANULACION_OP: '', TERMINAL_ANULACION_OP: '',
  NOTAS_OP: '', OP_NETO_GRAVADO_PAGO_CUENTA: 0, OP_NETO_NO_GRAVADO_PAGO_CUENTA: 0,
  OP_IMPORTE_TOTAL_PAGO_CUENTA: 0, OP_IMPORTE_IVA_PAGO_CUENTA: 0,
  OP_IMPORTE_SIN_IVA_PAGO_CUENTA: 0, OP_IMPORTE_NO_CONSIDERA_PAGO_CUENTA: 0,
  OP_TOTAL_PAGO_CUENTA: 0, OP_IMPORTE_TOTAL_RETENCIONES: 0, COD_CPA01: '',
  CONVERSOR_CLAUSULA_DIFERENCIA_ESTADOS: 'N', RETENCION_MODIFICADA: false,
  EXPORTADO_LID_CT: false, NRO_SUCURSAL_DESTINO: 0,
} as const

// Sentinel que usa Tango para "sin fecha" en varias columnas de fecha legacy.
const SIN_FECHA = new Date('1800-01-01T03:53:48.000Z')

function horaActual(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
}

/**
 * Arma las hasta 5 alicuotas (codigo/porcentaje/importe) a partir de los
 * campos porcivaN/impivaN. codpercepiva desambigua el 3% (ver
 * mapearAlicuotaIva). Devuelve solo las posiciones con importe > 0.
 */
async function armarAlicuotas(
  valores: Record<string, string | null | undefined>,
): Promise<{ codigo: number; porcentaje: number; importe: number }[]> {
  const resultado: { codigo: number; porcentaje: number; importe: number }[] = []
  for (let i = 1; i <= 5; i++) {
    const porc = parsearImporte(valores[`porciva${i}`])
    const imp = parsearImporte(valores[`impiva${i}`])
    if (imp <= 0) continue
    const codigoElegido = porc === 3 ? (valores.codpercepiva ?? null) : null
    const mapeado = await mapearAlicuotaIva(porc, codigoElegido)
    if (!mapeado) {
      throw new Error(`No se pudo resolver el código de IVA para la alícuota ${i} (${porc}%).`)
    }
    resultado.push({ codigo: mapeado.codigo, porcentaje: porc, importe: imp })
  }
  return resultado
}

export async function registrarComprobanteEn(tx: sql.Transaction, id: number): Promise<RegistroTango> {
  await tx.request().query(`EXEC sp_getapplock @Resource='PHF_registro_tango', @LockMode='Exclusive'`)

  // 1. Idempotencia.
  const previo = await tx.request().input('id', sql.Int, id).query(`
    SELECT TANGO_NCOMP_IN_C, TANGO_T_COMP, TANGO_N_COMP FROM PHF_COMPROBANTE WHERE ID=@id`)
  if (previo.recordset[0]?.TANGO_NCOMP_IN_C != null) {
    return {
      ncompInC: Number(previo.recordset[0].TANGO_NCOMP_IN_C),
      tComp: String(previo.recordset[0].TANGO_T_COMP).trim(),
      nComp: String(previo.recordset[0].TANGO_N_COMP).trim(),
    }
  }

  const detalle = await obtenerDetalleEn(tx, id)
  const valores: Record<string, string | null | undefined> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const codProvee = (valores.codprovee ?? '').trim()
  const proveedorRow = await tx.request().input('cod', sql.VarChar(6), codProvee).query(`
    SELECT LTRIM(RTRIM(ISNULL(NOM_PROVEE,''))) AS razon, LTRIM(RTRIM(ISNULL(N_CUIT,''))) AS cuit,
           LTRIM(RTRIM(ISNULL(COND_IVA,''))) AS condIva
    FROM CPA01 WHERE COD_PROVEE=@cod`)
  if (proveedorRow.recordset.length === 0) {
    throw new Error(`El proveedor ${codProvee} ya no existe en Tango.`)
  }
  const proveedor = proveedorRow.recordset[0]

  const letra = letraComprobante(valores.tipo ?? '')
  if (!letra) throw new Error('No se pudo determinar la letra del comprobante.')
  const ptovta = (valores.ptovta ?? '').trim()
  const nro = (valores.nro ?? '').trim()
  const nComprobante = armarNComp(letra, ptovta, nro)
  const tComp = 'FAC'

  const codCondCompra = Number(valores.condcompra)
  const condiciones = await listarCondicionesCompra()
  const condicion = condiciones.find((c) => c.codigo === codCondCompra)
  if (!condicion) throw new Error(`La condición de compra ${codCondCompra} no existe en Tango.`)

  const fechaEmision = parsearFechaArg((valores.fecha ?? '').trim()) ?? new Date()
  const neto = parsearImporte(valores.neto)
  const exento = parsearImporte(valores.exento)
  const total = parsearImporte(valores.total)
  const cotizacion = parsearImporte(valores.cotizacion) || 1
  const moneda = (valores.moneda ?? 'ARS').trim().toUpperCase()

  const alicuotas = await armarAlicuotas(valores)
  while (alicuotas.length < 5) alicuotas.push({ codigo: 0, porcentaje: 0, importe: 0 })

  // 2. Numero interno.
  const maxR = await tx.request().query(`SELECT ISNULL(MAX(NCOMP_IN_C),0) AS mx FROM CPA04 WHERE TCOMP_IN_C='FP'`)
  const ncompInC = Number(maxR.recordset[0].mx) + 1

  const horaAhora = horaActual()
  const hoy = new Date()

  // 3. CPA04 + CTA05.
  await tx.request()
    .input('tcompInC', sql.VarChar(10), tComp)
    .input('ncompInC', sql.Float, ncompInC)
    .input('nComp', sql.VarChar(20), nComprobante)
    .input('tipoCompr', sql.VarChar(1), letra)
    .input('codProvee', sql.VarChar(6), codProvee)
    .input('catIva', sql.VarChar(10), proveedor.condIva || 'RI')
    .input('condCompr', sql.SmallInt, codCondCompra)
    .input('cotizacion', sql.Decimal(18, 4), cotizacion)
    .input('fechaEmis', sql.DateTime, fechaEmision)
    .input('importeNe', sql.Decimal(18, 2), neto)
    .input('importeEx', sql.Decimal(18, 2), exento)
    .input('importeTo', sql.Decimal(18, 2), total)
    .input('leyenda', sql.VarChar(60), condicion.descripcion)
    .input('monCte', sql.Bit, moneda === 'ARS')
    .input('codIva1', sql.SmallInt, alicuotas[0].codigo).input('porcIva1', sql.Decimal(9, 4), alicuotas[0].porcentaje).input('impIva1', sql.Decimal(18, 2), alicuotas[0].importe)
    .input('codIva2', sql.SmallInt, alicuotas[1].codigo).input('porcIva2', sql.Decimal(9, 4), alicuotas[1].porcentaje).input('impIva2', sql.Decimal(18, 2), alicuotas[1].importe)
    .input('codIva3', sql.SmallInt, alicuotas[2].codigo).input('porcIva3', sql.Decimal(9, 4), alicuotas[2].porcentaje).input('impIva3', sql.Decimal(18, 2), alicuotas[2].importe)
    .input('codIva4', sql.SmallInt, alicuotas[3].codigo).input('porcIva4', sql.Decimal(9, 4), alicuotas[3].porcentaje).input('impIva4', sql.Decimal(18, 2), alicuotas[3].importe)
    .input('codIva5', sql.SmallInt, alicuotas[4].codigo).input('porcIva5', sql.Decimal(9, 4), alicuotas[4].porcentaje).input('impIva5', sql.Decimal(18, 2), alicuotas[4].importe)
    .input('horaIngreso', sql.VarChar(10), horaAhora)
    .input('hora', sql.VarChar(10), horaAhora)
    .input('usuarioIngreso', sql.VarChar(20), usuarioActual())
    .input('fechaIngreso', sql.DateTime, hoy)
    .input('sinFecha', sql.DateTime, SIN_FECHA)
    .query(`
      INSERT INTO CPA04 (
        TCOMP_IN_C, NCOMP_IN_C, T_COMP, N_COMP, TIPO_COMPR, COD_PROVEE, CAT_IVA,
        COND_COMPR, COTIZACION, FECHA_EMIS, FECHA_CONT, FECHA_VTO, IMPORTE_NE,
        SUBT_GRAVA, IMPORTE_EX, SUBT_EXENT, IMPORTE_TO, LEYENDA, MON_CTE,
        COD_IVA1, PORC_IVA1, IMP_IVA1, COD_IVA2, PORC_IVA2, IMP_IVA2,
        COD_IVA3, PORC_IVA3, IMP_IVA3, COD_IVA4, PORC_IVA4, IMP_IVA4,
        COD_IVA5, PORC_IVA5, IMP_IVA5, UNIDADES,
        HORA, HORA_INGRESO, USUARIO_INGRESO, TERMINAL_INGRESO, FECHA_INGRESO,
        FECHA_ULTIMA_MODIFICACION, HORA_ULTIMA_MODIFICACION, USUA_ULTIMA_MODIFICACION, TERM_ULTIMA_MODIFICACION,
        CAICAE_VTO, FECHA_ANULACION_OP, IMPUTACION_MODIFICADA, ID_LOTE_IMPORTACION_EXCEL,
        FILLER, BARRA_FON, CAI, CITI_OPERA, CITI_TIPO, COD_GASTO, COD_SECTOR, COMP_AFIP,
        CONTABILIZ, CONTFISCAL, DESPACHO, ESTADO, ESTADO_AUT, ESTADO_STK, IMPORTE_AN,
        IMPORTE_BO, IMPORTE_FL, IMPORTE_IN, INC_II, INC_IVA, LOTE, N_COMP_FON,
        PORC_BONIF, T_COMP_FON, TIPO_ASIEN, TIPO_IMPOR, DIFERENCIA, EXPORTADO, NRO_SUCURS,
        CCONTROL, BO_AUTORIZ, DOC_ELECTR, INF_IVA, CAICAE, MO_NO_CRED, T_DOC_DTE,
        N_INT_MES, IVA_CHILE, SUCURS_SII, CERRADO, COD_CLASIF, AFECTO_AF, EXENTO_AF,
        IVA_AF, ACTIVOFIJO, ID_ASIENTO_MODELO_CP, GENERA_ASIENTO, N_INT_ORI, T_INT_ORI,
        RG_3572_TIPO_OPERACION_HABITUAL_COMPRAS, RG_3572_CUIT_INTERMEDIARIO, COD_NO_RECUP,
        BO_TIPO_COMPRA, BO_ES_COMBUSTIBLE, RG_3572_DENOMINACION_INTERMEDIARIO,
        RG_3685_TIPO_OPERACION_COMPRAS, RG_3685_COMPROBANTE_COMPRAS, RG_3685_IVA_COMISION,
        IMPORTE_FLETE_RENGLON, SUBTOTAL_FLETE_RENGLON, ESTADO_UNIDADES, OBSERVACIONES,
        OBSERVACIONES_COMERCIALES, LEYENDA_1, LEYENDA_2, LEYENDA_3, LEYENDA_4, LEYENDA_5,
        TALONARIO, TIPO_TRANSACCION_VENTA, TIPO_TRANSACCION_COMPRA, MOTIVO_ANULACION_OP,
        HORA_ANULACION_OP, USUARIO_ANULACION_OP, TERMINAL_ANULACION_OP, NOTAS_OP,
        OP_NETO_GRAVADO_PAGO_CUENTA, OP_NETO_NO_GRAVADO_PAGO_CUENTA, OP_IMPORTE_TOTAL_PAGO_CUENTA,
        OP_IMPORTE_IVA_PAGO_CUENTA, OP_IMPORTE_SIN_IVA_PAGO_CUENTA, OP_IMPORTE_NO_CONSIDERA_PAGO_CUENTA,
        OP_TOTAL_PAGO_CUENTA, OP_IMPORTE_TOTAL_RETENCIONES, COD_CPA01,
        CONVERSOR_CLAUSULA_DIFERENCIA_ESTADOS, RETENCION_MODIFICADA, EXPORTADO_LID_CT, NRO_SUCURSAL_DESTINO
      ) VALUES (
        @tcompInC, @ncompInC, 'FAC', @nComp, @tipoCompr, @codProvee, @catIva,
        @condCompr, @cotizacion, @fechaEmis, @fechaEmis, @sinFecha, @importeNe,
        @importeNe, @importeEx, @importeEx, @importeTo, @leyenda, @monCte,
        @codIva1, @porcIva1, @impIva1, @codIva2, @porcIva2, @impIva2,
        @codIva3, @porcIva3, @impIva3, @codIva4, @porcIva4, @impIva4,
        @codIva5, @porcIva5, @impIva5, @importeTo,
        @hora, @horaIngreso, @usuarioIngreso, 'PHF-WEB', @fechaIngreso,
        @sinFecha, '', '', '',
        @sinFecha, @sinFecha, NULL, NULL,
        '', 0, '', 'O', 'B', '', '', 0,
        0, 0, '', 'PEN', '', 'R', 0,
        0, 0, 0, 0, 0, 0, '',
        0, '', '', '', 'N', 0, 0,
        '', 0, 0, 'S', '', '', '',
        0, '', 0, 1, '', 0, 0,
        0, 'N', 1, 'S', 0, '',
        '', '', '',
        0, 0, '',
        '0', '001', 0,
        0, 0, 'PEN', '',
        '', '', '', '', '', '',
        50, 0, 0, '',
        '', '', '', '',
        0, 0, 0,
        0, 0, 0,
        0, 0, '',
        'N', 0, 0, 0
      )`)

  await tx.request()
    .input('tcompInC', sql.VarChar(10), tComp)
    .input('ncompInC', sql.Float, ncompInC)
    .input('nComp', sql.VarChar(20), nComprobante)
    .input('codProvee', sql.VarChar(6), codProvee)
    .input('cuitPro', sql.VarChar(20), proveedor.cuit)
    .input('nombrePro', sql.VarChar(60), proveedor.razon)
    .input('condPro', sql.VarChar(10), proveedor.condIva || 'RI')
    .input('catIva', sql.VarChar(10), proveedor.condIva || 'RI')
    .input('condCompr', sql.SmallInt, codCondCompra)
    .input('cotizacion', sql.Decimal(18, 4), cotizacion)
    .input('fechaEmis', sql.DateTime, fechaEmision)
    .input('importeNe', sql.Decimal(18, 2), neto)
    .input('importeEx', sql.Decimal(18, 2), exento)
    .input('importeTo', sql.Decimal(18, 2), total)
    .input('leyenda', sql.VarChar(60), condicion.descripcion)
    .input('monCte', sql.Bit, moneda === 'ARS')
    .input('impIva1', sql.Decimal(18, 2), alicuotas[0].importe).input('porcIva1', sql.Decimal(9, 4), alicuotas[0].porcentaje).input('codIva1', sql.SmallInt, alicuotas[0].codigo)
    .input('impIva2', sql.Decimal(18, 2), alicuotas[1].importe).input('porcIva2', sql.Decimal(9, 4), alicuotas[1].porcentaje).input('codIva2', sql.SmallInt, alicuotas[1].codigo)
    .input('impIva3', sql.Decimal(18, 2), alicuotas[2].importe).input('porcIva3', sql.Decimal(9, 4), alicuotas[2].porcentaje).input('codIva3', sql.SmallInt, alicuotas[2].codigo)
    .input('impIva4', sql.Decimal(18, 2), alicuotas[3].importe).input('porcIva4', sql.Decimal(9, 4), alicuotas[3].porcentaje).input('codIva4', sql.SmallInt, alicuotas[3].codigo)
    .input('impIva5', sql.Decimal(18, 2), alicuotas[4].importe).input('porcIva5', sql.Decimal(9, 4), alicuotas[4].porcentaje).input('codIva5', sql.SmallInt, alicuotas[4].codigo)
    .input('sinFecha', sql.DateTime, SIN_FECHA)
    .query(`
      INSERT INTO CTA05 (
        TCOMP_IN_C, NCOMP_IN_C, T_COMP, N_COMP, COD_PROVEE, CUIT_PRO, NOMBRE_PRO,
        COND_PRO, CAT_IVA, COND_COMPR, COTIZACION, FECHA_EMIS, FECHA_CONT, FECHA_VTO,
        IMP_NETO, SUBT_GRAVA, IMPORTE_EX, SUBT_EXENT, IMPORTE_TO, LEYENDA, MON_CTE,
        IMPOR_IVA1, PORC_IVA1, COD_IVA1, IMPOR_IVA2, PORC_IVA2, COD_IVA2,
        IMPOR_IVA3, PORC_IVA3, COD_IVA3, IMPOR_IVA4, PORC_IVA4, COD_IVA4,
        IMPOR_IVA5, PORC_IVA5, COD_IVA5, UNIDADES, NRO_SUCURS,
        FILLER, APLICA_PER, CAI, COD_GASTO, COMP_AFIP, CONTFISCAL, DESPACHO,
        ESTADO, ESTADO_AUT, FECHA_IMPO, HORA_IMPO, IMPORTE_AN, IMPORTE_BO,
        IMPORTE_FL, IMPORTE_IN, INC_II, INC_IVA, INGB_PRO, LOTE, T_FORM,
        TIPO_ASIEN, TIPO_IMPOR, CCONTROL, BO_AUTORIZ, DOC_ELECTR, INF_IVA,
        IVA_CHILE, T_DOC_DTE, SUCURS_SII, N_INT_MES, COD_CLASIF, AFECTO_AF,
        EXENTO_AF, IVA_AF, ACTIVOFIJO, ID_ASIENTO_MODELO_CP,
        RG_3572_TIPO_OPERACION_HABITUAL_COMPRAS, RG_3572_DENOMINACION_INTERMEDIARIO,
        RG_3685_IVA_COMISION, RG_3685_TIPO_OPERACION_COMPRAS, RG_3685_COMPROBANTE_COMPRAS,
        RG_3572_CUIT_INTERMEDIARIO, RG_3685_GENERA_INFORMACION_PROV_HABITUAL,
        RG_3685_GENERA_INFORMACION_PROV_OCASIONAL, COD_NO_RECUP, ESTADO_UNIDADES,
        TIPO_TRANSACCION_COMPRA, DOC_PRO
      ) VALUES (
        @tcompInC, @ncompInC, 'FAC', @nComp, @codProvee, @cuitPro, @nombrePro,
        @condPro, @catIva, @condCompr, @cotizacion, @fechaEmis, @fechaEmis, @sinFecha,
        @importeNe, @importeNe, @importeEx, @importeEx, @importeTo, @leyenda, @monCte,
        @impIva1, @porcIva1, @codIva1, @impIva2, @porcIva2, @codIva2,
        @impIva3, @porcIva3, @codIva3, @impIva4, @porcIva4, @codIva4,
        @impIva5, @porcIva5, @codIva5, @importeTo, 1001,
        '', 1, '', '', 0, 0, '',
        'PEN', '', @fechaEmis, '0000', 0, 0,
        0, 0, 0, 0, '', 0, '',
        '', '', '', 0, 0, 'S',
        '', '', 0, 0, '', 0,
        0, 0, 'N', 1,
        NULL, '',
        0, '0', '001',
        '', 1,
        NULL, '', 'PEN',
        0, 80
      )`)

  // 4. CPA18 + CTA06 (percepciones).
  const percepciones: { codigo: string; importe: number }[] = []
  const impIibb = parsearImporte(valores.perciibb)
  if (impIibb > 0) percepciones.push({ codigo: (valores.codpercibb ?? '').trim(), importe: impIibb })
  const impInt = parsearImporte(valores.impint)
  if (impInt > 0) percepciones.push({ codigo: '40', importe: impInt })

  for (const p of percepciones) {
    await tx.request()
      .input('tcompInC', sql.VarChar(10), tComp).input('ncompInC', sql.Float, ncompInC)
      .input('codImpues', sql.VarChar(10), p.codigo).input('codProvee', sql.VarChar(6), codProvee)
      .input('fComp', sql.DateTime, fechaEmision).input('importe', sql.Decimal(18, 2), p.importe)
      .query(`
        INSERT INTO CPA18 (TCOMP_IN_C, NCOMP_IN_C, COD_IMPUES, COD_PROVEE, COD_PROV, F_COMP, IMPORTE, FILLER, COD_SII)
        VALUES (@tcompInC, @ncompInC, @codImpues, @codProvee, '', @fComp, @importe, '', '')`)

    await tx.request()
      .input('tcompInC', sql.VarChar(10), tComp).input('ncompInC', sql.Float, ncompInC)
      .input('codImpues', sql.SmallInt, Number(p.codigo)).input('codProvee', sql.VarChar(6), codProvee)
      .input('fechaCont', sql.DateTime, fechaEmision).input('importe', sql.Decimal(18, 2), p.importe)
      .query(`
        INSERT INTO CTA06 (TCOMP_IN_C, NCOMP_IN_C, COD_IMPUES, COD_PROVEE, FECHA_CONT, IMPORTE, NRO_SUCURS, FILLER, COD_SII)
        VALUES (@tcompInC, @ncompInC, @codImpues, @codProvee, @fechaCont, @importe, 1001, '', '')`)
  }

  // 5. CPA63 + clasificacion IVA (una fila por alicuota con importe, clasificacion SIN = sin categoria especial).
  for (const a of alicuotas.filter((x) => x.importe > 0)) {
    await tx.request()
      .input('tcompInC', sql.VarChar(10), tComp).input('ncompInC', sql.Float, ncompInC)
      .input('importe', sql.Decimal(18, 2), a.importe).input('porcAlicu', sql.Decimal(9, 4), a.porcentaje)
      .query(`
        INSERT INTO CPA63 (TCOMP_IN_C, NCOMP_IN_C, CLAS_SIAP, IMPORTE, PORC_ALICU, FILLER)
        VALUES (@tcompInC, @ncompInC, 'SIN', @importe, @porcAlicu, '')`)

    await tx.request()
      .input('tcompInC', sql.VarChar(10), tComp).input('ncompInC', sql.Float, ncompInC)
      .input('importe', sql.Decimal(18, 2), a.importe).input('porcAlicu', sql.Decimal(9, 4), a.porcentaje)
      .query(`
        INSERT INTO CTA_COMPROBANTE_COMPRAS_CLASIFICACION_IVA (ID_SUCURSAL, TCOMP_IN_C, NCOMP_IN_C, CLAS_SIAP, IMPORTE, PORC_ALICU)
        VALUES (1, @tcompInC, @ncompInC, 'SIN', @importe, @porcAlicu)`)
  }

  // 6. CPA54 (vencimientos), uno por cuota de la condicion de compra.
  const cuotas = await tx.request().input('cod', sql.SmallInt, codCondCompra).query(`
    SELECT A_VENCER, PORC_MONTO FROM CPA49 WHERE COD_CONDIC=@cod ORDER BY N_RENGLON`)
  const filasVto = cuotas.recordset.length > 0 ? cuotas.recordset : [{ A_VENCER: 0, PORC_MONTO: 100 }]
  for (const c of filasVto) {
    const fechaVto = new Date(fechaEmision)
    fechaVto.setDate(fechaVto.getDate() + Number(c.A_VENCER))
    const importeVto = Math.round(total * (Number(c.PORC_MONTO) / 100) * 100) / 100

    await tx.request()
      .input('codProvee', sql.VarChar(6), codProvee).input('fechaVto', sql.DateTime, fechaVto)
      .input('importeVto', sql.Decimal(18, 2), importeVto).input('nComp', sql.VarChar(20), nComprobante)
      .input('tComp', sql.VarChar(10), tComp)
      .query(`
        INSERT INTO CPA54 (COD_PROVEE, ESTADO_AUT, ESTADO_VTO, FECHA_VTO, IMPORT_VTO, N_COMP, T_COMP, ESTADO_UNIDADES, IMPORTE_VENCIMIENTO_UNIDADES, FILLER)
        VALUES (@codProvee, '', 'PEN', @fechaVto, @importeVto, @nComp, @tComp, 'PEN', @importeVto, '')`)
  }

  // 7. CONTABILIZ=0 ya quedo en CPA04_CONSTANTES. No se escribe ASIENTO_COMPROBANTE_CP.

  // 8. Actualizar PHF_COMPROBANTE + auditoria.
  await tx.request()
    .input('id', sql.Int, id).input('ncompInC', sql.Float, ncompInC)
    .input('tComp', sql.VarChar(10), tComp).input('nComp', sql.VarChar(20), nComprobante)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO='registrado', TANGO_NCOMP_IN_C=@ncompInC, TANGO_T_COMP=@tComp, TANGO_N_COMP=@nComp,
          FECHA_REGISTRO=SYSDATETIME(), FECHA_MODIF=SYSDATETIME()
      WHERE ID=@id`)
  await auditarEn(tx, id, `Registrado en Tango: ${tComp} ${nComprobante}`)

  return { ncompInC, tComp, nComp: nComprobante }
}

export async function registrarComprobante(id: number): Promise<RegistroTango> {
  return conTransaccion((tx) => registrarComprobanteEn(tx, id), sql.ISOLATION_LEVEL.SERIALIZABLE)
}
```

**Nota importante para el implementer:** la columna `CPA04.UNIDADES` no tiene una fórmula confirmada — en la muestra verificada durante el diseño, es consistentemente `IMPORTE_TO × ~1.03093` en varias facturas reales, pero ese coeficiente huele a un índice que Tango recalcula por su cuenta (posiblemente ligado a una tabla de ajuste que no se investigó). Este plan usa `IMPORTE_TO` tal cual como aproximación conservadora (evita inventar un coeficiente sin entender su origen). Si al correr el test de integración algo relacionado con `UNIDADES` falla o genera un estado inconsistente en Tango, investigar esa columna específicamente antes de forzar un valor — no adivinar el coeficiente.

`sp_getapplock` no se puede invocar vía `.input()` como el resto de las queries porque es un `EXEC` con parámetros con nombre fijos de sistema — el `@Resource`/`@LockMode` de arriba son literales de T-SQL, no bindings de `mssql`; están bien así, no hace falta parametrizarlos porque no incluyen ningún valor de usuario.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/tango/comprobantes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/tango/comprobantes.ts tests/server/tango/comprobantes.test.ts
git commit -m "$(cat <<'EOF'
Implementar el registro en Tango: cabecera, percepciones, IVA y vencimientos

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `registrarComprobanteEn` — extensión para remitos

**Files:**
- Modify: `src/server/app/detalle.ts`
- Modify: `src/server/app/comprobantes.ts`
- Modify: `src/server/tango/comprobantes.ts`
- Test: `tests/server/app/detalle.test.ts`
- Test: `tests/server/tango/comprobantes.test.ts`

**Interfaces:**
- Consumes: `registrarComprobanteEn` (Task 6).
- Produces:
  - `RenglonGuardado` extendido con `id: number`, `remitoNcompInS: string | null`, `remitoNRenglS: number | null`.
  - `insertarRenglonPrueba(e: Ejecutor, comprobanteId: number, datos: { codigo: string; descripcion: string; cantidad: string; precioUnitario: string; importe: string }): Promise<number>` (helper de test en `src/server/app/comprobantes.ts`).
  - El mismo `registrarComprobanteEn` de Task 6, extendido — no cambia su firma.

**Importante:** hoy `obtenerDetalleEn` (`src/server/app/detalle.ts`) **no** selecciona `ID`, `REMITO_NCOMP_IN_S` ni `REMITO_N_RENGL_S` de `PHF_RENGLON` — esas columnas existen desde Fase 1 pero nunca se leyeron (verificado leyendo el archivo real durante el diseño de esta fase). El primer paso de esta task es agregarlas.

- [ ] **Step 1: Escribir el test que falla — extender `obtenerDetalleEn`**

```ts
// Agregar a tests/server/app/detalle.test.ts (si el archivo no existe, crearlo con
// este describe solo; si ya existe, agregar el describe al final)
import { conRollback } from '@/server/db/tx'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { obtenerDetalleEn } from '@/server/app/detalle'
import sql from 'mssql'

describe('obtenerDetalleEn — renglones con remito', () => {
  it('expone id y el link a remito de cada renglon', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const r = await tx.request()
        .input('cid', sql.Int, id).input('orden', sql.Int, 1)
        .query(`
          INSERT INTO PHF_RENGLON (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA, PRECIO_UNITARIO_IA, IMPORTE_IA)
          OUTPUT INSERTED.ID
          VALUES (@cid, @orden, '106817', 'Articulo', 4, 80745.57, 322982.28)`)
      const renglonId = Number(r.recordset[0].ID)

      await tx.request()
        .input('id', sql.Int, renglonId).input('n', sql.VarChar(8), '00003805').input('nr', sql.Int, 1)
        .query(`UPDATE PHF_RENGLON SET REMITO_NCOMP_IN_S=@n, REMITO_N_RENGL_S=@nr WHERE ID=@id`)

      const detalle = await obtenerDetalleEn(tx, id)
      expect(detalle.renglones).toHaveLength(1)
      expect(detalle.renglones[0].id).toBe(renglonId)
      expect(detalle.renglones[0].remitoNcompInS?.trim()).toBe('00003805')
      expect(detalle.renglones[0].remitoNRenglS).toBe(1)
    })
  })

  it('renglon sin remito asignado expone null en ambos campos', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await tx.request()
        .input('cid', sql.Int, id).input('orden', sql.Int, 1)
        .query(`
          INSERT INTO PHF_RENGLON (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA)
          VALUES (@cid, @orden, '1', 'Sin remito')`)

      const detalle = await obtenerDetalleEn(tx, id)
      expect(detalle.renglones[0].remitoNcompInS).toBeNull()
      expect(detalle.renglones[0].remitoNRenglS).toBeNull()
    })
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/app/detalle.test.ts -t "renglones con remito"`
Expected: FAIL — `detalle.renglones[0].id`/`remitoNcompInS`/`remitoNRenglS` son `undefined`

- [ ] **Step 3: Implementar la extensión de `obtenerDetalleEn`**

En `src/server/app/detalle.ts`:

```ts
// Cambiar:
export type RenglonGuardado = RenglonExtraido & { orden: number }
// por:
export type RenglonGuardado = RenglonExtraido & {
  id: number
  orden: number
  remitoNcompInS: string | null
  remitoNRenglS: number | null
}
```

En la query de `obtenerDetalleEn`, cambiar:

```sql
SELECT ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA,
       PRECIO_UNITARIO_IA, IMPORTE_IA
FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id ORDER BY ORDEN;
```

por:

```sql
SELECT ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA,
       PRECIO_UNITARIO_IA, IMPORTE_IA, REMITO_NCOMP_IN_S, REMITO_N_RENGL_S
FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id ORDER BY ORDEN;
```

Y en el `.map()` que arma `renglones`, agregar los tres campos nuevos (mismo bloque que ya mapea `orden`/`codigo`/`descripcion`/etc., leer el archivo real para insertar en el lugar exacto):

```ts
      id: Number(x.ID),
      remitoNcompInS: x.REMITO_NCOMP_IN_S === null ? null : String(x.REMITO_NCOMP_IN_S),
      remitoNRenglS: x.REMITO_N_RENGL_S === null ? null : Number(x.REMITO_N_RENGL_S),
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/app/detalle.test.ts`
Expected: PASS

- [ ] **Step 5: Agregar el helper de test `insertarRenglonPrueba`**

A `src/server/app/comprobantes.ts` (mismo patrón que `insertarComprobantePrueba`, ya existente ahí):

```ts
export async function insertarRenglonPrueba(
  e: Ejecutor,
  comprobanteId: number,
  datos: { codigo: string; descripcion: string; cantidad: string; precioUnitario: string; importe: string },
): Promise<number> {
  const r = await e.request()
    .input('cid', sql.Int, comprobanteId).input('orden', sql.Int, 1)
    .input('cod', sql.VarChar(60), datos.codigo).input('desc', sql.NVarChar(300), datos.descripcion)
    .input('cant', sql.VarChar(30), datos.cantidad).input('precio', sql.VarChar(30), datos.precioUnitario)
    .input('imp', sql.VarChar(30), datos.importe)
    .query(`
      INSERT INTO PHF_RENGLON (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA, PRECIO_UNITARIO_IA, IMPORTE_IA)
      OUTPUT INSERTED.ID
      VALUES (@cid, @orden, @cod, @desc, @cant, @precio, @imp)`)
  return Number(r.recordset[0].ID)
}
```

- [ ] **Step 6: Escribir el test que falla — `registrarComprobanteEn` con remito**

```ts
// Agregar a tests/server/tango/comprobantes.test.ts
import { insertarRenglonPrueba } from '@/server/app/comprobantes'

describe('registrarComprobanteEn con remito asignado', () => {
  it('copia el renglon del remito a CPA46 y actualiza STA20/STA14', async () => {
    await conRollback(async (tx) => {
      // Un remito pendiente real, descubierto en runtime.
      const remito = await tx.request().query(`
        SELECT TOP 1 h.NCOMP_IN_S, h.COD_PRO_CL, r.N_RENGL_S, r.COD_ARTICU, r.COD_DEPOSI,
               r.CANT_PEND, r.PRECIO_REM
        FROM STA14 h JOIN STA20 r ON r.TCOMP_IN_S=h.TCOMP_IN_S AND r.NCOMP_IN_S=h.NCOMP_IN_S
        WHERE h.TCOMP_IN_S='RP' AND h.ESTADO_MOV='P' AND r.CANT_PEND > 0`)
      const codProvee = String(remito.recordset[0].COD_PRO_CL).trim()
      const ncompInS = String(remito.recordset[0].NCOMP_IN_S).trim()
      const nRenglS = Number(remito.recordset[0].N_RENGL_S)
      const cantPendAntes = Number(remito.recordset[0].CANT_PEND)

      const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const condCompra = String(condicion.recordset[0].COD_CONDIC)

      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0088')
      await guardarCampoEn(tx, id, 'nro', '00054321')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'codprovee', codProvee)
      await guardarCampoEn(tx, id, 'condcompra', condCompra)
      await guardarCampoEn(tx, id, 'total', '1.000,00')
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: '', descripcion: '', cantidad: '1', precioUnitario: '1000', importe: '1000',
      })
      // asignarRemitoEn llega en la Task 9 (server/app/acciones.ts, escribe una tabla
      // propia). Para no crear una dependencia entre tasks, este test escribe el link
      // directo -- lo unico que valida esta task es que registrarComprobanteEn lo lea
      // y lo procese bien, no como se escribio.
      await tx.request()
        .input('id', sql.Int, renglonId).input('n', sql.VarChar(8), ncompInS).input('r', sql.Int, nRenglS)
        .query(`UPDATE PHF_RENGLON SET REMITO_NCOMP_IN_S=@n, REMITO_N_RENGL_S=@r WHERE ID=@id`)

      const registro = await registrarComprobanteEn(tx, id)

      const cpa46 = await tx.request()
        .input('t', sql.VarChar(10), registro.tComp).input('n', sql.Float, registro.ncompInC)
        .query(`SELECT * FROM CPA46 WHERE TCOMP_IN_C=@t AND NCOMP_IN_C=@n`)
      expect(cpa46.recordset).toHaveLength(1)
      expect(cpa46.recordset[0].COD_ARTICU.trim()).toBe(String(remito.recordset[0].COD_ARTICU).trim())

      const cpa48 = await tx.request()
        .input('t', sql.VarChar(10), registro.tComp).input('n', sql.Float, registro.ncompInC)
        .query(`SELECT * FROM CPA48 WHERE TCOMP_IN_C=@t AND LTRIM(RTRIM(NCOMP_IN_C))=CAST(@n AS VARCHAR)`)
      expect(cpa48.recordset).toHaveLength(1)

      const sta20 = await tx.request()
        .input('n', sql.VarChar(8), ncompInS).input('r', sql.Int, nRenglS)
        .query(`SELECT CANT_FACTU, CANT_PEND FROM STA20 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n AND N_RENGL_S=@r`)
      expect(Number(sta20.recordset[0].CANT_PEND)).toBe(cantPendAntes - 1)
    })
  })
})
```

- [ ] **Step 7: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/tango/comprobantes.test.ts -t "remito asignado"`
Expected: FAIL — `registrarComprobanteEn` todavía no procesa renglones con remito

- [ ] **Step 8: Implementar**

En `src/server/tango/comprobantes.ts`, agregar el procesamiento de renglones **antes** del `UPDATE PHF_COMPROBANTE` final de `registrarComprobanteEn` (después del bloque de `CPA54`, sección "6" del código de Task 6):

```ts
  // 7. Renglones con remito asignado (solo si hay).
  const renglonesConRemito = detalle.renglones.filter((r) => r.remitoNcompInS && r.remitoNRenglS)
  const remitosAfectados = new Set<string>()

  for (const renglon of renglonesConRemito) {
    const remitoNcompInS = renglon.remitoNcompInS!
    const remitoNRenglS = renglon.remitoNRenglS!

    const staRow = await tx.request()
      .input('n', sql.VarChar(8), remitoNcompInS).input('r', sql.Int, remitoNRenglS)
      .query(`
        SELECT r.COD_ARTICU, r.COD_DEPOSI, r.CANTIDAD, r.CANT_FACTU, r.CANT_PEND, r.PRECIO_REM, h.NRO_SUCURS
        FROM STA20 r JOIN STA14 h ON h.TCOMP_IN_S=r.TCOMP_IN_S AND h.NCOMP_IN_S=r.NCOMP_IN_S
        WHERE r.TCOMP_IN_S='RP' AND r.NCOMP_IN_S=@n AND r.N_RENGL_S=@r`)
    if (staRow.recordset.length === 0) {
      throw new Error(`El renglón ${remitoNRenglS} del remito ${remitoNcompInS} ya no existe.`)
    }
    const sta = staRow.recordset[0]
    const cantidad = Number(sta.CANTIDAD)
    const codArticu = String(sta.COD_ARTICU).trim()
    const codDeposi = String(sta.COD_DEPOSI ?? '').trim()
    const precio = Number(sta.PRECIO_REM)
    const importeNetoRenglon = Math.round(cantidad * precio * 100) / 100

    const nRenglC = renglonesConRemito.indexOf(renglon) + 1

    await tx.request()
      .input('tcompInC', sql.VarChar(10), tComp).input('ncompInC', sql.Float, ncompInC)
      .input('nRenglC', sql.Int, nRenglC).input('codArticu', sql.VarChar(20), codArticu)
      .input('codDeposi', sql.VarChar(10), codDeposi).input('cantidad', sql.Decimal(18, 4), cantidad)
      .input('precioNet', sql.Decimal(18, 4), precio).input('impNetoP', sql.Decimal(18, 2), importeNetoRenglon)
      .input('fechaMov', sql.DateTime, fechaEmision).input('idSta11', sql.Int, null)
      .query(`
        INSERT INTO CPA46 (
          TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, COD_ARTICU, COD_DEPOSI, CANTIDAD,
          PRECIO_NET, PRECIO_PAN, IMP_NETO_P, FECHA_MOV, EQUIVALENC, FALTA_REM,
          PORCE_DCTO, FILLER, COD_CLASIF, IMPORTE_EXENTO, IMPORTE_GRAVADO,
          CANTIDAD_2, FALTA_REM_2, UNIDAD_MEDIDA_SELECCIONADA, IMPORTE_FLETE,
          IMPORTE_IMPUESTOS_COSTOS, ID_STA11
        ) VALUES (
          @tcompInC, @ncompInC, @nRenglC, @codArticu, @codDeposi, @cantidad,
          @precioNet, @precioNet, @impNetoP, @fechaMov, 1, 0,
          0, '', '', 0, @impNetoP,
          0, 0, 'P', 0,
          0, NULL
        )`)

    await tx.request()
      .input('tcompInC', sql.VarChar(10), tComp).input('ncompInC', sql.Float, ncompInC)
      .input('nRenglC', sql.Int, nRenglC).input('codArticu', sql.VarChar(20), codArticu)
      .input('codDeposi', sql.VarChar(10), codDeposi).input('cantidad', sql.Decimal(18, 4), cantidad)
      .input('precioNet', sql.Decimal(18, 4), precio).input('impNetoP', sql.Decimal(18, 2), importeNetoRenglon)
      .input('fechaMov', sql.DateTime, fechaEmision).input('nroSucurs', sql.SmallInt, Number(sta.NRO_SUCURS) || 1001)
      .query(`
        INSERT INTO CTA07 (
          TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, COD_ARTICU, COD_DEPOSI, CANTIDAD,
          PRECIO_NET, PRECIO_PAN, IMP_NETO_P, FECHA_MOV, EQUIVALENC, NRO_SUCURS,
          PORC_DTO, FILLER, COD_CLASIF, CANTIDAD_2, UNIDAD_MEDIDA_SELECCIONADA
        ) VALUES (
          @tcompInC, @ncompInC, @nRenglC, @codArticu, @codDeposi, @cantidad,
          @precioNet, @precioNet, @impNetoP, @fechaMov, 1, @nroSucurs,
          0, '', '', 0, 'P'
        )`)

    await tx.request()
      .input('tcompInC', sql.VarChar(10), tComp).input('ncompInC', sql.Float, ncompInC)
      .input('nRenglC', sql.Int, nRenglC).input('nRenglS', sql.Int, remitoNRenglS)
      .input('ncompInS', sql.VarChar(8), remitoNcompInS).input('cantidad', sql.Decimal(18, 4), cantidad)
      .query(`
        INSERT INTO CPA48 (TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, N_RENGL_S, NCOMP_IN_S, TCOMP_IN_S, CANTIDAD, FILLER, CANTIDAD_2)
        VALUES (@tcompInC, @ncompInC, @nRenglC, @nRenglS, @ncompInS, 'RP', @cantidad, '', 0)`)

    const nuevoPend = Math.max(0, Number(sta.CANT_PEND) - cantidad)
    await tx.request()
      .input('n', sql.VarChar(8), remitoNcompInS).input('r', sql.Int, remitoNRenglS)
      .input('cantFactu', sql.Decimal(18, 4), Number(sta.CANT_FACTU) + cantidad)
      .input('cantPend', sql.Decimal(18, 4), nuevoPend)
      .query(`UPDATE STA20 SET CANT_FACTU=@cantFactu, CANT_PEND=@cantPend WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n AND N_RENGL_S=@r`)

    remitosAfectados.add(remitoNcompInS)
  }

  for (const ncompInS of remitosAfectados) {
    const pendiente = await tx.request().input('n', sql.VarChar(8), ncompInS).query(`
      SELECT SUM(CANT_PEND) AS pend FROM STA20 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
    if (Number(pendiente.recordset[0].pend) <= 0) {
      await tx.request().input('n', sql.VarChar(8), ncompInS).query(`
        UPDATE STA14 SET ESTADO_MOV='F' WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
    }
  }
```

Esta sección de código usa `renglon.remitoNcompInS`/`renglon.remitoNRenglS` y `tComp`/`ncompInC`/`fechaEmision` — estas últimas tres ya están en scope porque esta sección se agrega dentro del cuerpo de `registrarComprobanteEn`, después del bloque de `CPA54` de la Task 6, reusando las mismas variables locales que ese bloque ya calculó.

- [ ] **Step 9: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/tango/comprobantes.test.ts tests/server/app/detalle.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/server/app/detalle.ts src/server/app/comprobantes.ts src/server/tango/comprobantes.ts \
  tests/server/app/detalle.test.ts tests/server/tango/comprobantes.test.ts
git commit -m "$(cat <<'EOF'
Extender el registro en Tango con renglones asociados a remito

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Server action, botón "Registrar en Tango" e indicador de conexión

**Files:**
- Modify: `src/server/app/acciones.ts`
- Modify: `src/components/revision/barra-acciones.tsx`
- Modify: `src/app/comprobantes/[id]/page.tsx`
- Test: `tests/server/app/acciones.test.ts`

**Interfaces:**
- Consumes: `registrarComprobante` (`@/server/tango/comprobantes`, Task 6/7), `probarConexion` (`@/server/db/pool`, ya existe — usado por `header-global.tsx`).
- Produces: `registrarComprobante(id: number): Promise<void>` en `acciones.ts` (wrapper de server action — nombre igual al de `src/server/tango/`, pero en capas distintas; el de `acciones.ts` no devuelve el detalle, solo confirma que terminó, y revalida la ruta).

- [ ] **Step 1: Escribir el test que falla**

```ts
// Agregar a tests/server/app/acciones.test.ts
import { registrarComprobante as registrarComprobanteAccion } from '@/server/app/acciones'

describe('registrarComprobante (server action)', () => {
  it('rechaza si el comprobante no esta confirmado', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await expect(registrarComprobanteAccion(id)).rejects.toThrow()
    })
  })
})
```

**Nota:** este test usa el pool real (no `conRollback` para la propia llamada, porque `registrarComprobanteAccion` internamente abre su propia transacción sobre el pool) — el `conRollback` de afuera solo sirve para insertar el comprobante de prueba sin dejar rastro; pero como `registrarComprobanteAccion` usa el pool real, no ve esa fila (transacciones separadas, `READ_COMMITTED_SNAPSHOT` como ya documentó Fase 3). Para este test puntual, insertar el comprobante fuera de cualquier transacción, usando el pool real, y borrarlo a mano al final:

```ts
describe('registrarComprobante (server action)', () => {
  it('rechaza si el comprobante no esta confirmado', async () => {
    const pool = await getPool()
    const id = await insertarComprobantePrueba(pool as unknown as Ejecutor, { estado: 'leido' })
    try {
      await expect(registrarComprobanteAccion(id)).rejects.toThrow()
    } finally {
      await pool.request().input('id', sql.Int, id).query('DELETE FROM PHF_COMPROBANTE WHERE ID=@id')
    }
  })
})
```

(Usar el tipo `Ejecutor` ya importado en el archivo de test si existe, o `{ request: () => sql.Request }` inline.)

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/server/app/acciones.test.ts -t "registrarComprobante (server action)"`
Expected: FAIL — `registrarComprobante` no está exportado desde `acciones.ts`

- [ ] **Step 3: Implementar**

Agregar a `src/server/app/acciones.ts`:

```ts
import { registrarComprobante as registrarComprobanteTango } from '@/server/tango/comprobantes'

export async function registrarComprobante(id: number): Promise<void> {
  const pool = await getPool()
  const fila = await pool.request().input('id', sql.Int, id).query(`SELECT ESTADO FROM PHF_COMPROBANTE WHERE ID=@id`)
  if (fila.recordset.length === 0) throw new Error('El comprobante no existe.')
  if (fila.recordset[0].ESTADO !== 'confirmado') {
    throw new Error('Solo se puede registrar un comprobante confirmado.')
  }

  await registrarComprobanteTango(id)

  revalidatePath('/comprobantes')
  revalidatePath(`/comprobantes/${id}`)
}
```

Ahora habilitar el botón en `src/components/revision/barra-acciones.tsx`. Leer primero el archivo completo (quedó consolidado en la Task 9 de Fase 3) para no romper `useAtajos`/el resto del componente. Cambios puntuales:

1. `BotonPrimario` gana una rama para `estado === 'confirmado'`, reemplazando el bloque actual que devuelve el botón deshabilitado "Registrar en Tango":

```tsx
  if (estado === 'confirmado') {
    return (
      <button
        type="button"
        className={styles.registrar}
        disabled={pendiente || sinConexion || bloqueanteRegistro}
        title={
          sinConexion
            ? 'Sin conexión a Tango'
            : bloqueanteRegistro
              ? 'Resolvé los ítems del panel "Listo para registrar" antes de continuar'
              : undefined
        }
        onClick={onClick}
      >
        {pendiente ? 'Registrando…' : 'Registrar en Tango'}
      </button>
    )
  }
```

2. La rama `estado === 'registrado'` (el botón "Ver asiento en Tango") queda sin funcionalidad en esta fase, tal cual estaba — pero su `title="Llega en la Fase 4"` pasa a ser falso apenas esta fase se mergea (ya no "llega", quedó deliberadamente afuera). Cambiarlo a `title="Sin funcionalidad todavía"` para no dejar un tooltip mentiroso.

3. `BotonPrimario` y `BarraAcciones` ganan las props `sinConexion: boolean` y `bloqueanteRegistro: boolean`.

4. `BarraAcciones` gana una función `registrar()` análoga a `confirmar()` (mismo patrón: `useTransition`, `try/catch`, toast):

```tsx
  function registrar() {
    if (estado !== 'confirmado' || pendiente || sinConexion || bloqueanteRegistro) return
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
```

5. El `onClick` que se pasa a `BotonPrimario` pasa a ser `estado === 'confirmado' ? registrar : confirmar` (o unificar en una sola función `accionPrimaria` que despache según `estado` — usar el criterio que quede más legible dentro del archivo real).

6. Importar `registrarComprobante` desde `@/server/app/acciones`.

En `src/app/comprobantes/[id]/page.tsx`, pasar las dos props nuevas a `<BarraAcciones>`:

```ts
import { probarConexion } from '@/server/db/pool'

// junto a las demas cargas de datos:
const conexion = await probarConexion()

// al renderizar <BarraAcciones ...>:
//   sinConexion={!conexion.ok}
//   bloqueanteRegistro={listoParaRegistrar?.bloqueante ?? false}
```

(`probarConexion` ya existe — es lo que usa `header-global.tsx`. Verificar su firma exacta ahí antes de usarla; si devuelve `{ ok: boolean }` como se asume acá, no hace falta ningún cambio en ese archivo.)

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/app/acciones.test.ts`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: sin errores

- [ ] **Step 5: Verificación manual en navegador**

Con un comprobante `confirmado` y el panel "Listo para registrar" en verde: click en "Registrar en Tango" → toast "Comprobante registrado en Tango.", el badge pasa a "Registrado en Tango", el botón primario pasa a "Ver asiento en Tango" (deshabilitado, sin funcionalidad en esta fase). Recargar la página: el estado persiste.

- [ ] **Step 6: Commit**

```bash
git add src/server/app/acciones.ts src/components/revision/barra-acciones.tsx "src/app/comprobantes/[id]/page.tsx" tests/server/app/acciones.test.ts
git commit -m "$(cat <<'EOF'
Habilitar "Registrar en Tango", gateado por conexión y validaciones

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Asociación de remitos — server action y UI

**Files:**
- Modify: `src/server/app/acciones.ts`
- Create: `src/components/revision/remitos-pendientes.tsx`
- Create: `src/components/revision/remitos-pendientes.module.css`
- Modify: `src/components/revision/pantalla.tsx`
- Modify: `src/app/comprobantes/[id]/page.tsx`
- Test: `tests/server/app/acciones.test.ts`

**Interfaces:**
- Consumes: `buscarRemitosPendientes` (`@/server/tango/remitos`, ya existe desde Fase 1).
- Produces:
  - `asignarRemitoEn(e: Ejecutor, renglonId: number, remitoNcompInS: string | null, remitoNRenglS: number | null): Promise<void>`
  - `asignarRemito(renglonId: number, remitoNcompInS: string | null, remitoNRenglS: number | null): Promise<void>`
  - `<RemitosPendientes renglones={...} remitos={RemitoPendiente[]} />`

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// Agregar a tests/server/app/acciones.test.ts
import { asignarRemitoEn } from '@/server/app/acciones'
import { insertarRenglonPrueba } from '@/server/app/comprobantes'

describe('asignarRemitoEn', () => {
  it('guarda el link al renglon de remito', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: '106817', descripcion: 'Articulo', cantidad: '4',
        precioUnitario: '80745,57', importe: '322982,28',
      })

      await asignarRemitoEn(tx, renglonId, '00003805', 1)

      const r = await tx.request().input('id', sql.Int, renglonId)
        .query(`SELECT REMITO_NCOMP_IN_S, REMITO_N_RENGL_S FROM PHF_RENGLON WHERE ID=@id`)
      expect(String(r.recordset[0].REMITO_NCOMP_IN_S).trim()).toBe('00003805')
      expect(Number(r.recordset[0].REMITO_N_RENGL_S)).toBe(1)
    })
  })

  it('desasigna con null', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: '106817', descripcion: 'Articulo', cantidad: '4',
        precioUnitario: '80745,57', importe: '322982,28',
      })
      await asignarRemitoEn(tx, renglonId, '00003805', 1)
      await asignarRemitoEn(tx, renglonId, null, null)

      const r = await tx.request().input('id', sql.Int, renglonId)
        .query(`SELECT REMITO_NCOMP_IN_S, REMITO_N_RENGL_S FROM PHF_RENGLON WHERE ID=@id`)
      expect(r.recordset[0].REMITO_NCOMP_IN_S).toBeNull()
      expect(r.recordset[0].REMITO_N_RENGL_S).toBeNull()
    })
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run tests/server/app/acciones.test.ts -t asignarRemitoEn`
Expected: FAIL — `asignarRemitoEn` no existe

- [ ] **Step 3: Implementar el server action**

Agregar a `src/server/app/acciones.ts`:

```ts
export async function asignarRemitoEn(
  e: Ejecutor,
  renglonId: number,
  remitoNcompInS: string | null,
  remitoNRenglS: number | null,
): Promise<void> {
  await e.request()
    .input('id', sql.Int, renglonId)
    .input('ncompInS', sql.VarChar(8), remitoNcompInS)
    .input('nRenglS', sql.Int, remitoNRenglS)
    .query(`UPDATE PHF_RENGLON SET REMITO_NCOMP_IN_S=@ncompInS, REMITO_N_RENGL_S=@nRenglS WHERE ID=@id`)
}

export async function asignarRemito(
  renglonId: number,
  remitoNcompInS: string | null,
  remitoNRenglS: number | null,
): Promise<void> {
  const pool = await getPool()
  await asignarRemitoEn(pool, renglonId, remitoNcompInS, remitoNRenglS)
  revalidatePath(`/comprobantes/${renglonId}`) // corregido abajo
}
```

**Ojo:** `revalidatePath` de arriba está mal — `renglonId` no es el `id` del comprobante, así que la ruta a revalidar no se puede armar solo con lo que recibe `asignarRemito`. Corregir agregando el `comprobanteId` como parámetro:

```ts
export async function asignarRemito(
  comprobanteId: number,
  renglonId: number,
  remitoNcompInS: string | null,
  remitoNRenglS: number | null,
): Promise<void> {
  const pool = await getPool()
  await asignarRemitoEn(pool, renglonId, remitoNcompInS, remitoNRenglS)
  revalidatePath(`/comprobantes/${comprobanteId}`)
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/app/acciones.test.ts`
Expected: PASS

- [ ] **Step 5: Construir la UI**

```tsx
// src/components/revision/remitos-pendientes.tsx
'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { asignarRemito } from '@/server/app/acciones'
import { useToast } from '@/components/toast/toast-provider'
import type { RemitoPendiente } from '@/server/tango/remitos'
import type { RenglonGuardado } from '@/server/app/detalle'
import styles from './remitos-pendientes.module.css'

export function RemitosPendientes({
  comprobanteId,
  renglones,
  remitos,
}: {
  comprobanteId: number
  renglones: RenglonGuardado[]
  remitos: RemitoPendiente[]
}) {
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()
  const toast = useToast()

  if (remitos.length === 0 || renglones.length === 0) return null

  const asignados = new Set(
    renglones
      .filter((r) => r.remitoNcompInS && r.remitoNRenglS)
      .map((r) => `${r.remitoNcompInS}-${r.remitoNRenglS}`),
  )

  function cambiar(renglonId: number, valor: string) {
    arrancar(async () => {
      try {
        if (!valor) {
          await asignarRemito(comprobanteId, renglonId, null, null)
        } else {
          const [ncompInS, nRenglS] = valor.split('|')
          await asignarRemito(comprobanteId, renglonId, ncompInS, Number(nRenglS))
        }
        router.refresh()
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo asignar el remito.')
      }
    })
  }

  return (
    <div className={styles.panel}>
      <h3 className={styles.titulo}>Remitos pendientes</h3>
      {renglones.map((r) => {
        const valorActual = r.remitoNcompInS && r.remitoNRenglS ? `${r.remitoNcompInS}|${r.remitoNRenglS}` : ''
        return (
          <div key={r.id} className={styles.fila}>
            <span className={styles.descripcion}>{r.descripcion ?? `Renglón ${r.id}`}</span>
            <select
              className={styles.select}
              value={valorActual}
              disabled={pendiente}
              onChange={(e) => cambiar(r.id, e.target.value)}
            >
              <option value="">Sin remito</option>
              {remitos.map((remito) =>
                remito.renglones.map((rr) => {
                  const clave = `${remito.numeroInterno}-${rr.nRenglon}`
                  if (asignados.has(clave) && clave !== `${r.remitoNcompInS}-${r.remitoNRenglS}`) return null
                  return (
                    <option key={clave} value={`${remito.numeroInterno}|${rr.nRenglon}`}>
                      Remito {remito.numero} — {rr.descripcion ?? rr.codArticulo} (pend. {rr.cantidadPendiente})
                    </option>
                  )
                }),
              )}
            </select>
          </div>
        )
      })}
    </div>
  )
}
```

```css
/* src/components/revision/remitos-pendientes.module.css */
.panel {
  background: var(--superficie);
  border: 1px solid var(--borde);
  border-radius: 10px;
  padding: 16px 18px;
  margin-top: 14px;
}

.titulo {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 10px;
}

.fila {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--borde-sutil-2);
}

.fila:first-of-type {
  border-top: none;
}

.descripcion {
  font-size: 13px;
  color: var(--texto-3);
  flex: 1;
}

.select {
  height: 34px;
  min-width: 260px;
  border: 1px solid var(--borde);
  border-radius: 6px;
  padding: 0 10px;
  font-size: 13px;
}
```

- [ ] **Step 6: Montar el componente**

En `src/app/comprobantes/[id]/page.tsx`, condicionado a que el proveedor esté resuelto (`codprovee` presente) y haya renglones. `Detalle` no tiene un `.valores` — es `.campos` (un array de `{ clave, valorFinal, ... }`); usar el mismo patrón de `find` que ya usa el resto del archivo para leer un campo puntual (o el `valores` local si `page.tsx` ya arma uno para otro propósito — leer el archivo real antes de duplicar esa lógica):

```ts
import { buscarRemitosPendientes } from '@/server/tango/remitos'

const codProveeCampo = detalle.campos.find((c) => c.clave === 'codprovee')?.valorFinal ?? null
const remitosPendientes =
  codProveeCampo && detalle.renglones.length > 0
    ? await buscarRemitosPendientes(codProveeCampo)
    : []
```

Pasar `remitosPendientes` y `detalle.renglones` a `<Pantalla>`. En `pantalla.tsx`, montar `<RemitosPendientes comprobanteId={id} renglones={renglones} remitos={remitosPendientes} />` inmediatamente después de la sección de Renglones existente (leer cómo se llama esa sección hoy en `pantalla.tsx` para insertarlo en el lugar correcto — probablemente ya sea `<Renglones renglones={...} />` o similar).

- [ ] **Step 7: Correr tsc**

Run: `npx tsc --noEmit`
Expected: sin errores

- [ ] **Step 8: Verificación manual en navegador**

Abrir un comprobante con proveedor resuelto y al menos un renglón extraído, donde ese proveedor tenga remitos pendientes reales (buscar uno con `buscarRemitosPendientes` contra la base, o usar el proveedor `010246` con el remito `00003805` de la factura de referencia si sigue pendiente — si ya se facturó en la base real, buscar otro). Elegir un remito en el select: el link se guarda, la página se refresca. Volver a abrir: el select mantiene la selección.

- [ ] **Step 9: Commit**

```bash
git add src/server/app/acciones.ts src/components/revision/remitos-pendientes.tsx src/components/revision/remitos-pendientes.module.css \
  src/components/revision/pantalla.tsx "src/app/comprobantes/[id]/page.tsx" tests/server/app/acciones.test.ts
git commit -m "$(cat <<'EOF'
Agregar la asociación manual de renglones a remitos pendientes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Verificación final de la fase

- [ ] Correr la suite completa: `pnpm test` — todos los archivos en verde (con la flakiness conocida de `migrate.test.ts` por contención de SQL Server, ya documentada).
- [ ] `npx tsc --noEmit` limpio.
- [ ] Verificación manual en navegador de punta a punta: registrar un comprobante sin renglones (77% de los casos) y confirmar que aparece en Tango con `SELECT * FROM CPA04 WHERE NCOMP_IN_C = <el que devolvió el toast o el panel>`; registrar uno con renglones y remito asignado, confirmar `STA20.CANT_PEND` bajó y `CPA46`/`CPA48` tienen filas; confirmar que "Registrar en Tango" queda deshabilitado si se simula una conexión caída (parar momentáneamente el servicio de SQL Server Browser o cambiar temporalmente `SQLSERVER_HOST` en `.env.local` a un valor inválido, probar, y revertir el cambio).
- [ ] Corregir el texto del spec general (`docs/superpowers/specs/2026-08-04-importador-facturas-tango-design.md`): §9 paso 7 dice `UPDATE CTA11.FALTA_REM`/`CTA09.ESTADO_MOV`, que está mal — debe decir `UPDATE STA20.CANT_FACTU/CANT_PEND` + `STA14.ESTADO_MOV`, que es lo que este plan (y el código de `remitos.ts` desde Fase 1) usa en la práctica. §266 define el remito pendiente sobre `CTA09` — corregir a `STA14`. Son correcciones de texto solamente, el código siempre usó las tablas correctas.
- [ ] Actualizar `docs/superpowers/RETOMAR.md`: marcar Fase 4 completa, listar lo que quedó funcionando, y mover los ítems ya resueltos de "Cosas que hay que arrastrar" (formato de `N_COMP` en el camino de escritura, representación de "sin valor" para `condcompra`) a cerrados. Documentar como pendiente para una fase futura: la columna `CPA04.UNIDADES` sin fórmula confirmada (ver nota de la Task 6), y cualquier desvío que haya aparecido al implementar contra los datos reales.

---

## Notas para quien ejecute este plan

- **Las columnas de `CPA04`/`CTA05`/`CPA46`/`CTA07`/`CPA48`/`CPA18`/`CTA06`/`CPA63`/`CPA54` de este plan salen de una consulta real** contra la factura de referencia (`NCOMP_IN_C=16591`) hecha durante el diseño de esta fase — no son una interpretación de la documentación de Tango. Si al implementar alguna columna da error de tipo o de longitud contra la base real, es más probable que el plan tenga un dato desactualizado (la base pudo cambiar) que un error de diseño — verificar con `SELECT * FROM <tabla> WHERE NCOMP_IN_C=16591` antes de asumir que el código está mal.
- **La Task 6 es la más grande y la más riesgosa.** Si el implementador se traba, es candidato a fix rounds 4-5 con un modelo más capaz (ver `superpowers:subagent-driven-development`, sección "Model Selection") antes que reintentos ciegos con el mismo modelo.
- **`CPA04.UNIDADES`** (ver nota en Task 6) es la única columna de todo este plan sin fórmula confirmada. No bloquea el registro (se usa `IMPORTE_TO` como aproximación), pero vale la pena que la revisión final de la fase la mire con atención.
