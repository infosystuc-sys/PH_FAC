# Fase 2 — Importación, extracción y revisión: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** llevar un comprobante desde que el operador arrastra el PDF hasta que queda `confirmado`, pasando por la extracción con Claude y la revisión campo por campo contra el PDF original.

**Architecture:** un catálogo tipado de campos en `src/lib/campos.ts` es la fuente de verdad de la que se derivan el JSON Schema que se le pide a Claude, las claves válidas de `PHF_CAMPO` y el formulario de revisión. La subida encola en una tabla y devuelve; un worker en proceso extrae de a 3 y repesca lo que se cuelga. La pantalla de revisión son dos paneles con scroll independiente: pdf.js a la izquierda, formulario con autosave a la derecha.

**Tech Stack:** Next.js 15 (App Router) · TypeScript · React 19 · `mssql` con SQL explícito · `@anthropic-ai/sdk` · `pdfjs-dist` · Vitest · CSS Modules · pnpm

## Global Constraints

- **Todas las tablas propias llevan prefijo `PHF_`.** Ninguna otra tabla se crea en la base. Nunca borrar, alterar ni escribir sobre una tabla que no lleve ese prefijo.
- **Solo `src/server/tango/` puede emitir SQL contra tablas del ERP** (`CPA*`, `STA*`, `GVA*`, `SBA*`). Las `CTA*` no se leen ni se escriben: no figuran en la documentación de Axoft.
- **Solo `src/server/ia/` puede hablar con la API de Anthropic.** Ningún otro módulo la nombra.
- Toda consulta va parametrizada con `.input(...)`. Nunca concatenar valores de usuario en el SQL.
- Ninguna credencial en archivos trackeados.
- **IBM Plex Sans** para la UI, **IBM Plex Mono** para todo dato que el operador cotejá contra el PDF: importes, CUIT, CAE, números de comprobante, fechas, timestamps, porcentajes.
- Sin Tailwind: CSS Modules y medidas exactas en píxeles. Los colores salen de las variables CSS de `src/app/globals.css`.
- Diseñado para ≥1280px. Sin diseño mobile, sin media queries.
- Copy en **español rioplatense**, sobrio y técnico.
- Los tests que escriben van dentro de `conRollback` y **no pueden asumir que las tablas están vacías**: miden contra una línea de base.
- **`pnpm test` tiene que correr sin `ANTHROPIC_API_KEY` cargada.** Ningún test pega contra la API de Anthropic.
- Commits en español, en imperativo, terminando con `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/lib/campos.ts` | Catálogo de campos. Deriva el JSON Schema y las claves válidas. Sin dependencias |
| `src/lib/renglones.ts` | Tipo del renglón extraído y su normalización |
| `scripts/migrate.ts` | **Modificar:** soporte de columnas faltantes + las 4 columnas nuevas |
| `src/server/ia/prompt.ts` | El prompt de sistema, versionado |
| `src/server/ia/extraccion.ts` | Único módulo que llama a la API de Anthropic |
| `src/server/app/detalle.ts` | Lectura y escritura de `PHF_CAMPO` / `PHF_RENGLON` / `PHF_AUDITORIA` |
| `src/server/app/archivos.ts` | Guardado del PDF en disco y hash |
| `src/server/app/cola.ts` | Encolar, tomar, repescar, agotar intentos |
| `src/server/app/acciones.ts` | Server actions: importar, autosave, confirmar, reprocesar |
| `src/app/api/pdf/[id]/route.ts` | Sirve el PDF desde disco |
| `src/app/comprobantes/[id]/page.tsx` | **Modificar:** pantalla de revisión |
| `src/components/revision/*` | Visor, formulario, grupos, historial, aviso IA |
| `src/components/bandeja/importar.tsx` | Modal de importación |

---

## Task 1: Catálogo de campos

**Files:**
- Create: `src/lib/campos.ts`
- Create: `src/lib/renglones.ts`
- Test: `tests/lib/campos.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: `type GrupoCampo`, `type TipoCampo`, `type DefCampo`, `CAMPOS: DefCampo[]`, `CAMPOS_IA: DefCampo[]`, `esClaveValida(clave: string): boolean`, `campoPorClave(clave: string): DefCampo | undefined`, `schemaExtraccion(): Record<string, unknown>`, `type RenglonExtraido`

- [ ] **Step 1: Escribir el test que falla**

`tests/lib/campos.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  CAMPOS,
  CAMPOS_IA,
  esClaveValida,
  campoPorClave,
  schemaExtraccion,
} from '@/lib/campos'

describe('catalogo de campos', () => {
  it('no repite claves', () => {
    const claves = CAMPOS.map((c) => c.clave)
    expect(new Set(claves).size).toBe(claves.length)
  })

  it('ninguna clave supera los 40 caracteres de PHF_CAMPO.CLAVE', () => {
    for (const c of CAMPOS) expect(c.clave.length).toBeLessThanOrEqual(40)
  })

  it('cada grupo suma un multiplo de 6, el ancho de la grilla', () => {
    const porGrupo = new Map<string, number>()
    for (const c of CAMPOS) porGrupo.set(c.grupo, (porGrupo.get(c.grupo) ?? 0) + c.span)
    for (const [grupo, ancho] of porGrupo) {
      expect(ancho % 6, `el grupo ${grupo} suma ${ancho}`).toBe(0)
    }
  })

  it('la IA extrae 21 campos', () => {
    expect(CAMPOS_IA.length).toBe(21)
  })

  it('los campos calculados y de imputacion no los extrae la IA', () => {
    for (const clave of ['imputado', 'codprovee', 'condcompra']) {
      expect(campoPorClave(clave)!.extraePorIA).toBe(false)
    }
  })

  it('reconoce una clave del catalogo y rechaza una inventada', () => {
    expect(esClaveValida('cuit')).toBe(true)
    expect(esClaveValida('no_existe')).toBe(false)
  })
})

describe('schemaExtraccion', () => {
  it('pide exactamente los campos que extrae la IA', () => {
    const s = schemaExtraccion() as any
    const props = Object.keys(s.properties.campos.properties)
    expect(props.sort()).toEqual(CAMPOS_IA.map((c) => c.clave).sort())
    expect(s.properties.campos.required.sort()).toEqual(props.sort())
  })

  it('cierra todos los objetos con additionalProperties false', () => {
    // Structured outputs lo exige en cada objeto del schema.
    const objetos: any[] = []
    const recorrer = (n: any) => {
      if (n === null || typeof n !== 'object') return
      if (n.type === 'object') objetos.push(n)
      for (const v of Object.values(n)) recorrer(v)
    }
    recorrer(schemaExtraccion())
    expect(objetos.length).toBeGreaterThan(0)
    for (const o of objetos) expect(o.additionalProperties).toBe(false)
  })

  it('modela el valor ausente con anyOf string|null, no con type array', () => {
    // La lista de features soportadas incluye anyOf pero no uniones por
    // array de tipos: `{"type": ["string","null"]}` no esta garantizado.
    const s = schemaExtraccion() as any
    const cuit = s.properties.campos.properties.cuit
    expect(cuit.properties.valor.anyOf).toEqual([{ type: 'string' }, { type: 'null' }])
    expect(cuit.properties.confianza.type).toBe('number')
  })

  it('pide los cinco datos de cada renglon', () => {
    const s = schemaExtraccion() as any
    expect(s.properties.renglones.items.required.sort()).toEqual(
      ['cantidad', 'codigo', 'descripcion', 'importe', 'precioUnitario'].sort(),
    )
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/lib/campos.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/campos"`

- [ ] **Step 3: Escribir `src/lib/renglones.ts`**

```ts
/**
 * Un renglón tal como lo devuelve la IA: todo texto, sin interpretar. El
 * parseo a número vive en `formato.ts`, igual que con los campos.
 */
export type RenglonExtraido = {
  codigo: string | null
  descripcion: string | null
  cantidad: string | null
  precioUnitario: string | null
  importe: string | null
}

export const CLAVES_RENGLON = [
  'codigo',
  'descripcion',
  'cantidad',
  'precioUnitario',
  'importe',
] as const
```

- [ ] **Step 4: Escribir `src/lib/campos.ts`**

```ts
import { CLAVES_RENGLON } from './renglones'

export type GrupoCampo = 'comprobante' | 'proveedor' | 'importes' | 'imputacion'
export type TipoCampo = 'texto' | 'fecha' | 'decimal'

export type DefCampo = {
  clave: string
  label: string
  grupo: GrupoCampo
  /** Ancho en la grilla de 6 columnas del grupo. */
  span: number
  tipo: TipoCampo
  /** IBM Plex Mono: todo dato que el operador cotejá contra el PDF. */
  mono: boolean
  extraePorIA: boolean
  soloLectura: boolean
}

/**
 * La fuente de verdad de los campos. De acá salen tres cosas que si no
 * estarían repetidas: el JSON Schema que se le pide a Claude, las claves
 * válidas de PHF_CAMPO.CLAVE, y el render del formulario de revisión.
 *
 * El orden es el orden en que se muestran.
 */
export const CAMPOS: DefCampo[] = [
  // Comprobante — 18 = 3 filas de 6
  c('tipo',        'Tipo',                  'comprobante', 2, 'texto',   false),
  c('ptovta',      'Punto de venta',        'comprobante', 2, 'texto',   true),
  c('nro',         'Número',                'comprobante', 2, 'texto',   true),
  c('fecha',       'Fecha de emisión',      'comprobante', 2, 'fecha',   true),
  c('cae',         'CAE',                   'comprobante', 2, 'texto',   true),
  c('vtocae',      'Vto. CAE',              'comprobante', 2, 'fecha',   true),
  c('moneda',      'Moneda',                'comprobante', 2, 'texto',   false),
  c('cotizacion',  'Cotización',            'comprobante', 2, 'decimal', true),
  c('ordencompra', 'Orden de compra',       'comprobante', 2, 'texto',   true),

  // Proveedor — 12 = 2 filas de 6
  c('razon',       'Razón social',          'proveedor',   3, 'texto',   false),
  c('cuit',        'CUIT',                  'proveedor',   3, 'texto',   true),
  c('condiva',     'Condición IVA',         'proveedor',   2, 'texto',   false),
  c('condpago',    'Condición de pago',     'proveedor',   2, 'texto',   false),
  c('vencimiento', 'Vencimiento',           'proveedor',   2, 'fecha',   true),

  // Importes — 18 = 3 filas de 6
  c('neto',        'Neto gravado 21%',      'importes',    2, 'decimal', true),
  c('iva21',       'IVA 21%',               'importes',    2, 'decimal', true),
  c('iva105',      'IVA 10,5%',             'importes',    2, 'decimal', true),
  c('exento',      'No gravado / exento',   'importes',    2, 'decimal', true),
  c('perciva',     'Percepción IVA',        'importes',    2, 'decimal', true),
  c('perciibb',    'Percepción IIBB',       'importes',    2, 'decimal', true),
  c('total',       'Total del comprobante', 'importes',    3, 'decimal', true),
  { clave: 'imputado', label: 'Total imputado', grupo: 'importes', span: 3,
    tipo: 'decimal', mono: true, extraePorIA: false, soloLectura: true },

  // Imputación en Tango — 6 = 1 fila. Ninguno lo extrae la IA:
  // `codprovee` se resuelve del CUIT, `condcompra` lo elige el operador.
  { clave: 'codprovee', label: 'Cód. proveedor Tango', grupo: 'imputacion', span: 3,
    tipo: 'texto', mono: true, extraePorIA: false, soloLectura: true },
  { clave: 'condcompra', label: 'Condición de compra', grupo: 'imputacion', span: 3,
    tipo: 'texto', mono: false, extraePorIA: false, soloLectura: false },
]

function c(
  clave: string,
  label: string,
  grupo: GrupoCampo,
  span: number,
  tipo: TipoCampo,
  mono: boolean,
): DefCampo {
  return { clave, label, grupo, span, tipo, mono, extraePorIA: true, soloLectura: false }
}

export const CAMPOS_IA: DefCampo[] = CAMPOS.filter((x) => x.extraePorIA)

const POR_CLAVE = new Map(CAMPOS.map((x) => [x.clave, x]))

export function campoPorClave(clave: string): DefCampo | undefined {
  return POR_CLAVE.get(clave)
}

export function esClaveValida(clave: string): boolean {
  return POR_CLAVE.has(clave)
}

export const GRUPOS: { clave: GrupoCampo; titulo: string }[] = [
  { clave: 'comprobante', titulo: 'Comprobante' },
  { clave: 'proveedor', titulo: 'Proveedor' },
  { clave: 'importes', titulo: 'Importes' },
  { clave: 'imputacion', titulo: 'Imputación en Tango' },
]

export function camposDelGrupo(grupo: GrupoCampo): DefCampo[] {
  return CAMPOS.filter((x) => x.grupo === grupo)
}

/** `valor` puede venir null cuando el dato no figura en el PDF. */
const VALOR_O_NULL = { anyOf: [{ type: 'string' }, { type: 'null' }] }

function objeto(props: Record<string, unknown>) {
  return {
    type: 'object',
    properties: props,
    required: Object.keys(props),
    additionalProperties: false,
  }
}

/**
 * El JSON Schema de `output_config.format`. Structured outputs exige
 * `additionalProperties: false` y `required` en todos los objetos, y no
 * garantiza uniones por array de tipos -- de ahí el `anyOf`.
 */
export function schemaExtraccion(): Record<string, unknown> {
  const campos: Record<string, unknown> = {}
  for (const x of CAMPOS_IA) {
    campos[x.clave] = objeto({
      valor: VALOR_O_NULL,
      confianza: { type: 'number' },
    })
  }

  const renglon: Record<string, unknown> = {}
  for (const k of CLAVES_RENGLON) renglon[k] = VALOR_O_NULL

  return objeto({
    campos: objeto(campos),
    renglones: { type: 'array', items: objeto(renglon) },
  })
}
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/lib/campos.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 6: Commit**

```bash
git add src/lib/campos.ts src/lib/renglones.ts tests/lib/campos.test.ts
git commit -m "$(cat <<'EOF'
agregar el catalogo de campos de la extraccion

Es la fuente de verdad de la que salen el JSON Schema que se le pide a
Claude, las claves validas de PHF_CAMPO y el render del formulario. Sin
esto serian tres listas que se desincronizan.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: La migración aprende a agregar columnas

**Files:**
- Modify: `scripts/migrate.ts`
- Test: `tests/scripts/migrate.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: `type ColumnaDef = { nombre: string; ddl: string }`, campo `columnas?: ColumnaDef[]` en `Definicion`, `migrarDefiniciones` ahora también agrega columnas faltantes.

Hoy `migrarDefiniciones` crea tablas que faltan y repara índices que faltan, pero no sabe alterar una tabla existente. La Fase 2 necesita cuatro columnas nuevas en `PHF_COMPROBANTE`, que en producción ya tiene datos.

- [ ] **Step 1: Escribir el test que falla**

Agregar a `tests/scripts/migrate.test.ts`, dentro del describe que ejercita el CREATE de verdad con prefijo de prueba:

```ts
it('agrega una columna que falta sin tocar el resto de la tabla', async () => {
  const prefijo = `TMPCOL${Date.now()}_`
  const pool = await getPool()
  const tabla = `${prefijo}COMPROBANTE`

  try {
    // Se crea la tabla completa y despues se le saca una columna, para
    // simular una base que quedo en la version anterior del esquema.
    await migrar(prefijo)
    await pool.request().batch(`ALTER TABLE ${tabla} DROP COLUMN EXTRACCION_MS`)

    const antes = await columnas(pool, tabla)
    expect(antes).not.toContain('EXTRACCION_MS')

    await migrar(prefijo)

    const despues = await columnas(pool, tabla)
    expect(despues).toContain('EXTRACCION_MS')
    // No se perdio nada mas en el camino.
    expect(despues.length).toBe(antes.length + 1)
  } finally {
    await limpiarPrefijo(pool, prefijo)
  }
})

it('la tabla creada de cero y la reparada tienen las mismas columnas', async () => {
  // Las columnas nuevas estan declaradas dos veces -- en el CREATE TABLE y
  // en `columnas`, para el camino de reparacion. Este test es lo que evita
  // que esas dos declaraciones se separen.
  const pool = await getPool()
  const pA = `TMPNEW${Date.now()}_`
  const pB = `TMPREP${Date.now()}_`

  try {
    await migrar(pA)
    await migrar(pB)
    await pool.request().batch(`ALTER TABLE ${pB}COMPROBANTE DROP COLUMN INTENTOS`)
    await migrar(pB)

    expect(await columnas(pool, `${pB}COMPROBANTE`)).toEqual(
      await columnas(pool, `${pA}COMPROBANTE`),
    )
  } finally {
    await limpiarPrefijo(pool, pA)
    await limpiarPrefijo(pool, pB)
  }
})
```

Con este helper al tope del archivo (junto a los que ya existan):

```ts
async function columnas(pool: sql.ConnectionPool, tabla: string): Promise<string[]> {
  const r = await pool
    .request()
    .input('t', tabla)
    .query(`
      SELECT c.name AS nombre
      FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id
      WHERE t.name = @t ORDER BY c.name
    `)
  return r.recordset.map((x: { nombre: string }) => x.nombre)
}
```

Si `limpiarPrefijo` no existe todavía en el archivo de tests, agregarlo:

```ts
async function limpiarPrefijo(pool: sql.ConnectionPool, prefijo: string): Promise<void> {
  // Orden inverso al de creacion por las FK.
  for (const t of ['AUDITORIA', 'RENGLON', 'CAMPO', 'COMPROBANTE']) {
    await pool.request().batch(`DROP TABLE IF EXISTS ${prefijo}${t}`)
  }
}
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/scripts/migrate.test.ts`
Expected: FAIL — la segunda `migrar(prefijo)` no repone `EXTRACCION_MS`, así que `expect(despues).toContain('EXTRACCION_MS')` falla

- [ ] **Step 3: Agregar las cuatro columnas al CREATE TABLE**

En `scripts/migrate.ts`, dentro del `ddlTabla` de `PHF_COMPROBANTE`, justo antes de `FECHA_ALTA`:

```sql
        INTENTOS            INT            NOT NULL CONSTRAINT DF_PHF_COMP_INTENTOS DEFAULT 0,
        ERROR_MENSAJE       NVARCHAR(1000) NULL,
        EXTRACCION_MS       INT            NULL,
        EXTRACCION_MODELO   VARCHAR(40)    NULL,
```

- [ ] **Step 4: Declarar las columnas para el camino de reparación**

En la misma definición de `PHF_COMPROBANTE`, al lado de `indices`:

```ts
    columnas: [
      { nombre: 'INTENTOS', ddl: 'INTENTOS INT NOT NULL CONSTRAINT DF_PHF_COMP_INTENTOS DEFAULT 0' },
      { nombre: 'ERROR_MENSAJE', ddl: 'ERROR_MENSAJE NVARCHAR(1000) NULL' },
      { nombre: 'EXTRACCION_MS', ddl: 'EXTRACCION_MS INT NULL' },
      { nombre: 'EXTRACCION_MODELO', ddl: 'EXTRACCION_MODELO VARCHAR(40) NULL' },
    ],
```

Y extender el tipo:

```ts
type ColumnaDef = { nombre: string; ddl: string }
type Definicion = {
  tabla: string
  ddlTabla: string
  indices?: IndiceDef[]
  /**
   * Las columnas agregadas despues de la version inicial del esquema.
   * Estan tambien en `ddlTabla`, para que una base nueva se cree completa
   * de una; esta lista es solo el camino de reparacion de una base que
   * quedo en la version anterior. Hay un test que verifica que las dos
   * declaraciones no se separen.
   */
  columnas?: ColumnaDef[]
}
```

- [ ] **Step 5: Escribir el detector de columnas faltantes**

Al lado de `indicesFaltantes`:

```ts
/** Nombres, de entre `columnasEsperadas`, que no existen todavia en `tabla`. */
async function columnasFaltantes(
  pool: sql.ConnectionPool,
  tabla: string,
  columnasEsperadas: string[],
): Promise<string[]> {
  if (columnasEsperadas.length === 0) return []

  const req = pool.request().input('t', tabla)
  const placeholders = columnasEsperadas.map((nombre, i) => {
    req.input(`c${i}`, nombre)
    return `@c${i}`
  })
  const r = await req.query(`
    SELECT c.name AS nombre
    FROM sys.columns c
    JOIN sys.tables t ON t.object_id = c.object_id
    WHERE t.name = @t AND c.name IN (${placeholders.join(', ')})
  `)
  const presentes = new Set(r.recordset.map((row: { nombre: string }) => row.nombre))
  return columnasEsperadas.filter((n) => !presentes.has(n))
}
```

- [ ] **Step 6: Emitir el ALTER TABLE en el camino de reparación**

En `migrarDefiniciones`, reemplazar el bloque que va desde `const faltantes = await indicesFaltantes(` hasta el cierre de su `conTransaccion`, por:

```ts
    const columnasDef = (columnas ?? []).map((x) => ({
      nombre: conPrefijo(x.nombre, prefijo),
      ddl: conPrefijo(x.ddl, prefijo),
    }))

    // Las columnas van antes que los indices: un indice futuro podria
    // apoyarse en una columna nueva.
    const colFaltantes = await columnasFaltantes(
      pool,
      tabla,
      columnasDef.map((x) => x.nombre),
    )
    if (colFaltantes.length > 0) {
      await conTransaccion(async (tx) => {
        // Un solo ADD con todas: SQL Server lo resuelve en una pasada, y
        // asi no queda una tabla a medio migrar si falla la tercera.
        const lista = columnasDef
          .filter((x) => colFaltantes.includes(x.nombre))
          .map((x) => x.ddl)
          .join(', ')
        await tx.request().batch(`ALTER TABLE ${tabla} ADD ${lista}`)
      })
    }

    const faltantes = await indicesFaltantes(
      pool,
      tabla,
      indicesDef.map((i) => i.nombre),
    )
    if (faltantes.length === 0) continue

    await conTransaccion(async (tx) => {
      const ddlIndicesFaltantes = indicesDef
        .filter((i) => faltantes.includes(i.nombre))
        .map((i) => i.ddl)
        .join('\n')
      await tx.request().batch(ddlIndicesFaltantes)
    })
```

Y agregar `columnas` al destructuring del `for`:

```ts
  for (const { tabla: tablaBase, ddlTabla, indices, columnas } of definiciones) {
```

- [ ] **Step 7: Correr los tests de migración**

Run: `npx vitest run tests/scripts/migrate.test.ts`
Expected: PASS — los 8 que ya estaban más los 2 nuevos

- [ ] **Step 8: Correr la migración contra la base real**

Run: `pnpm migrate`
Expected: agrega las cuatro columnas a `PHF_COMPROBANTE` sin tocar los datos existentes. Verificar con:

```bash
npx tsx -e "import('dotenv').then(d=>d.config({path:'.env.local'}));import('./src/server/db/pool.js').then(async m=>{const p=await m.getPool();const r=await p.request().query(\"SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('PHF_COMPROBANTE') AND name IN ('INTENTOS','ERROR_MENSAJE','EXTRACCION_MS','EXTRACCION_MODELO')\");console.log(r.recordset);await m.cerrarPool()})"
```

Expected: las cuatro filas.

- [ ] **Step 9: Commit**

```bash
git add scripts/migrate.ts tests/scripts/migrate.test.ts
git commit -m "$(cat <<'EOF'
ensenarle a la migracion a agregar columnas que faltan

Hasta ahora creaba tablas ausentes y reparaba indices ausentes, pero no
sabia alterar una tabla existente. La Fase 2 necesita cuatro columnas en
PHF_COMPROBANTE -- INTENTOS, ERROR_MENSAJE, EXTRACCION_MS y
EXTRACCION_MODELO -- y en produccion esa tabla ya tiene datos.

Las columnas nuevas quedan declaradas dos veces, en el CREATE TABLE y en
`columnas`. Hay un test que compara una tabla creada de cero contra una
reparada para que esas dos declaraciones no se separen.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: La capa de IA

**Files:**
- Create: `src/server/ia/prompt.ts`
- Create: `src/server/ia/extraccion.ts`
- Create: `tests/fixtures/extraccion-ok.json`
- Test: `tests/server/ia/extraccion.test.ts`

**Interfaces:**
- Consumes: `CAMPOS_IA`, `schemaExtraccion` de `@/lib/campos`; `RenglonExtraido` de `@/lib/renglones`
- Produces: `type CampoExtraido = { valor: string | null; confianza: number }`, `type Extraccion = { campos: Record<string, CampoExtraido>; renglones: RenglonExtraido[] }`, `type ResultadoExtraccion = { ok: true; extraccion: Extraccion; ms: number; modelo: string } | { ok: false; error: string }`, `parsearRespuesta(texto: string): Extraccion` (exportada para poder testearla sin red), `extraerDePdf(pdf: Buffer): Promise<ResultadoExtraccion>`

- [ ] **Step 1: Instalar el SDK**

```bash
pnpm add @anthropic-ai/sdk
```

- [ ] **Step 2: Escribir el fixture**

`tests/fixtures/extraccion-ok.json` — una respuesta válida, recortada a lo esencial. Los 21 campos tienen que estar; acá van los primeros y el resto sigue el mismo patrón con `"valor": null, "confianza": 0`:

```json
{
  "campos": {
    "tipo":        { "valor": "FAC A",        "confianza": 0.99 },
    "ptovta":      { "valor": "0011",         "confianza": 0.97 },
    "nro":         { "valor": "00063576",     "confianza": 0.98 },
    "fecha":       { "valor": "18/05/2026",   "confianza": 0.96 },
    "cae":         { "valor": "76123456789012", "confianza": 0.94 },
    "vtocae":      { "valor": "28/05/2026",   "confianza": 0.93 },
    "moneda":      { "valor": "ARS",          "confianza": 0.99 },
    "cotizacion":  { "valor": "1,00",         "confianza": 0.99 },
    "ordencompra": { "valor": null,           "confianza": 0 },
    "razon":       { "valor": "MIDEA CARRIER ARGENTINA SA", "confianza": 0.98 },
    "cuit":        { "valor": "30-71042636-9", "confianza": 0.99 },
    "condiva":     { "valor": "IVA Responsable Inscripto", "confianza": 0.95 },
    "condpago":    { "valor": "CTA CTE 30 DIAS", "confianza": 0.88 },
    "vencimiento": { "valor": "17/06/2026",   "confianza": 0.85 },
    "neto":        { "valor": "322.982,28",   "confianza": 0.97 },
    "iva21":       { "valor": "67.826,28",    "confianza": 0.97 },
    "iva105":      { "valor": null,           "confianza": 0 },
    "exento":      { "valor": null,           "confianza": 0 },
    "perciva":     { "valor": "8.074,56",     "confianza": 0.91 },
    "perciibb":    { "valor": "75.771,67",    "confianza": 0.9 },
    "total":       { "valor": "484.344,26",   "confianza": 0.99 }
  },
  "renglones": [
    {
      "codigo": "106817",
      "descripcion": "MICROONDAS MIDEA 20L DIGITAL",
      "cantidad": "4",
      "precioUnitario": "80.745,57",
      "importe": "322.982,28"
    }
  ]
}
```

- [ ] **Step 3: Escribir el test que falla**

`tests/server/ia/extraccion.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parsearRespuesta } from '@/server/ia/extraccion'
import { CAMPOS_IA } from '@/lib/campos'

const OK = readFileSync('tests/fixtures/extraccion-ok.json', 'utf8')

describe('parsearRespuesta', () => {
  it('parsea una respuesta valida', () => {
    const e = parsearRespuesta(OK)
    expect(e.campos.cuit.valor).toBe('30-71042636-9')
    expect(e.campos.cuit.confianza).toBeCloseTo(0.99)
    expect(e.renglones).toHaveLength(1)
    expect(e.renglones[0].codigo).toBe('106817')
  })

  it('devuelve los 21 campos del catalogo', () => {
    const e = parsearRespuesta(OK)
    expect(Object.keys(e.campos).sort()).toEqual(CAMPOS_IA.map((c) => c.clave).sort())
  })

  it('conserva el null de un campo que no figura en el PDF', () => {
    expect(parsearRespuesta(OK).campos.ordencompra.valor).toBeNull()
  })

  it('descarta claves que no estan en el catalogo', () => {
    const conBasura = JSON.parse(OK)
    conBasura.campos.inventado = { valor: 'x', confianza: 1 }
    const e = parsearRespuesta(JSON.stringify(conBasura))
    expect(e.campos).not.toHaveProperty('inventado')
  })

  it('completa con null un campo que la IA omitio', () => {
    const incompleto = JSON.parse(OK)
    delete incompleto.campos.cae
    const e = parsearRespuesta(JSON.stringify(incompleto))
    expect(e.campos.cae).toEqual({ valor: null, confianza: 0 })
  })

  it('acota la confianza al rango 0..1', () => {
    const fuera = JSON.parse(OK)
    fuera.campos.total.confianza = 4.2
    expect(parsearRespuesta(JSON.stringify(fuera)).campos.total.confianza).toBe(1)
  })

  it('lanza con JSON invalido', () => {
    expect(() => parsearRespuesta('{ esto no es json')).toThrow()
  })

  it('lanza cuando falta el objeto campos', () => {
    expect(() => parsearRespuesta('{"renglones":[]}')).toThrow(/campos/i)
  })

  it('ignora renglones enteramente vacios', () => {
    const conVacio = JSON.parse(OK)
    conVacio.renglones.push({
      codigo: null, descripcion: null, cantidad: null,
      precioUnitario: null, importe: null,
    })
    expect(parsearRespuesta(JSON.stringify(conVacio)).renglones).toHaveLength(1)
  })
})
```

- [ ] **Step 4: Correr el test y verificar que falla**

Run: `npx vitest run tests/server/ia/extraccion.test.ts`
Expected: FAIL — `Failed to resolve import "@/server/ia/extraccion"`

- [ ] **Step 5: Escribir `src/server/ia/prompt.ts`**

```ts
import { CAMPOS_IA } from '@/lib/campos'

/**
 * Va en el bloque `system` con cache_control. Tiene que superar los 512
 * tokens que Opus 5 pide como minimo cacheable -- los supera holgado -- y
 * ser byte a byte identico en cada llamada, o el cache no pega. Por eso se
 * arma una sola vez al importar el modulo y no lleva fecha ni nada
 * variable adentro.
 */
export const PROMPT_EXTRACCION = [
  'Sos un asistente de cuentas a pagar. Leés comprobantes de compra argentinos',
  '(facturas A/B/C, notas de crédito y de débito) y extraés sus campos.',
  '',
  'Reglas:',
  '',
  '1. Devolvé el valor EXACTAMENTE como figura en el PDF. No normalices, no',
  '   conviertas, no reformatees. Si el importe dice "322.982,28", devolvé',
  '   "322.982,28" y no "322982.28". Si el CUIT tiene guiones, dejale los guiones.',
  '2. Si un campo no figura en el comprobante, devolvé valor null y confianza 0.',
  '   No lo infieras, no lo calcules a partir de otros campos, no lo inventes.',
  '3. La confianza va de 0 a 1 y expresa qué tan seguro estás de haber leído bien',
  '   ese dato puntual en este PDF puntual. Un campo impreso con nitidez y sin',
  '   ambigüedad va cerca de 1. Un campo borroso, cortado, escrito a mano o que',
  '   podría confundirse con otro va abajo de 0,8. Sé honesto: una confianza alta',
  '   sobre un dato que leíste mal le cuesta plata al operador, porque es',
  '   exactamente el campo que va a revisar menos.',
  '4. El punto de venta y el número van por separado y sin el prefijo del tipo.',
  '   De "FACTURA A 0011-00063576" sale ptovta "0011" y nro "00063576".',
  '5. Los renglones son los artículos facturados. Si el comprobante no los',
  '   detalla, devolvé un array vacío. Es lo normal: la mayoría de los',
  '   comprobantes vienen solo con cabecera.',
  '6. Distinguí el neto gravado de los impuestos y de las percepciones. Las',
  '   percepciones de IVA y de ingresos brutos suelen figurar al pie, separadas',
  '   del IVA propiamente dicho.',
  '',
  'Campos a extraer:',
  '',
  ...CAMPOS_IA.map((x) => `- ${x.clave}: ${x.label}`),
].join('\n')

/** Va en el historial de auditoría, para saber con qué prompt se leyó. */
export const VERSION_PROMPT = 'v1'
```

- [ ] **Step 6: Escribir `src/server/ia/extraccion.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk'
import { CAMPOS_IA, schemaExtraccion } from '@/lib/campos'
import { CLAVES_RENGLON, type RenglonExtraido } from '@/lib/renglones'
import { PROMPT_EXTRACCION } from './prompt'

export type CampoExtraido = { valor: string | null; confianza: number }

export type Extraccion = {
  campos: Record<string, CampoExtraido>
  renglones: RenglonExtraido[]
}

export type ResultadoExtraccion =
  | { ok: true; extraccion: Extraccion; ms: number; modelo: string }
  | { ok: false; error: string }

const MODELO = process.env.ANTHROPIC_MODELO || 'claude-opus-5'

let cliente: Anthropic | null = null
function getCliente(): Anthropic {
  if (!cliente) cliente = new Anthropic()
  return cliente
}

function texto(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

function confianza(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * Convierte el JSON crudo en una `Extraccion`. Es tolerante a propósito: el
 * schema le pide a Claude una forma exacta, pero acá se asume que puede
 * llegar cualquier cosa. Un campo de más se descarta, uno de menos se
 * completa con null. Lo único que hace fallar es que el JSON no parsee o
 * que no venga el objeto `campos`.
 */
export function parsearRespuesta(texto_: string): Extraccion {
  const crudo = JSON.parse(texto_) as Record<string, unknown>

  const campos_ = crudo.campos
  if (campos_ === null || typeof campos_ !== 'object') {
    throw new Error('La respuesta no trae el objeto `campos`.')
  }
  const dic = campos_ as Record<string, unknown>

  const campos: Record<string, CampoExtraido> = {}
  for (const def of CAMPOS_IA) {
    const c = dic[def.clave]
    if (c === null || typeof c !== 'object') {
      campos[def.clave] = { valor: null, confianza: 0 }
      continue
    }
    const o = c as Record<string, unknown>
    const valor = texto(o.valor)
    campos[def.clave] = {
      valor,
      // Un campo sin valor no aporta confianza al promedio.
      confianza: valor === null ? 0 : confianza(o.confianza),
    }
  }

  const renglones: RenglonExtraido[] = []
  for (const r of Array.isArray(crudo.renglones) ? crudo.renglones : []) {
    if (r === null || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const fila = Object.fromEntries(
      CLAVES_RENGLON.map((k) => [k, texto(o[k])]),
    ) as unknown as RenglonExtraido
    // Un renglon sin un solo dato no es un renglon.
    if (CLAVES_RENGLON.every((k) => fila[k] === null)) continue
    renglones.push(fila)
  }

  return { campos, renglones }
}

/**
 * Manda el PDF a Claude y devuelve los campos con su confianza. No lanza:
 * toda falla vuelve como `{ ok: false }` para que la cola decida si
 * reintenta o marca el comprobante en error.
 */
export async function extraerDePdf(pdf: Buffer): Promise<ResultadoExtraccion> {
  const arranque = Date.now()
  try {
    const r = await getCliente().messages.create({
      model: MODELO,
      max_tokens: 16000,
      // En Opus 5 el pensamiento se cuenta DENTRO de max_tokens.
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: schemaExtraccion() },
      },
      system: [
        {
          type: 'text',
          text: PROMPT_EXTRACCION,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            // El documento va antes del texto.
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdf.toString('base64'),
              },
            },
            { type: 'text', text: 'Extraé los campos de este comprobante.' },
          ],
        },
      ],
    })

    if (r.stop_reason === 'refusal') {
      return { ok: false, error: 'El modelo no procesó el comprobante.' }
    }

    const bloque = r.content.find((b) => b.type === 'text')
    if (!bloque || bloque.type !== 'text') {
      return { ok: false, error: 'La respuesta no trajo contenido de texto.' }
    }

    return {
      ok: true,
      extraccion: parsearRespuesta(bloque.text),
      ms: Date.now() - arranque,
      modelo: MODELO,
    }
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err)
    return { ok: false, error: mensaje.slice(0, 900) }
  }
}
```

- [ ] **Step 7: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/ia/extraccion.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 8: Verificar que la suite sigue corriendo sin API key**

Run: `npx vitest run`
Expected: PASS. Ningún test toca `extraerDePdf`, solo `parsearRespuesta`.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml src/server/ia tests/server/ia tests/fixtures
git commit -m "$(cat <<'EOF'
agregar la capa de extraccion con Claude

src/server/ia/ es el unico modulo que habla con la API de Anthropic, con
la misma disciplina de frontera que src/server/tango/.

El prompt va en `system` con cache_control: supera los 512 tokens que
Opus 5 pide como minimo cacheable y es identico en cada llamada, asi que
a partir del segundo comprobante esa parte de la entrada se cobra a una
decima parte. El PDF va despues, en messages, para no romper el prefijo.

parsearRespuesta se exporta aparte y se testea con respuestas grabadas.
Ningun test pega contra la API.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Persistencia del detalle

**Files:**
- Create: `src/server/app/detalle.ts`
- Test: `tests/server/app/detalle.test.ts`

**Interfaces:**
- Consumes: `Extraccion` de `@/server/ia/extraccion`; `esClaveValida` de `@/lib/campos`; `conRollback` de `@/server/db/tx`
- Produces: `type CampoGuardado = { clave: string; valorIA: string | null; confianza: number | null; valorFinal: string | null; corregido: boolean }`, `type RenglonGuardado = RenglonExtraido & { orden: number }`, `type EntradaAuditoria = { fecha: Date; texto: string; usuario: string }`, `type Detalle = { campos: CampoGuardado[]; renglones: RenglonGuardado[]; auditoria: EntradaAuditoria[] }`, `guardarExtraccionEn(e, id, extraccion: Extraccion): Promise<number>` (devuelve la confianza promedio), `obtenerDetalleEn(e, id): Promise<Detalle>`, `obtenerDetalle(id: number): Promise<Detalle>`, `guardarCampoEn(e, id, clave, valor: string | null): Promise<void>`, `auditarEn(e, id, texto): Promise<void>`

Todas las funciones vienen en par `...En(e, ...)` / sin sufijo, igual que `src/server/app/comprobantes.ts`: la variante con ejecutor explícito es la que los tests corren dentro de `conRollback`.

- [ ] **Step 1: Escribir el test que falla**

`tests/server/app/detalle.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { guardarExtraccionEn, obtenerDetalleEn, guardarCampoEn, auditarEn } from '@/server/app/detalle'
import type { Extraccion } from '@/server/ia/extraccion'

afterAll(async () => {
  await cerrarPool()
})

function extraccionDePrueba(): Extraccion {
  return {
    campos: {
      cuit: { valor: '30-71042636-9', confianza: 0.99 },
      total: { valor: '484.344,26', confianza: 0.95 },
      cae: { valor: null, confianza: 0 },
    },
    renglones: [
      { codigo: '106817', descripcion: 'MICROONDAS', cantidad: '4',
        precioUnitario: '80.745,57', importe: '322.982,28' },
    ],
  }
}

describe('guardarExtraccionEn', () => {
  it('guarda los campos con valor y los deja listos para editar', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await guardarExtraccionEn(tx, id, extraccionDePrueba())

      const d = await obtenerDetalleEn(tx, id)
      const cuit = d.campos.find((c) => c.clave === 'cuit')!
      expect(cuit.valorIA).toBe('30-71042636-9')
      // VALOR_FINAL arranca igual que VALOR_IA para que el input ya traiga
      // el valor y el operador solo corrija lo que este mal.
      expect(cuit.valorFinal).toBe('30-71042636-9')
      expect(cuit.corregido).toBe(false)
    })
  })

  it('devuelve la confianza promedio de los campos con valor', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      // cuit 0.99 y total 0.95 tienen valor; cae es null y no promedia.
      const prom = await guardarExtraccionEn(tx, id, extraccionDePrueba())
      expect(prom).toBeCloseTo(0.97, 4)
    })
  })

  it('guarda los renglones en orden', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await guardarExtraccionEn(tx, id, extraccionDePrueba())
      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones).toHaveLength(1)
      expect(d.renglones[0].orden).toBe(1)
      expect(d.renglones[0].descripcion).toBe('MICROONDAS')
    })
  })

  it('descarta claves que no estan en el catalogo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      const e = extraccionDePrueba()
      e.campos.inventado = { valor: 'x', confianza: 1 }
      await guardarExtraccionEn(tx, id, e)
      const d = await obtenerDetalleEn(tx, id)
      expect(d.campos.map((c) => c.clave)).not.toContain('inventado')
    })
  })

  it('reprocesar reemplaza lo anterior en vez de duplicar', async () => {
    // PHF_CAMPO tiene UNIQUE (COMPROBANTE_ID, CLAVE): un segundo guardado
    // sin borrar el anterior violaria la constraint.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await guardarExtraccionEn(tx, id, extraccionDePrueba())
      await guardarExtraccionEn(tx, id, extraccionDePrueba())
      const d = await obtenerDetalleEn(tx, id)
      expect(d.campos.filter((c) => c.clave === 'cuit')).toHaveLength(1)
      expect(d.renglones).toHaveLength(1)
    })
  })
})

describe('guardarCampoEn', () => {
  it('marca el campo como corregido y no toca el valor de la IA', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarExtraccionEn(tx, id, extraccionDePrueba())
      await guardarCampoEn(tx, id, 'cuit', '30-71042636-0')

      const cuit = (await obtenerDetalleEn(tx, id)).campos.find((c) => c.clave === 'cuit')!
      expect(cuit.valorFinal).toBe('30-71042636-0')
      expect(cuit.corregido).toBe(true)
      expect(cuit.valorIA).toBe('30-71042636-9')
    })
  })

  it('crea el campo si la IA no lo habia devuelto', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'condcompra', '10')
      const c = (await obtenerDetalleEn(tx, id)).campos.find((x) => x.clave === 'condcompra')!
      expect(c.valorFinal).toBe('10')
      expect(c.valorIA).toBeNull()
    })
  })

  it('rechaza una clave que no esta en el catalogo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await expect(guardarCampoEn(tx, id, 'inventado', 'x')).rejects.toThrow(/clave/i)
    })
  })
})

describe('auditarEn', () => {
  it('escribe una entrada y la devuelve en el detalle', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await auditarEn(tx, id, 'PDF importado desde carga manual')
      const d = await obtenerDetalleEn(tx, id)
      expect(d.auditoria).toHaveLength(1)
      expect(d.auditoria[0].texto).toBe('PDF importado desde carga manual')
      expect(d.auditoria[0].usuario).not.toBe('')
    })
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/server/app/detalle.test.ts`
Expected: FAIL — `Failed to resolve import "@/server/app/detalle"`

- [ ] **Step 3: Escribir `src/server/app/detalle.ts`**

```ts
import sql from 'mssql'
import { getPool } from '../db/pool'
import { esClaveValida } from '@/lib/campos'
import { usuarioActual } from '@/lib/usuario'
import type { Extraccion } from '../ia/extraccion'
import type { RenglonExtraido } from '@/lib/renglones'

export type CampoGuardado = {
  clave: string
  valorIA: string | null
  confianza: number | null
  valorFinal: string | null
  corregido: boolean
}

export type RenglonGuardado = RenglonExtraido & { orden: number }

export type EntradaAuditoria = { fecha: Date; texto: string; usuario: string }

export type Detalle = {
  campos: CampoGuardado[]
  renglones: RenglonGuardado[]
  auditoria: EntradaAuditoria[]
}

type Ejecutor = { request(): sql.Request }

/**
 * Reemplaza los campos y renglones del comprobante por los de `e` y
 * devuelve la confianza promedio de los campos que vinieron con valor.
 *
 * Borra antes de insertar: PHF_CAMPO tiene UNIQUE (COMPROBANTE_ID, CLAVE),
 * asi que reprocesar sin borrar violaria la constraint. Es tambien lo que
 * hace que reprocesar descarte las correcciones manuales, que es el
 * comportamiento que la UI advierte.
 */
export async function guardarExtraccionEn(
  e: Ejecutor,
  comprobanteId: number,
  extraccion: Extraccion,
): Promise<number> {
  await e.request().input('id', sql.Int, comprobanteId)
    .query('DELETE FROM PHF_CAMPO WHERE COMPROBANTE_ID = @id')
  await e.request().input('id', sql.Int, comprobanteId)
    .query('DELETE FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id')

  const conValor: number[] = []

  for (const [clave, campo] of Object.entries(extraccion.campos)) {
    if (!esClaveValida(clave)) continue
    if (campo.valor !== null) conValor.push(campo.confianza)

    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('clave', sql.VarChar(40), clave)
      .input('valor', sql.NVarChar(500), campo.valor)
      .input('conf', sql.Decimal(5, 4), campo.valor === null ? null : campo.confianza)
      .query(`
        INSERT INTO PHF_CAMPO (COMPROBANTE_ID, CLAVE, VALOR_IA, CONFIANZA, VALOR_FINAL)
        VALUES (@id, @clave, @valor, @conf, @valor)
      `)
  }

  let orden = 0
  for (const r of extraccion.renglones) {
    orden += 1
    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('orden', sql.Int, orden)
      .input('codigo', sql.NVarChar(60), r.codigo)
      .input('desc', sql.NVarChar(500), r.descripcion)
      .input('cant', sql.NVarChar(50), r.cantidad)
      .input('pu', sql.NVarChar(50), r.precioUnitario)
      .input('imp', sql.NVarChar(50), r.importe)
      .query(`
        INSERT INTO PHF_RENGLON
          (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA,
           CANTIDAD_IA, PRECIO_UNITARIO_IA, IMPORTE_IA)
        VALUES (@id, @orden, @codigo, @desc,
                TRY_CONVERT(DECIMAL(19,4), REPLACE(REPLACE(@cant, '.', ''), ',', '.')),
                TRY_CONVERT(DECIMAL(19,4), REPLACE(REPLACE(@pu, '.', ''), ',', '.')),
                TRY_CONVERT(DECIMAL(19,4), REPLACE(REPLACE(@imp, '.', ''), ',', '.')))
      `)
  }

  if (conValor.length === 0) return 0
  return conValor.reduce((a, b) => a + b, 0) / conValor.length
}

export async function obtenerDetalleEn(e: Ejecutor, comprobanteId: number): Promise<Detalle> {
  const r = await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .query<Record<string, unknown>>(`
      SELECT CLAVE, VALOR_IA, CONFIANZA, VALOR_FINAL, CORREGIDO_POR_USUARIO
      FROM PHF_CAMPO WHERE COMPROBANTE_ID = @id ORDER BY CLAVE;

      SELECT ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA,
             PRECIO_UNITARIO_IA, IMPORTE_IA
      FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id ORDER BY ORDEN;

      SELECT FECHA, TEXTO, USUARIO
      FROM PHF_AUDITORIA WHERE COMPROBANTE_ID = @id ORDER BY FECHA, ID;
    `)

  const [c, g, a] = r.recordsets as unknown as Record<string, unknown>[][]

  return {
    campos: c.map((x) => ({
      clave: String(x.CLAVE),
      valorIA: x.VALOR_IA === null ? null : String(x.VALOR_IA),
      confianza: x.CONFIANZA === null ? null : Number(x.CONFIANZA),
      valorFinal: x.VALOR_FINAL === null ? null : String(x.VALOR_FINAL),
      corregido: Boolean(x.CORREGIDO_POR_USUARIO),
    })),
    renglones: g.map((x) => ({
      orden: Number(x.ORDEN),
      codigo: x.CODIGO_IA === null ? null : String(x.CODIGO_IA),
      descripcion: x.DESCRIPCION_IA === null ? null : String(x.DESCRIPCION_IA),
      cantidad: x.CANTIDAD_IA === null ? null : String(x.CANTIDAD_IA),
      precioUnitario: x.PRECIO_UNITARIO_IA === null ? null : String(x.PRECIO_UNITARIO_IA),
      importe: x.IMPORTE_IA === null ? null : String(x.IMPORTE_IA),
    })),
    auditoria: a.map((x) => ({
      fecha: new Date(x.FECHA as string),
      texto: String(x.TEXTO),
      usuario: String(x.USUARIO),
    })),
  }
}

export async function obtenerDetalle(comprobanteId: number): Promise<Detalle> {
  return obtenerDetalleEn(await getPool(), comprobanteId)
}

/**
 * Escribe la corrección del operador. `VALOR_IA` no se toca nunca: es lo
 * que permite medir después qué tan bien leyó el modelo.
 */
export async function guardarCampoEn(
  e: Ejecutor,
  comprobanteId: number,
  clave: string,
  valor: string | null,
): Promise<void> {
  if (!esClaveValida(clave)) {
    throw new Error(`Clave de campo desconocida: ${clave}`)
  }

  await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .input('clave', sql.VarChar(40), clave)
    .input('valor', sql.NVarChar(500), valor)
    .query(`
      MERGE PHF_CAMPO AS destino
      USING (SELECT @id AS COMPROBANTE_ID, @clave AS CLAVE) AS origen
        ON destino.COMPROBANTE_ID = origen.COMPROBANTE_ID AND destino.CLAVE = origen.CLAVE
      WHEN MATCHED THEN
        UPDATE SET VALOR_FINAL = @valor, CORREGIDO_POR_USUARIO = 1
      WHEN NOT MATCHED THEN
        INSERT (COMPROBANTE_ID, CLAVE, VALOR_IA, CONFIANZA, VALOR_FINAL, CORREGIDO_POR_USUARIO)
        VALUES (@id, @clave, NULL, NULL, @valor, 1);
    `)
}

export async function auditarEn(
  e: Ejecutor,
  comprobanteId: number,
  texto: string,
): Promise<void> {
  await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .input('texto', sql.NVarChar(500), texto)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      INSERT INTO PHF_AUDITORIA (COMPROBANTE_ID, TEXTO, USUARIO)
      VALUES (@id, @texto, @usuario)
    `)
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/app/detalle.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/app/detalle.ts tests/server/app/detalle.test.ts
git commit -m "$(cat <<'EOF'
guardar y leer campos, renglones y auditoria

VALOR_FINAL arranca igual que VALOR_IA para que el input ya traiga el
valor. VALOR_IA no se toca nunca: es lo que despues permite medir que tan
bien leyo el modelo, contra CORREGIDO_POR_USUARIO.

Guardar borra antes de insertar, porque PHF_CAMPO tiene UNIQUE
(COMPROBANTE_ID, CLAVE) y reprocesar violaria la constraint. Eso es
tambien lo que hace que reprocesar descarte las correcciones manuales.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Guardado del PDF en disco

**Files:**
- Create: `src/server/app/archivos.ts`
- Test: `tests/server/app/archivos.test.ts`

**Interfaces:**
- Consumes: nada del proyecto
- Produces: `directorioStorage(): string`, `guardarPdf(nombre: string, datos: Buffer): Promise<{ ruta: string; hash: string }>`, `leerPdf(ruta: string): Promise<Buffer>`

- [ ] **Step 1: Escribir el test que falla**

`tests/server/app/archivos.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { guardarPdf, leerPdf, directorioStorage } from '@/server/app/archivos'

const creados: string[] = []

afterAll(async () => {
  for (const r of creados) await rm(r, { force: true })
})

describe('guardarPdf', () => {
  it('guarda el archivo y devuelve su hash sha-256', async () => {
    const datos = Buffer.from('%PDF-1.4 contenido de prueba')
    const { ruta, hash } = await guardarPdf('factura.pdf', datos)
    creados.push(ruta)

    expect(hash).toBe(createHash('sha256').update(datos).digest('hex'))
    expect(hash).toHaveLength(64)
    expect(await leerPdf(ruta)).toEqual(datos)
  })

  it('no pisa un archivo anterior con el mismo nombre', async () => {
    const a = await guardarPdf('igual.pdf', Buffer.from('primero'))
    const b = await guardarPdf('igual.pdf', Buffer.from('segundo'))
    creados.push(a.ruta, b.ruta)

    expect(a.ruta).not.toBe(b.ruta)
    expect((await leerPdf(a.ruta)).toString()).toBe('primero')
    expect((await leerPdf(b.ruta)).toString()).toBe('segundo')
  })

  it('no deja que el nombre del archivo escape del directorio', async () => {
    const { ruta } = await guardarPdf('../../evadido.pdf', Buffer.from('x'))
    creados.push(ruta)
    expect(ruta.startsWith(directorioStorage())).toBe(true)
    expect(ruta).not.toContain('..')
  })

  it('conserva la extension pdf aunque el nombre venga sin ella', async () => {
    const { ruta } = await guardarPdf('sin_extension', Buffer.from('x'))
    creados.push(ruta)
    expect(ruta.endsWith('.pdf')).toBe(true)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/server/app/archivos.test.ts`
Expected: FAIL — `Failed to resolve import "@/server/app/archivos"`

- [ ] **Step 3: Escribir `src/server/app/archivos.ts`**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

/**
 * Los PDFs no van a la base: inflarian los backups del ERP. Van a una
 * carpeta en disco, que ya esta en .gitignore.
 */
export function directorioStorage(): string {
  return path.resolve(process.env.STORAGE_DIR || path.join(process.cwd(), 'storage'))
}

/**
 * Se queda solo con el nombre base y le saca todo lo que no sea seguro en
 * un nombre de archivo de Windows. `nombre` viene del navegador: es dato
 * de usuario, y sin esto un "../../algo" escribiria fuera del directorio.
 */
function nombreSeguro(nombre: string): string {
  const base = path.basename(nombre).replace(/[^A-Za-z0-9._-]/g, '_')
  const limpio = base.replace(/^\.+/, '').slice(0, 120)
  if (limpio === '') return 'comprobante.pdf'
  return limpio.toLowerCase().endsWith('.pdf') ? limpio : `${limpio}.pdf`
}

export async function guardarPdf(
  nombre: string,
  datos: Buffer,
): Promise<{ ruta: string; hash: string }> {
  const dir = directorioStorage()
  await mkdir(dir, { recursive: true })

  // El prefijo unico evita que dos comprobantes con el mismo nombre de
  // archivo se pisen -- pasa seguido: "factura.pdf" de dos proveedores.
  const ruta = path.join(dir, `${randomUUID()}-${nombreSeguro(nombre)}`)
  await writeFile(ruta, datos)

  return { ruta, hash: createHash('sha256').update(datos).digest('hex') }
}

export async function leerPdf(ruta: string): Promise<Buffer> {
  const resuelta = path.resolve(ruta)
  const dir = directorioStorage()
  // Defensa en profundidad: la ruta sale de la base, pero si alguna vez
  // llegara manipulada, esto la corta antes de leer.
  if (resuelta !== dir && !resuelta.startsWith(dir + path.sep)) {
    throw new Error('Ruta de archivo fuera del directorio de comprobantes.')
  }
  return readFile(resuelta)
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/app/archivos.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/app/archivos.ts tests/server/app/archivos.test.ts
git commit -m "$(cat <<'EOF'
guardar los PDF en disco con hash y nombre seguro

El nombre del archivo viene del navegador, asi que es dato de usuario:
se toma solo el basename y se filtra. Cada archivo lleva un prefijo unico
porque dos proveedores mandan "factura.pdf" el mismo dia.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: La cola

**Files:**
- Create: `src/server/app/cola.ts`
- Test: `tests/server/app/cola.test.ts`

**Interfaces:**
- Consumes: `extraerDePdf` de `@/server/ia/extraccion`; `guardarExtraccionEn`, `guardarCampoEn`, `auditarEn` de `./detalle`; `leerPdf` de `./archivos`; `buscarProveedorPorCuit` de `@/server/tango/proveedores`; `normalizarCuit` de `@/lib/formato`
- Produces: `MAX_INTENTOS = 3`, `MINUTOS_REPESCA = 10`, `CONCURRENCIA = 3`, `type Pendiente = { id: number; ruta: string }`, `tomarPendientesEn(e, limite): Promise<Pendiente[]>`, `marcarLeidoEn(e, id, confianzaPromedio, ms, modelo, campos): Promise<void>`, `marcarFalloEn(e, id, error): Promise<void>`, `resolverProveedorEn(e, id, cuit): Promise<void>`, `procesarUno(p: Pendiente): Promise<void>`, `arrancarWorker(): void`, `despertarWorker(): void`

- [ ] **Step 1: Escribir el test que falla**

`tests/server/app/cola.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import {
  tomarPendientesEn,
  marcarLeidoEn,
  marcarFalloEn,
  resolverProveedorEn,
  desnormalizarBandejaEn,
  MAX_INTENTOS,
} from '@/server/app/cola'
import { obtenerDetalleEn } from '@/server/app/detalle'
import { getPool } from '@/server/db/pool'

afterAll(async () => {
  await cerrarPool()
})

async function estadoDe(tx: sql.Transaction, id: number) {
  const r = await tx.request().input('id', sql.Int, id).query(`
    SELECT ESTADO, INTENTOS, ERROR_MENSAJE, CONFIANZA_PROMEDIO,
           EXTRACCION_MS, EXTRACCION_MODELO
    FROM PHF_COMPROBANTE WHERE ID = @id
  `)
  return r.recordset[0]
}

describe('tomarPendientesEn', () => {
  it('toma un comprobante recien encolado', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      const tomados = await tomarPendientesEn(tx, 50)
      expect(tomados.map((x) => x.id)).toContain(id)
    })
  })

  it('no toma comprobantes que no estan en procesando', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const tomados = await tomarPendientesEn(tx, 50)
      expect(tomados.map((x) => x.id)).not.toContain(id)
    })
  })

  it('no toma uno que ya agoto los intentos', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await tx.request().input('id', sql.Int, id).input('n', sql.Int, MAX_INTENTOS)
        .query('UPDATE PHF_COMPROBANTE SET INTENTOS = @n WHERE ID = @id')
      const tomados = await tomarPendientesEn(tx, 50)
      expect(tomados.map((x) => x.id)).not.toContain(id)
    })
  })

  it('respeta el limite pedido', async () => {
    await conRollback(async (tx) => {
      for (let i = 0; i < 4; i++) {
        await insertarComprobantePrueba(tx, { estado: 'procesando' })
      }
      expect((await tomarPendientesEn(tx, 2)).length).toBe(2)
    })
  })
})

describe('marcarLeidoEn', () => {
  it('pasa a leido con la metrica de la extraccion', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await marcarLeidoEn(tx, id, 0.97, 2400, 'claude-opus-5', 21)

      const c = await estadoDe(tx, id)
      expect(c.ESTADO).toBe('leido')
      expect(Number(c.CONFIANZA_PROMEDIO)).toBeCloseTo(0.97, 4)
      expect(c.EXTRACCION_MS).toBe(2400)
      expect(c.EXTRACCION_MODELO).toBe('claude-opus-5')
      expect(c.ERROR_MENSAJE).toBeNull()
    })
  })

  it('escribe la entrada de auditoria de la lectura', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await marcarLeidoEn(tx, id, 0.97, 2400, 'claude-opus-5', 21)
      const d = await obtenerDetalleEn(tx, id)
      expect(d.auditoria.some((a) => a.texto.includes('21'))).toBe(true)
    })
  })
})

describe('desnormalizarBandejaEn', () => {
  it('copia a la tabla los campos que muestra la bandeja', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await desnormalizarBandejaEn(tx, id, {
        campos: {
          tipo: { valor: 'FAC A', confianza: 1 },
          ptovta: { valor: '0011', confianza: 1 },
          nro: { valor: '00063576', confianza: 1 },
          cuit: { valor: '30-71042636-9', confianza: 1 },
          total: { valor: '484.344,26', confianza: 1 },
          fecha: { valor: '18/05/2026', confianza: 1 },
        },
        renglones: [],
      })

      const r = await tx.request().input('id', sql.Int, id).query(`
        SELECT TIPO, PUNTO_VENTA, NUMERO, CUIT, TOTAL, FECHA_EMISION
        FROM PHF_COMPROBANTE WHERE ID = @id
      `)
      const c = r.recordset[0]
      expect(c.TIPO).toBe('FAC A')
      expect(c.NUMERO).toBe('00063576')
      expect(Number(c.TOTAL)).toBeCloseTo(484344.26, 2)
      // useUTC: false hace que la fecha vuelva en hora local. Si esto
      // empieza a dar 17, se rompio esa config del pool.
      expect(new Date(c.FECHA_EMISION).getDate()).toBe(18)
    })
  })

  it('deja NULL el total y la fecha si la IA leyo algo que no parsea', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await desnormalizarBandejaEn(tx, id, {
        campos: {
          total: { valor: 'ilegible', confianza: 0.1 },
          fecha: { valor: 'no es una fecha', confianza: 0.1 },
        },
        renglones: [],
      })

      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT TOTAL, FECHA_EMISION FROM PHF_COMPROBANTE WHERE ID = @id')
      expect(r.recordset[0].TOTAL).toBeNull()
      expect(r.recordset[0].FECHA_EMISION).toBeNull()
    })
  })
})

describe('resolverProveedorEn', () => {
  it('completa el codigo de proveedor a partir del CUIT extraido', async () => {
    // Se descubre un CUIT real de CPA01 en vez de hardcodearlo.
    const pool = await getPool()
    const p = await pool.request().query(`
      SELECT TOP 1 LTRIM(RTRIM(COD_PROVEE)) AS cod, LTRIM(RTRIM(N_CUIT)) AS cuit
      FROM CPA01
      WHERE LEN(REPLACE(REPLACE(ISNULL(N_CUIT,''), '-', ''), ' ', '')) = 11
      ORDER BY COD_PROVEE
    `)
    const real = p.recordset[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await resolverProveedorEn(tx, id, String(real.cuit))

      const d = await obtenerDetalleEn(tx, id)
      expect(d.campos.find((c) => c.clave === 'codprovee')!.valorFinal).toBe(String(real.cod))

      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT COD_PROVEE FROM PHF_COMPROBANTE WHERE ID = @id')
      expect(String(r.recordset[0].COD_PROVEE)).toBe(String(real.cod))
    })
  })

  it('no escribe nada cuando el CUIT no matchea ningun proveedor', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await resolverProveedorEn(tx, id, '99-99999999-9')
      const d = await obtenerDetalleEn(tx, id)
      expect(d.campos.find((c) => c.clave === 'codprovee')).toBeUndefined()
    })
  })

  it('no rompe cuando la IA no leyo el CUIT', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await expect(resolverProveedorEn(tx, id, null)).resolves.toBeUndefined()
    })
  })
})

describe('marcarFalloEn', () => {
  it('suma un intento y lo deja en procesando si quedan reintentos', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await marcarFalloEn(tx, id, 'timeout')

      const c = await estadoDe(tx, id)
      expect(c.INTENTOS).toBe(1)
      expect(c.ESTADO).toBe('procesando')
      expect(c.ERROR_MENSAJE).toBe('timeout')
    })
  })

  it('pasa a error cuando se agotan los intentos', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      for (let i = 0; i < MAX_INTENTOS; i++) await marcarFalloEn(tx, id, 'timeout')

      const c = await estadoDe(tx, id)
      expect(c.INTENTOS).toBe(MAX_INTENTOS)
      expect(c.ESTADO).toBe('error')
    })
  })

  it('deja la entrada de auditoria del fallo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await marcarFalloEn(tx, id, 'PDF ilegible')
      const d = await obtenerDetalleEn(tx, id)
      expect(d.auditoria.some((a) => a.texto.includes('PDF ilegible'))).toBe(true)
    })
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/server/app/cola.test.ts`
Expected: FAIL — `Failed to resolve import "@/server/app/cola"`

- [ ] **Step 3: Escribir `src/server/app/cola.ts`**

```ts
import sql from 'mssql'
import { getPool } from '../db/pool'
import { conTransaccion } from '../db/tx'
import { extraerDePdf, type Extraccion } from '../ia/extraccion'
import { buscarProveedorPorCuit } from '../tango/proveedores'
import { normalizarCuit } from '@/lib/formato'
import { guardarExtraccionEn, guardarCampoEn, auditarEn } from './detalle'
import { leerPdf } from './archivos'

export const MAX_INTENTOS = 3
export const MINUTOS_REPESCA = 10
export const CONCURRENCIA = 3
const INTERVALO_MS = 2 * 60 * 1000

type Ejecutor = { request(): sql.Request }

export type Pendiente = { id: number; ruta: string }

/**
 * Los comprobantes que hay que extraer: los recien encolados y los que
 * quedaron colgados en `procesando`. Un comprobante queda colgado cuando
 * el server se reinicia o se cae en medio de la extraccion; sin la
 * repesca se quedaria ahi para siempre.
 *
 * La ventana de repesca se mide contra FECHA_MODIF, que se toca en cada
 * intento, y no contra FECHA_ALTA: si no, un comprobante en su tercer
 * intento se repescaria de inmediato.
 */
export async function tomarPendientesEn(e: Ejecutor, limite: number): Promise<Pendiente[]> {
  const r = await e
    .request()
    .input('lim', sql.Int, limite)
    .input('max', sql.Int, MAX_INTENTOS)
    .input('min', sql.Int, MINUTOS_REPESCA)
    .query<Record<string, unknown>>(`
      SELECT TOP (@lim) ID, ARCHIVO_RUTA
      FROM PHF_COMPROBANTE
      WHERE ESTADO = 'procesando'
        AND INTENTOS < @max
        AND (FECHA_MODIF IS NULL OR FECHA_MODIF < DATEADD(MINUTE, -@min, SYSDATETIME()))
      ORDER BY FECHA_ALTA
    `)

  return r.recordset.map((x) => ({ id: Number(x.ID), ruta: String(x.ARCHIVO_RUTA) }))
}

export async function marcarLeidoEn(
  e: Ejecutor,
  id: number,
  confianzaPromedio: number,
  ms: number,
  modelo: string,
  campos: number,
): Promise<void> {
  await e
    .request()
    .input('id', sql.Int, id)
    .input('conf', sql.Decimal(5, 4), confianzaPromedio)
    .input('ms', sql.Int, ms)
    .input('modelo', sql.VarChar(40), modelo)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO = 'leido',
          CONFIANZA_PROMEDIO = @conf,
          EXTRACCION_MS = @ms,
          EXTRACCION_MODELO = @modelo,
          ERROR_MENSAJE = NULL,
          FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id
    `)

  const seg = (ms / 1000).toFixed(1).replace('.', ',')
  await auditarEn(e, id, `Lectura automática con IA — ${campos} campos en ${seg} s`)
}

/**
 * Suma un intento. Si quedan reintentos lo deja en `procesando` para que
 * la repesca lo vuelva a tomar; si se agotaron, lo pasa a `error`.
 */
export async function marcarFalloEn(e: Ejecutor, id: number, error: string): Promise<void> {
  await e
    .request()
    .input('id', sql.Int, id)
    .input('err', sql.NVarChar(1000), error.slice(0, 1000))
    .input('max', sql.Int, MAX_INTENTOS)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET INTENTOS = INTENTOS + 1,
          ERROR_MENSAJE = @err,
          ESTADO = CASE WHEN INTENTOS + 1 >= @max THEN 'error' ELSE 'procesando' END,
          FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id
    `)

  await auditarEn(e, id, `Falló la lectura automática: ${error}`.slice(0, 500))
}

/**
 * Copia a las columnas de `PHF_COMPROBANTE` los campos que la bandeja
 * muestra. Sin esto la bandeja quedaría con las columnas vacías: la
 * bandeja lee de la tabla, no de PHF_CAMPO, para no hacer 21 joins por
 * fila con 100 comprobantes en pantalla.
 *
 * El total y la fecha se convierten acá porque las columnas son
 * DECIMAL(19,4) y DATE. `TRY_CONVERT` deja NULL si la IA leyó algo que no
 * parsea, en vez de hacer fallar toda la extracción por un campo.
 */
export async function desnormalizarBandejaEn(
  e: Ejecutor,
  id: number,
  extraccion: Extraccion,
): Promise<void> {
  const v = (clave: string) => extraccion.campos[clave]?.valor ?? null

  await e
    .request()
    .input('id', sql.Int, id)
    .input('tipo', sql.VarChar(10), v('tipo')?.slice(0, 10) ?? null)
    .input('pv', sql.VarChar(10), v('ptovta')?.slice(0, 10) ?? null)
    .input('nro', sql.VarChar(20), v('nro')?.slice(0, 20) ?? null)
    .input('cuit', sql.VarChar(15), v('cuit')?.slice(0, 15) ?? null)
    .input('total', sql.NVarChar(50), v('total'))
    .input('fecha', sql.NVarChar(20), v('fecha'))
    .query(`
      UPDATE PHF_COMPROBANTE
      SET TIPO = @tipo,
          PUNTO_VENTA = @pv,
          NUMERO = @nro,
          CUIT = @cuit,
          TOTAL = TRY_CONVERT(DECIMAL(19,4), REPLACE(REPLACE(@total, '.', ''), ',', '.')),
          FECHA_EMISION = TRY_CONVERT(DATE, @fecha, 103)
      WHERE ID = @id
    `)
}

/**
 * Busca el proveedor de Tango por el CUIT que leyó la IA y deja el código
 * en el campo `codprovee` y en la columna de bandeja. Si no matchea, no
 * escribe nada: la validación bloqueante y la resolución de CUIT
 * duplicados son de la Fase 3.
 *
 * Es el único punto de la app fuera de src/server/tango/ que necesita un
 * dato del ERP, y lo pide por la función de esa capa: no emite SQL contra
 * CPA01 ni la nombra.
 */
export async function resolverProveedorEn(
  e: Ejecutor,
  id: number,
  cuit: string | null,
): Promise<void> {
  if (!cuit || !normalizarCuit(cuit)) return

  const proveedor = await buscarProveedorPorCuit(cuit)
  if (!proveedor) return

  await guardarCampoEn(e, id, 'codprovee', proveedor.codProvee)

  await e
    .request()
    .input('id', sql.Int, id)
    .input('cod', sql.VarChar(20), proveedor.codProvee)
    .input('razon', sql.NVarChar(200), proveedor.razonSocial)
    .query(`
      UPDATE PHF_COMPROBANTE SET COD_PROVEE = @cod, RAZON_SOCIAL = @razon WHERE ID = @id
    `)
}

/** Extrae un comprobante y deja el resultado en la base. No lanza. */
export async function procesarUno({ id, ruta }: Pendiente): Promise<void> {
  try {
    const pdf = await leerPdf(ruta)
    const r = await extraerDePdf(pdf)

    if (!r.ok) {
      await conTransaccion((tx) => marcarFalloEn(tx, id, r.error))
      return
    }

    await conTransaccion(async (tx) => {
      const prom = await guardarExtraccionEn(tx, id, r.extraccion)
      await desnormalizarBandejaEn(tx, id, r.extraccion)
      await resolverProveedorEn(tx, id, r.extraccion.campos.cuit?.valor ?? null)
      const conValor = Object.values(r.extraccion.campos).filter((c) => c.valor !== null).length
      await marcarLeidoEn(tx, id, prom, r.ms, r.modelo, conValor)
    })
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err)
    await conTransaccion((tx) => marcarFalloEn(tx, id, mensaje)).catch(() => {})
  }
}

let corriendo = false
let temporizador: ReturnType<typeof setInterval> | null = null

async function tanda(): Promise<void> {
  if (corriendo) return
  corriendo = true
  try {
    const pendientes = await tomarPendientesEn(await getPool(), CONCURRENCIA)
    await Promise.all(pendientes.map(procesarUno))
  } catch {
    // Si la base no responde, la proxima tanda reintenta.
  } finally {
    corriendo = false
  }
}

/**
 * Worker en proceso. Es suficiente para una app de red interna con un
 * operador. Si en algun momento hay mas de una instancia, `tomarPendientes`
 * necesita un lock para que dos no tomen el mismo comprobante.
 */
export function arrancarWorker(): void {
  if (temporizador) return
  temporizador = setInterval(() => void tanda(), INTERVALO_MS)
  void tanda()
}

/** Despierta al worker sin esperar al intervalo. Se llama al importar. */
export function despertarWorker(): void {
  void tanda()
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/app/cola.test.ts`
Expected: PASS — 14 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/app/cola.ts tests/server/app/cola.test.ts
git commit -m "$(cat <<'EOF'
agregar la cola de extraccion con repesca

La subida encola y devuelve; un worker en proceso toma de a 3. Cada dos
minutos repesca lo que quedo en 'procesando' hace mas de 10, que es lo
que pasa cuando el server se reinicia en medio de una extraccion.

La ventana de repesca se mide contra FECHA_MODIF y no contra FECHA_ALTA:
midiendola contra el alta, un comprobante en su tercer intento se
repescaria de inmediato.

Al terminar la extraccion se copian a PHF_COMPROBANTE los campos que la
bandeja muestra -- la bandeja lee de la tabla, no de PHF_CAMPO, para no
hacer 21 joins por fila -- y se resuelve el proveedor por CUIT contra
Tango. Ese lookup va por la funcion de src/server/tango/: la cola no
nombra CPA01 ni emite SQL contra el ERP.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Importación desde la UI

**Files:**
- Create: `src/server/app/acciones.ts`
- Create: `src/components/bandeja/importar.tsx`
- Create: `src/components/bandeja/importar.module.css`
- Modify: `src/app/comprobantes/page.tsx`
- Test: `tests/server/app/acciones.test.ts`

**Interfaces:**
- Consumes: `guardarPdf` de `./archivos`; `auditarEn` de `./detalle`; `despertarWorker` de `./cola`
- Produces: `importarComprobanteEn(e, nombre, datos): Promise<number>`, y las server actions `importarComprobantes(fd: FormData)`, `guardarCampo(id, clave, valor)`, `confirmarComprobante(id)`, `reprocesarComprobante(id)`

- [ ] **Step 1: Escribir el test que falla**

`tests/server/app/acciones.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { rm } from 'node:fs/promises'
import { conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'
import { importarComprobanteEn } from '@/server/app/acciones'
import { obtenerDetalleEn } from '@/server/app/detalle'

const creados: string[] = []

afterAll(async () => {
  for (const r of creados) await rm(r, { force: true })
  await cerrarPool()
})

const PDF = Buffer.from('%PDF-1.4 de prueba')

describe('importarComprobanteEn', () => {
  it('crea el comprobante en procesando', async () => {
    await conRollback(async (tx) => {
      const id = await importarComprobanteEn(tx, 'factura.pdf', PDF)
      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT ESTADO, ARCHIVO_NOMBRE, ARCHIVO_HASH, ARCHIVO_RUTA, INTENTOS FROM PHF_COMPROBANTE WHERE ID = @id')
      const c = r.recordset[0]
      creados.push(String(c.ARCHIVO_RUTA))

      expect(c.ESTADO).toBe('procesando')
      expect(c.ARCHIVO_NOMBRE).toBe('factura.pdf')
      expect(String(c.ARCHIVO_HASH)).toHaveLength(64)
      expect(c.INTENTOS).toBe(0)
    })
  })

  it('deja la entrada de auditoria de la importacion', async () => {
    await conRollback(async (tx) => {
      const id = await importarComprobanteEn(tx, 'factura.pdf', PDF)
      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT ARCHIVO_RUTA FROM PHF_COMPROBANTE WHERE ID = @id')
      creados.push(String(r.recordset[0].ARCHIVO_RUTA))

      const d = await obtenerDetalleEn(tx, id)
      expect(d.auditoria[0].texto).toBe('PDF importado desde carga manual')
    })
  })

  it('permite importar dos veces el mismo PDF', async () => {
    // La deteccion de duplicados es de la Fase 3 y va por proveedor + tipo
    // + numero, no por hash del archivo. Importar dos veces no se bloquea.
    await conRollback(async (tx) => {
      const a = await importarComprobanteEn(tx, 'factura.pdf', PDF)
      const b = await importarComprobanteEn(tx, 'factura.pdf', PDF)
      expect(a).not.toBe(b)

      for (const id of [a, b]) {
        const r = await tx.request().input('id', sql.Int, id)
          .query('SELECT ARCHIVO_RUTA FROM PHF_COMPROBANTE WHERE ID = @id')
        creados.push(String(r.recordset[0].ARCHIVO_RUTA))
      }
    })
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/server/app/acciones.test.ts`
Expected: FAIL — `Failed to resolve import "@/server/app/acciones"`

- [ ] **Step 3: Escribir `src/server/app/acciones.ts`**

```ts
'use server'

import sql from 'mssql'
import { revalidatePath } from 'next/cache'
import { getPool } from '../db/pool'
import { conTransaccion } from '../db/tx'
import { guardarPdf } from './archivos'
import { auditarEn, guardarCampoEn } from './detalle'
import { despertarWorker } from './cola'
import { usuarioActual } from '@/lib/usuario'

type Ejecutor = { request(): sql.Request }

const MAX_BYTES = 10 * 1024 * 1024
const MAX_ARCHIVOS = 50

export async function importarComprobanteEn(
  e: Ejecutor,
  nombre: string,
  datos: Buffer,
): Promise<number> {
  const { ruta, hash } = await guardarPdf(nombre, datos)

  const r = await e
    .request()
    .input('nombre', sql.NVarChar(260), nombre.slice(0, 260))
    .input('ruta', sql.NVarChar(500), ruta)
    .input('hash', sql.Char(64), hash)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      INSERT INTO PHF_COMPROBANTE
        (ARCHIVO_NOMBRE, ARCHIVO_RUTA, ARCHIVO_HASH, ESTADO, USUARIO_ALTA)
      OUTPUT INSERTED.ID
      VALUES (@nombre, @ruta, @hash, 'procesando', @usuario)
    `)

  const id = Number(r.recordset[0].ID)
  await auditarEn(e, id, 'PDF importado desde carga manual')
  return id
}

export async function importarComprobantes(fd: FormData): Promise<{ importados: number }> {
  const archivos = fd.getAll('archivos').filter((x): x is File => x instanceof File)
  if (archivos.length === 0) return { importados: 0 }
  if (archivos.length > MAX_ARCHIVOS) {
    throw new Error(`No se pueden importar más de ${MAX_ARCHIVOS} archivos por vez.`)
  }

  let importados = 0
  for (const archivo of archivos) {
    if (archivo.size > MAX_BYTES) {
      throw new Error(`${archivo.name} supera los 10 MB.`)
    }
    const datos = Buffer.from(await archivo.arrayBuffer())
    await conTransaccion((tx) => importarComprobanteEn(tx, archivo.name, datos))
    importados += 1
  }

  // La extraccion no espera al intervalo del worker.
  despertarWorker()
  revalidatePath('/comprobantes')
  return { importados }
}

export async function guardarCampo(id: number, clave: string, valor: string): Promise<void> {
  const pool = await getPool()
  await guardarCampoEn(pool, id, clave, valor.trim() === '' ? null : valor)
  await pool.request().input('id', sql.Int, id).input('u', sql.NVarChar(60), usuarioActual())
    .query('UPDATE PHF_COMPROBANTE SET FECHA_MODIF = SYSDATETIME(), USUARIO_MODIF = @u WHERE ID = @id')
}

export async function confirmarComprobante(id: number): Promise<void> {
  await conTransaccion(async (tx) => {
    // Solo desde `leido` u `observacion`. El WHERE es lo que evita que dos
    // pestañas abiertas confirmen dos veces o que se confirme algo ya
    // registrado, que es terminal.
    const r = await tx.request().input('id', sql.Int, id).query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO = 'confirmado', FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id AND ESTADO IN ('leido', 'observacion')
    `)
    if (r.rowsAffected[0] === 0) {
      throw new Error('El comprobante no está en un estado que permita confirmarlo.')
    }
    await auditarEn(tx, id, 'Datos confirmados por el operador')
  })

  revalidatePath('/comprobantes')
  revalidatePath(`/comprobantes/${id}`)
}

export async function reprocesarComprobante(id: number): Promise<void> {
  await conTransaccion(async (tx) => {
    const r = await tx.request().input('id', sql.Int, id).query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO = 'procesando', INTENTOS = 0, ERROR_MENSAJE = NULL,
          FECHA_MODIF = NULL
      WHERE ID = @id AND ESTADO <> 'registrado'
    `)
    if (r.rowsAffected[0] === 0) {
      throw new Error('Un comprobante registrado en Tango no se puede reprocesar.')
    }
    await auditarEn(tx, id, 'Reproceso pedido por el operador')
  })

  despertarWorker()
  revalidatePath('/comprobantes')
  revalidatePath(`/comprobantes/${id}`)
}
```

Nota: `FECHA_MODIF = NULL` en el reproceso es a propósito — es lo que hace que `tomarPendientesEn` lo tome de inmediato en vez de esperar la ventana de repesca.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/server/app/acciones.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Escribir el modal de importación**

`src/components/bandeja/importar.tsx` — componente cliente con dropzone, lista de archivos y estado por archivo. Medidas de `design/README.md` §3: caja 620px, radio 12px, padding 24px; dropzone con borde `1.5px dashed #c9c6c0`, radio 10px, padding 34px, fondo `#faf9f7`, hover `border-color: #2b4fd0` y fondo `#f4f6fd`.

```tsx
'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { importarComprobantes } from '@/server/app/acciones'
import styles from './importar.module.css'

export function BotonImportar() {
  const [abierto, setAbierto] = useState(false)
  return (
    <>
      <button type="button" className={styles.primario} onClick={() => setAbierto(true)}>
        + Importar PDF
      </button>
      {abierto && <ModalImportar onCerrar={() => setAbierto(false)} />}
    </>
  )
}

function ModalImportar({ onCerrar }: { onCerrar: () => void }) {
  const [archivos, setArchivos] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pendiente, arrancar] = useTransition()
  const input = useRef<HTMLInputElement>(null)
  const router = useRouter()

  function agregar(lista: FileList | null) {
    if (!lista) return
    const pdfs = Array.from(lista).filter((f) => f.type === 'application/pdf')
    setArchivos((a) => [...a, ...pdfs].slice(0, 50))
    setError(pdfs.length === lista.length ? null : 'Se ignoraron archivos que no son PDF.')
  }

  function importar() {
    if (archivos.length === 0) return
    const fd = new FormData()
    for (const a of archivos) fd.append('archivos', a)

    arrancar(async () => {
      try {
        await importarComprobantes(fd)
        onCerrar()
        router.push('/comprobantes?filtro=leido')
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudieron importar los archivos.')
      }
    })
  }

  return (
    <div className={styles.overlay} onClick={onCerrar}>
      <div className={styles.caja} onClick={(e) => e.stopPropagation()}>
        <div className={styles.encabezado}>
          <h2 className={styles.titulo}>Importar comprobantes</h2>
          <button type="button" className={styles.cerrar} onClick={onCerrar} aria-label="Cerrar">
            ✕
          </button>
        </div>

        <div
          className={styles.dropzone}
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            agregar(e.dataTransfer.files)
          }}
        >
          <div className={styles.icono}>⇪</div>
          <div className={styles.dzTitulo}>Arrastrá los PDF acá</div>
          <div className={styles.dzDetalle}>
            o hacé clic para elegirlos · hasta 50 archivos · PDF, máx. 10 MB c/u
          </div>
        </div>

        <input
          ref={input}
          type="file"
          accept="application/pdf"
          multiple
          hidden
          onChange={(e) => agregar(e.target.files)}
        />

        {archivos.map((a, i) => (
          <div key={`${a.name}-${i}`} className={styles.fila}>
            <span className={styles.etiqueta}>PDF</span>
            <span className={styles.nombre}>{a.name}</span>
            <span className={styles.estado}>{pendiente ? 'Subiendo…' : 'Listo para importar'}</span>
          </div>
        ))}

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.acciones}>
          <button type="button" className={styles.secundario} onClick={onCerrar} disabled={pendiente}>
            Cancelar
          </button>
          <button
            type="button"
            className={styles.primario}
            onClick={importar}
            disabled={pendiente || archivos.length === 0}
          >
            {pendiente ? 'Importando…' : `Importar ${archivos.length || ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
```

`src/components/bandeja/importar.module.css` con las medidas del README §3 y la animación `riseIn` de 180 ms.

- [ ] **Step 6: Cablear el botón en la bandeja**

En `src/app/comprobantes/page.tsx`, reemplazar el botón deshabilitado:

```tsx
          <BotonImportar />
```

Y agregar el import:

```tsx
import { BotonImportar } from '@/components/bandeja/importar'
```

- [ ] **Step 7: Agregar el polling mientras haya algo en procesando**

Componente cliente `src/components/bandeja/refresco.tsx`:

```tsx
'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Refresca la bandeja mientras haya comprobantes en extracción. Se apaga
 * solo cuando no queda ninguno: no tiene sentido hacer polling contra la
 * base cada 3 segundos con la bandeja quieta.
 */
export function RefrescoAutomatico({ procesando }: { procesando: number }) {
  const router = useRouter()

  useEffect(() => {
    if (procesando === 0) return
    const t = setInterval(() => router.refresh(), 3000)
    return () => clearInterval(t)
  }, [procesando, router])

  return null
}
```

Y en la página, después de `<Tabla />`:

```tsx
        <RefrescoAutomatico procesando={conteos.procesando} />
```

- [ ] **Step 8: Verificar en el navegador**

Levantar el dev server, abrir `/comprobantes`, importar un PDF real de comprobante. Verificar: aparece en la bandeja como "Procesando IA", y a los pocos segundos pasa solo a "Pendiente de revisión" con su confianza.

- [ ] **Step 9: Commit**

```bash
git add src/server/app/acciones.ts src/components/bandeja tests/server/app/acciones.test.ts src/app/comprobantes/page.tsx
git commit -m "$(cat <<'EOF'
agregar la importacion de PDF desde la bandeja

La subida guarda el archivo, encola en 'procesando' y devuelve. La
bandeja se refresca sola cada 3 segundos mientras quede algo en
extraccion, y deja de hacerlo cuando no queda nada.

Importar dos veces el mismo PDF no se bloquea: la deteccion de duplicados
es de la Fase 3 y va por proveedor + tipo + numero, que es el criterio del
negocio, no por hash del archivo.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: El visor de PDF

**Files:**
- Create: `src/app/api/pdf/[id]/route.ts`
- Create: `src/components/revision/visor.tsx`
- Create: `src/components/revision/visor.module.css`

**Interfaces:**
- Consumes: `leerPdf` de `@/server/app/archivos`
- Produces: `<Visor id={number} nombre={string} resaltar={string | null} />`, y `GET /api/pdf/:id`

- [ ] **Step 1: Instalar pdf.js**

```bash
pnpm add pdfjs-dist
```

- [ ] **Step 2: Escribir el route handler**

`src/app/api/pdf/[id]/route.ts`:

```ts
import sql from 'mssql'
import { getPool } from '@/server/db/pool'
import { leerPdf } from '@/server/app/archivos'

/**
 * Sirve el PDF de un comprobante. No va en `public/`: los comprobantes
 * son documentos comerciales de la empresa, no archivos publicos. La ruta
 * en disco se lee de la base y nunca llega desde el cliente.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) {
    return new Response('Id inválido', { status: 400 })
  }

  const pool = await getPool()
  const r = await pool
    .request()
    .input('id', sql.Int, n)
    .query('SELECT ARCHIVO_RUTA, ARCHIVO_NOMBRE FROM PHF_COMPROBANTE WHERE ID = @id')

  if (r.recordset.length === 0) return new Response('No encontrado', { status: 404 })

  try {
    const pdf = await leerPdf(String(r.recordset[0].ARCHIVO_RUTA))
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${String(r.recordset[0].ARCHIVO_NOMBRE).replace(/"/g, '')}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return new Response('El archivo no está disponible', { status: 404 })
  }
}
```

- [ ] **Step 3: Escribir el visor**

`src/components/revision/visor.tsx` — componente cliente. Renderiza cada página en un `<canvas>` y superpone la capa de texto en un `<div>` posicionado, que es lo que después permite resaltar.

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import styles from './visor.module.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

export function Visor({ id, nombre }: { id: number; nombre: string }) {
  const contenedor = useRef<HTMLDivElement>(null)
  const [paginas, setPaginas] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelado = false
    let doc: PDFDocumentProxy | null = null

    async function cargar() {
      try {
        doc = await pdfjs.getDocument(`/api/pdf/${id}`).promise
        if (cancelado || !contenedor.current) return
        setPaginas(doc.numPages)
        contenedor.current.replaceChildren()

        for (let n = 1; n <= doc.numPages; n++) {
          const pagina = await doc.getPage(n)
          if (cancelado || !contenedor.current) return

          const escala = 1.5
          const viewport = pagina.getViewport({ scale: escala })

          const hoja = document.createElement('div')
          hoja.className = styles.hoja
          hoja.style.width = `${viewport.width}px`
          hoja.style.height = `${viewport.height}px`

          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          hoja.appendChild(canvas)

          const capa = document.createElement('div')
          capa.className = `${styles.capaTexto} capa-texto-pdf`
          capa.style.width = `${viewport.width}px`
          capa.style.height = `${viewport.height}px`
          hoja.appendChild(capa)

          contenedor.current.appendChild(hoja)

          const ctx = canvas.getContext('2d')
          if (ctx) await pagina.render({ canvasContext: ctx, viewport }).promise

          const texto = await pagina.getTextContent()
          await pdfjs.renderTextLayer({
            textContentSource: texto,
            container: capa,
            viewport,
          }).promise
        }
      } catch {
        if (!cancelado) setError('No se pudo abrir el PDF.')
      }
    }

    void cargar()
    return () => {
      cancelado = true
      void doc?.destroy()
    }
  }, [id])

  return (
    <div className={styles.panel}>
      <div className={styles.barra}>
        <span className={styles.nombre}>{nombre}</span>
        <span className={styles.paginas}>
          {paginas === 0 ? 'Cargando…' : `${paginas} ${paginas === 1 ? 'página' : 'páginas'}`}
        </span>
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <div ref={contenedor} />
    </div>
  )
}
```

`visor.module.css`: panel con `overflow: auto`, fondo `#e6e4df`, borde derecho `1px solid #d8d5cf`, padding 22px. La hoja con fondo `#fff` y `box-shadow: 0 2px 14px rgba(0,0,0,.13)`. `.capaTexto` en `position: absolute`, `color: transparent`, con los spans de pdf.js en `position: absolute; transform-origin: 0% 0%`.

- [ ] **Step 4: Verificar en el navegador**

Abrir `/comprobantes/<id>` de un comprobante ya extraído. Verificar que el PDF se ve, que scrollea, y que seleccionando texto con el mouse se selecciona (eso prueba que la capa de texto está bien alineada).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/app/api src/components/revision
git commit -m "$(cat <<'EOF'
agregar el visor de PDF con pdf.js

El PDF se sirve por un route handler que lee de disco: no va en public/,
porque los comprobantes son documentos comerciales, no archivos publicos.
La ruta se lee de la base y nunca llega desde el cliente.

Se renderiza el canvas y encima la capa de texto, que es lo que despues
hace posible el resaltado por busqueda.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: El formulario de revisión con autosave

**Files:**
- Modify: `src/app/comprobantes/[id]/page.tsx`
- Modify: `src/lib/formato.ts`
- Create: `src/components/revision/pantalla.tsx` — contenedor cliente; tiene el estado del campo enfocado y lo pasa al visor
- Create: `src/components/revision/formulario.tsx`
- Create: `src/components/revision/formulario.module.css`
- Create: `src/components/revision/campo.tsx`
- Create: `src/app/comprobantes/[id]/revision.module.css`
- Test: `tests/lib/imputado.test.ts`

**Interfaces:**
- Consumes: `GRUPOS`, `camposDelGrupo`, `type DefCampo` de `@/lib/campos`; `obtenerDetalle` de `@/server/app/detalle`; `guardarCampo` de `@/server/app/acciones`; `nivelConfianza` de `@/lib/confianza`; `formatMoneda` de `@/lib/formato`
- Produces: `parsearImporte(v: string | null | undefined): number` y `totalImputado(valores: Record<string, string | null | undefined>): number` en `@/lib/formato`; `type ValorInicial = { valor: string; confianza: number | null }` y `<Formulario comprobanteId iniciales onEnfocar />` en `@/components/revision/formulario`; `<Pantalla />` en `@/components/revision/pantalla`

- [ ] **Step 1: Escribir el test del total imputado**

`tests/lib/imputado.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { totalImputado, parsearImporte } from '@/lib/formato'

describe('parsearImporte', () => {
  it('parsea el formato argentino con miles y decimales', () => {
    expect(parsearImporte('322.982,28')).toBeCloseTo(322982.28, 2)
  })

  it('parsea un importe sin separador de miles', () => {
    expect(parsearImporte('1234,56')).toBeCloseTo(1234.56, 2)
  })

  it('devuelve 0 con texto vacio o basura', () => {
    expect(parsearImporte('')).toBe(0)
    expect(parsearImporte('n/a')).toBe(0)
  })
})

describe('totalImputado', () => {
  it('suma los seis componentes del comprobante de referencia', () => {
    const v = {
      neto: '322.982,28',
      iva21: '67.826,28',
      iva105: '',
      exento: '',
      perciva: '8.074,56',
      perciibb: '75.771,67',
      total: '484.344,26',
    }
    // No incluye `total`: el imputado existe justamente para contrastarlo.
    expect(totalImputado(v)).toBeCloseTo(474654.79, 2)
  })

  it('da 0 cuando no hay ningun importe cargado', () => {
    expect(totalImputado({})).toBe(0)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/lib/imputado.test.ts`
Expected: FAIL — `totalImputado is not a function`

- [ ] **Step 3: Agregar las dos funciones a `src/lib/formato.ts`**

```ts
/** Componentes del total. `total` no entra: el imputado existe para contrastarlo. */
const COMPONENTES_IMPUTADO = ['neto', 'iva21', 'iva105', 'exento', 'perciva', 'perciibb']

/**
 * Parsea un importe en formato argentino: punto de miles, coma decimal.
 * Devuelve 0 ante cualquier cosa que no sea un número, porque se usa para
 * sumar y un NaN contaminaría todo el total.
 */
export function parsearImporte(v: string | null | undefined): number {
  if (!v) return 0
  const limpio = v.replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  const n = Number(limpio)
  return Number.isFinite(n) ? n : 0
}

export function totalImputado(valores: Record<string, string | null | undefined>): number {
  return COMPONENTES_IMPUTADO.reduce((acc, k) => acc + parsearImporte(valores[k]), 0)
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/lib/imputado.test.ts tests/lib/formato.test.ts`
Expected: PASS

- [ ] **Step 5: Escribir el componente de campo**

`src/components/revision/campo.tsx`:

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import type { DefCampo } from '@/lib/campos'
import { nivelConfianza } from '@/lib/confianza'
import styles from './formulario.module.css'

export function Campo({
  def,
  valor,
  confianza,
  onCambio,
  onFoco,
  onDesenfoque,
}: {
  def: DefCampo
  valor: string
  confianza: number | null
  onCambio: (v: string) => void
  onFoco: () => void
  onDesenfoque: () => void
}) {
  const [local, setLocal] = useState(valor)
  const primero = useRef(true)

  // Autosave con debounce. El primer render no guarda: si no, abrir la
  // pantalla marcaria los 21 campos como corregidos por el usuario.
  useEffect(() => {
    if (primero.current) {
      primero.current = false
      return
    }
    const t = setTimeout(() => onCambio(local), 500)
    return () => clearTimeout(t)
  }, [local, onCambio])

  const baja = confianza !== null && confianza < 0.8
  const nivel = confianza === null ? null : nivelConfianza(confianza)

  return (
    <div className={styles.campo} style={{ gridColumn: `span ${def.span}` }}>
      <label className={styles.label} htmlFor={`campo-${def.clave}`}>
        {def.label}
        {nivel && (
          <span
            className={styles.chip}
            style={{ background: nivel.fondo, color: nivel.texto }}
          >
            {Math.round(confianza! * 100)}%
          </span>
        )}
      </label>
      <input
        id={`campo-${def.clave}`}
        className={[
          styles.input,
          def.mono ? styles.mono : '',
          baja ? styles.baja : '',
          def.soloLectura ? styles.soloLectura : '',
        ].filter(Boolean).join(' ')}
        value={local}
        readOnly={def.soloLectura}
        onChange={(e) => setLocal(e.target.value)}
        onFocus={onFoco}
        onBlur={onDesenfoque}
      />
    </div>
  )
}
```

- [ ] **Step 6: Escribir el formulario**

`src/components/revision/formulario.tsx` — componente cliente que arma los 4 grupos desde el catálogo, mantiene el estado de valores, calcula `imputado` en vivo, y llama a la server action `guardarCampo` en cada cambio con debounce. Expone `onCampoEnfocado` hacia arriba para el resaltado de la Task 10.

```tsx
'use client'

import { useCallback, useMemo, useState } from 'react'
import { GRUPOS, camposDelGrupo } from '@/lib/campos'
import { guardarCampo } from '@/server/app/acciones'
import { totalImputado, formatMoneda } from '@/lib/formato'
import { Campo } from './campo'
import styles from './formulario.module.css'

export type ValorInicial = { valor: string; confianza: number | null }

export function Formulario({
  comprobanteId,
  iniciales,
  onEnfocar,
}: {
  comprobanteId: number
  iniciales: Record<string, ValorInicial>
  onEnfocar: (texto: string | null) => void
}) {
  const [valores, setValores] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(iniciales).map(([k, v]) => [k, v.valor])),
  )

  const imputado = useMemo(() => formatMoneda(totalImputado(valores)), [valores])

  const cambiar = useCallback(
    (clave: string, v: string) => {
      setValores((prev) => (prev[clave] === v ? prev : { ...prev, [clave]: v }))
      void guardarCampo(comprobanteId, clave, v)
    },
    [comprobanteId],
  )

  return (
    <div className={styles.panel}>
      {GRUPOS.map((g) => (
        <section key={g.clave} className={styles.tarjeta}>
          <h3 className={styles.tituloGrupo}>{g.titulo}</h3>
          <div className={styles.grilla}>
            {camposDelGrupo(g.clave).map((def) => (
              <Campo
                key={def.clave}
                def={def}
                valor={def.clave === 'imputado' ? imputado : (valores[def.clave] ?? '')}
                confianza={iniciales[def.clave]?.confianza ?? null}
                onCambio={(v) => cambiar(def.clave, v)}
                onFoco={() => onEnfocar(valores[def.clave] ?? null)}
                onDesenfoque={() => onEnfocar(null)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
```

- [ ] **Step 7: Reescribir la página de revisión**

`src/app/comprobantes/[id]/page.tsx` — server component que trae el comprobante y el detalle, y monta el layout de dos paneles. El estado del campo enfocado vive en un componente cliente contenedor (`src/components/revision/pantalla.tsx`) que envuelve al visor y al formulario.

- [ ] **Step 8: Verificar el autosave en el navegador**

Abrir un comprobante extraído, editar el CUIT, esperar un segundo, recargar la página. El valor editado tiene que seguir ahí. Verificar en la base:

```sql
SELECT CLAVE, VALOR_IA, VALOR_FINAL, CORREGIDO_POR_USUARIO
FROM PHF_CAMPO WHERE COMPROBANTE_ID = <id> AND CLAVE = 'cuit'
```

`VALOR_IA` intacto, `VALOR_FINAL` con lo editado, `CORREGIDO_POR_USUARIO = 1`.

- [ ] **Step 9: Commit**

```bash
git add src/lib/formato.ts src/components/revision src/app/comprobantes/[id] tests/lib/imputado.test.ts
git commit -m "$(cat <<'EOF'
agregar el formulario de revision con autosave

Los cuatro grupos se arman desde el catalogo de campos, asi que agregar
un campo es tocar una sola lista. El total imputado se recalcula en vivo
y no incluye el total leido: existe justamente para contrastarlo.

El autosave no dispara en el primer render. Sin esa guarda, abrir la
pantalla marcaria los 21 campos como corregidos por el usuario y
arruinaria el dato con el que despues se mide al modelo.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Resaltado por capa de texto

**Files:**
- Create: `src/lib/resaltado.ts`
- Modify: `src/components/revision/visor.tsx`
- Test: `tests/lib/resaltado.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: `normalizarParaBusqueda(s: string): string`, `coincide(textoSpan: string, buscado: string): boolean`

- [ ] **Step 1: Escribir el test que falla**

`tests/lib/resaltado.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizarParaBusqueda, coincide } from '@/lib/resaltado'

describe('normalizarParaBusqueda', () => {
  it('saca acentos, espacios y pasa a minusculas', () => {
    expect(normalizarParaBusqueda('  Razón  Social  ')).toBe('razonsocial')
  })

  it('saca los separadores de un CUIT', () => {
    expect(normalizarParaBusqueda('30-71042636-9')).toBe('30710426369')
  })

  it('deja el importe comparable con o sin separador de miles', () => {
    expect(normalizarParaBusqueda('322.982,28')).toBe('32298228')
  })
})

describe('coincide', () => {
  it('encuentra el CUIT con guiones en un span sin guiones', () => {
    expect(coincide('CUIT 30710426369', '30-71042636-9')).toBe(true)
  })

  it('encuentra el importe con formato distinto', () => {
    expect(coincide('Total: 322982,28', '322.982,28')).toBe(true)
  })

  it('no matchea contra texto vacio', () => {
    expect(coincide('', '123')).toBe(false)
    expect(coincide('123', '')).toBe(false)
  })

  it('no matchea un valor de un solo caracter, que resaltaria medio PDF', () => {
    expect(coincide('un texto cualquiera con a', 'a')).toBe(false)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/lib/resaltado.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/resaltado"`

- [ ] **Step 3: Escribir `src/lib/resaltado.ts`**

```ts
/**
 * Normaliza para comparar el valor de un campo contra la capa de texto del
 * PDF. Saca todo lo que puede diferir entre cómo la IA devolvió el dato y
 * cómo está impreso: acentos, espacios, guiones, puntos y comas. Un CUIT
 * "30-71042636-9" tiene que matchear contra "30710426369" impreso.
 */
export function normalizarParaBusqueda(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s.,\-/]/g, '')
}

/** Longitud mínima para resaltar: con menos, se resaltaría medio PDF. */
const MINIMO = 2

export function coincide(textoSpan: string, buscado: string): boolean {
  const b = normalizarParaBusqueda(buscado)
  if (b.length < MINIMO) return false
  const t = normalizarParaBusqueda(textoSpan)
  if (t.length === 0) return false
  return t.includes(b)
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run tests/lib/resaltado.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Cablear el resaltado en el visor**

Agregar a `Visor` la prop `resaltar: string | null` y este efecto, que corre cada vez que cambia:

```tsx
  useEffect(() => {
    const capas = contenedor.current?.querySelectorAll('.capa-texto-pdf')
    if (!capas) return

    for (const capa of capas) {
      for (const span of capa.querySelectorAll('span')) {
        const marcar = resaltar !== null && coincide(span.textContent ?? '', resaltar)
        span.classList.toggle(styles.resaltado, marcar)
      }
    }
  }, [resaltar])
```

Y en `visor.module.css`:

```css
.resaltado {
  background: rgba(43, 79, 208, 0.13);
  outline: 2px solid rgba(43, 79, 208, 0.5);
  border-radius: 4px;
  transition: background 0.15s, outline-color 0.15s;
}
```

- [ ] **Step 6: Verificar en el navegador**

Abrir un comprobante con capa de texto. Enfocar el input de CUIT: la zona del CUIT en el PDF se resalta. Desenfocar: se apaga. Probar con un PDF escaneado: no resalta nada y la pantalla sigue funcionando normal.

- [ ] **Step 7: Commit**

```bash
git add src/lib/resaltado.ts src/components/revision/visor.tsx src/components/revision/visor.module.css tests/lib/resaltado.test.ts
git commit -m "$(cat <<'EOF'
resaltar en el PDF el campo enfocado

Se busca el valor del campo en la capa de texto de pdf.js. La comparacion
normaliza acentos, espacios y separadores, porque el CUIT que devolvio la
IA con guiones tiene que matchear contra el impreso sin guiones.

Un valor de un solo caracter no resalta: resaltaria medio PDF.

En un PDF escaneado no hay capa de texto y no resalta nada. No es un
error: la pantalla funciona igual.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Barra de acciones, aviso de lectura e historial

**Files:**
- Create: `src/components/revision/barra-acciones.tsx` + `barra-acciones.module.css`
- Create: `src/components/revision/aviso-ia.tsx` + `aviso-ia.module.css`
- Create: `src/components/revision/historial.tsx` + `historial.module.css`
- Create: `src/components/revision/renglones.tsx` + `renglones.module.css`
- Modify: `src/app/comprobantes/[id]/page.tsx`

**Interfaces:**
- Consumes: `confirmarComprobante`, `reprocesarComprobante` de `@/server/app/acciones`; `Detalle` de `@/server/app/detalle`; `ESTADOS` de `@/lib/estados`
- Produces: nada que consuman tareas posteriores

- [ ] **Step 1: Escribir la barra de acciones**

Medidas del README §2. El botón primario es contextual: `leido`/`observacion` → "Confirmar datos" (fondo `#17191d`); `confirmado` → "Registrar en Tango" (fondo `#1c7355`, **deshabilitado con title "Llega en la Fase 4"**); `registrado` → "Ver asiento en Tango" (deshabilitado). "Marcar en observación" se muestra deshabilitado con `title="Llega en la Fase 3"`.

```tsx
'use client'

import { useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { confirmarComprobante } from '@/server/app/acciones'
import { ESTADOS, type Estado } from '@/lib/estados'
import styles from './barra-acciones.module.css'

export function BarraAcciones({
  id,
  estado,
  proveedor,
  comprobante,
}: {
  id: number
  estado: Estado
  proveedor: string
  comprobante: string
}) {
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()
  const badge = ESTADOS[estado]

  return (
    <div className={styles.barra}>
      <Link href="/comprobantes" className={styles.volver}>← Bandeja</Link>
      <span className={styles.proveedor}>{proveedor}</span>
      <span className={styles.comprobante}>{comprobante}</span>
      <span className={styles.badge} style={{ background: badge.fondo, color: badge.texto }}>
        {badge.label}
      </span>

      <div className={styles.derecha}>
        <button type="button" className={styles.observacion} disabled title="Llega en la Fase 3">
          Marcar en observación
        </button>

        {(estado === 'leido' || estado === 'observacion') && (
          <button
            type="button"
            className={styles.confirmar}
            disabled={pendiente}
            onClick={() =>
              arrancar(async () => {
                await confirmarComprobante(id)
                router.refresh()
              })
            }
          >
            {pendiente ? 'Confirmando…' : 'Confirmar datos'}
          </button>
        )}

        {estado === 'confirmado' && (
          <button type="button" className={styles.registrar} disabled title="Llega en la Fase 4">
            Registrar en Tango
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Escribir el aviso de lectura IA**

Muestra cantidad de campos leídos, duración desde `EXTRACCION_MS`, confianza promedio y modelo desde `EXTRACCION_MODELO`. A la derecha, el botón "Reprocesar", que pide confirmación antes porque descarta las correcciones manuales:

```tsx
'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { reprocesarComprobante } from '@/server/app/acciones'
import styles from './aviso-ia.module.css'

export function AvisoIA({
  id,
  campos,
  ms,
  modelo,
  confianza,
  hayCorrecciones,
}: {
  id: number
  campos: number
  ms: number | null
  modelo: string | null
  confianza: number | null
  hayCorrecciones: boolean
}) {
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()

  const detalle = [
    `Claude leyó ${campos} campos`,
    ms === null ? null : `${(ms / 1000).toFixed(1).replace('.', ',')} s`,
    confianza === null ? null : `confianza promedio ${Math.round(confianza * 100)}%`,
    modelo,
  ].filter(Boolean).join(' · ')

  function reprocesar() {
    if (hayCorrecciones && !confirm('Reprocesar descarta las correcciones que hiciste a mano. ¿Seguir?')) {
      return
    }
    arrancar(async () => {
      await reprocesarComprobante(id)
      router.refresh()
    })
  }

  return (
    <div className={styles.aviso}>
      <div className={styles.icono}>✦</div>
      <div>
        <div className={styles.titulo}>Lectura automática completada</div>
        <div className={styles.detalle}>{detalle}</div>
      </div>
      <button type="button" className={styles.reprocesar} onClick={reprocesar} disabled={pendiente}>
        {pendiente ? 'Reprocesando…' : 'Reprocesar'}
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Escribir el historial y los renglones**

`historial.tsx` — server component, filas con timestamp en IBM Plex Mono 11,5px de ancho fijo 104px, texto 12,5px y usuario a la derecha, según el README §2.

`renglones.tsx` — server component con la grilla `70px 1fr 60px 96px 104px`. Si `renglones.length === 0`, la tarjeta no se muestra: el 77% de los comprobantes vienen solo con cabecera y una tarjeta vacía sería ruido.

- [ ] **Step 4: Montar todo en la página de revisión**

`src/app/comprobantes/[id]/page.tsx` trae el comprobante y el detalle, y si el estado es `procesando` muestra un placeholder con refresco automático en vez del formulario. Si es `error`, muestra `ERROR_MENSAJE` con el botón de reprocesar.

- [ ] **Step 5: Verificar el circuito completo en el navegador**

1. Importar un PDF real desde la bandeja.
2. Ver que pasa de "Procesando IA" a "Pendiente de revisión" solo.
3. Abrir la revisión: el PDF a la izquierda, los campos a la derecha con sus chips de confianza.
4. Enfocar un campo: se resalta la zona del PDF.
5. Corregir un campo, recargar: la corrección persiste.
6. Confirmar: el badge pasa a "Confirmado" y aparece la entrada en el historial.
7. Volver a la bandeja: el comprobante figura como confirmado.

- [ ] **Step 6: Correr la suite completa y el build**

Run: `pnpm test`
Expected: PASS — 88 de la Fase 1 más los ~50 nuevos

Run: `npx tsc --noEmit && npx next build`
Expected: sin errores

- [ ] **Step 7: Actualizar `RETOMAR.md`**

Marcar la Fase 2 como completa, con la cantidad de tests en verde, y anotar lo que haya que arrastrar a la Fase 3. Anotar también el costo real por comprobante ya medido.

- [ ] **Step 8: Commit**

```bash
git add src/components/revision src/app/comprobantes docs/superpowers/RETOMAR.md
git commit -m "$(cat <<'EOF'
completar la pantalla de revision: acciones, aviso IA e historial

Cierra la Fase 2. El circuito completo anda: importar, extraer, revisar
contra el PDF, corregir con autosave y confirmar.

"Marcar en observacion" y "Registrar en Tango" se muestran deshabilitados
con el título de la fase que los trae, en vez de esconderlos: el operador
ve la pantalla completa desde el principio.

Reprocesar avisa antes de descartar las correcciones manuales.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verificación final

- [ ] `pnpm test` en verde
- [ ] `npx tsc --noEmit` sin errores
- [ ] `npx next build` sin errores
- [ ] `git grep -n "CTA[0-9]" src/` sin resultados
- [ ] `git grep -rn "anthropic" src/ --ignore-case | grep -v "src/server/ia"` sin resultados: solo la capa de IA nombra a Anthropic
- [ ] La suite corre con `ANTHROPIC_API_KEY` vacía
- [ ] Medir el costo real por comprobante con `count_tokens` sobre 5 PDFs reales y anotarlo en `RETOMAR.md`
