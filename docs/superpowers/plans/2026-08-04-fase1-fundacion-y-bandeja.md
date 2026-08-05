# Fase 1 — Fundación y bandeja de comprobantes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar el proyecto Next.js en pie, con las tablas propias `PHF_*` creadas en `PUNTO_HOGAR_1`, la capa de lectura de Tango funcionando, y la bandeja de comprobantes mostrando datos reales de la base.

**Architecture:** Next.js 15 App Router con server components. Tres capas separadas: `src/server/db` (pool y transacciones), `src/server/tango` (único módulo que toca tablas del ERP), `src/server/app` (tablas propias `PHF_*`). La UI consume server actions y nunca emite SQL. Sin ORM: `mssql` con SQL explícito.

**Tech Stack:** Next.js 15, TypeScript, React 19, `mssql` (node-mssql), Vitest, `@fontsource/ibm-plex-sans` y `@fontsource/ibm-plex-mono`, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-08-04-importador-facturas-tango-design.md`

## Global Constraints

- Base de datos: `PUNTO_HOGAR_1` en `INFOSYS01\AXSQLSERVER`, usuario `Axoft`, contraseña `<ver .env.local>`. Instancia con nombre: requiere SQL Browser activo (UDP 1434).
- Todas las tablas propias llevan prefijo `PHF_`. Ninguna otra tabla se crea en la base.
- Ningún módulo fuera de `src/server/tango/` puede emitir SQL contra tablas `CPA*`, `CTA*`, `STA*`, `GVA*` o `SBA*`.
- En Fase 1 **no se escribe nada** en tablas de Tango. Solo lectura.
- Toda escritura en `PHF_*` registra usuario. El usuario se obtiene de `src/lib/usuario.ts`.
- Tipografía: IBM Plex Sans para UI, IBM Plex Mono para todo dato que el operador coteja contra el PDF (importes, CUIT, CAE, números de comprobante, fechas, timestamps, porcentajes). Self-hosted, nunca desde Google Fonts.
- Colores, medidas y copy salen de `design/README.md`. Es la fuente de verdad, no las capturas de `design/screenshots/`.
- Diseñado para ≥1280px. Sin diseño mobile.
- Los mensajes de commit van en español, en imperativo, con `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` al final.
- Idioma de toda la UI: español rioplatense, tono sobrio y técnico.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `design/` | Prototipo movido, solo referencia |
| `scripts/migrate.ts` | Crea las tablas `PHF_*`. Idempotente |
| `src/lib/estados.ts` | Modelo de estados: claves, labels, colores |
| `src/lib/formato.ts` | Formateo de moneda, fecha, CUIT, número de comprobante |
| `src/lib/usuario.ts` | Usuario actual para auditoría |
| `src/server/db/pool.ts` | Pool de conexión único a SQL Server |
| `src/server/db/tx.ts` | Helper de transacción con rollback automático ante error |
| `src/server/tango/proveedores.ts` | Lectura del maestro de proveedores (`CPA01`) |
| `src/server/app/comprobantes.ts` | Listado, KPIs y detalle de `PHF_COMPROBANTE` |
| `src/app/layout.tsx` | Shell: fuentes, tokens CSS, header global |
| `src/app/globals.css` | Design tokens y reset |
| `src/components/header-global.tsx` | Header oscuro de 56px con indicador de conexión |
| `src/components/badge-estado.tsx` | Badge de estado |
| `src/components/chip-confianza.tsx` | Chip de confianza |
| `src/app/comprobantes/page.tsx` | Bandeja |
| `src/components/bandeja/kpis.tsx` | Fila de 4 KPIs |
| `src/components/bandeja/filtros.tsx` | Tabs de filtro + buscador |
| `src/components/bandeja/tabla.tsx` | Tabla de comprobantes |
| `src/app/comprobantes/[id]/page.tsx` | Revisión — stub en Fase 1 |

---

### Task 1: Andamiaje del proyecto

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.env.local.example`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx`
- Move: `Importador de Facturas.dc.html`, `README.md`, `screenshots/` → `design/`

**Interfaces:**
- Consumes: nada
- Produces: proyecto que arranca con `pnpm dev` en `http://localhost:3000`; `pnpm test` corre Vitest

- [ ] **Step 1: Mover el prototipo a `design/`**

```bash
cd "D:/APP/PH_FAC"
mkdir -p design
git mv "Importador de Facturas.dc.html" design/
git mv README.md design/
git mv screenshots design/
```

- [ ] **Step 2: Crear el proyecto Next.js sobre la carpeta existente**

`create-next-app` se niega a trabajar sobre una carpeta con archivos, así que se genera en un temporal y se copia. No se usa Tailwind: el diseño es de alta fidelidad con medidas exactas en píxeles y CSS Modules da control más directo.

```bash
cd "D:/APP/PH_FAC"
pnpm dlx create-next-app@latest .tmp-scaffold \
  --ts --app --no-tailwind --no-eslint --no-src-dir \
  --import-alias "@/*" --use-pnpm --skip-install --yes
cp -r .tmp-scaffold/app src/app
cp .tmp-scaffold/next.config.ts .tmp-scaffold/tsconfig.json .
rm -rf .tmp-scaffold
```

- [ ] **Step 3: Escribir `package.json`**

```json
{
  "name": "ph-fac",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "migrate": "tsx scripts/migrate.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@fontsource/ibm-plex-mono": "^5.1.0",
    "@fontsource/ibm-plex-sans": "^5.1.0",
    "mssql": "^11.0.1",
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/mssql": "^9.1.5",
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "dotenv": "^16.4.7",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 4: Instalar dependencias**

Run: `pnpm install`
Expected: instala sin errores. Si `mssql` falla al compilar, verificar que no haya proxy corporativo bloqueando.

- [ ] **Step 5: Escribir `vitest.config.ts`**

Los tests tocan la base real, así que corren en serie y sin timeout agresivo.

```ts
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 20000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ['tests/setup.ts'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
```

- [ ] **Step 6: Escribir `tests/setup.ts`**

```ts
import { config } from 'dotenv'

config({ path: '.env.local' })
```

- [ ] **Step 7: Escribir `.env.local.example`**

```
SQLSERVER_HOST=INFOSYS01
SQLSERVER_INSTANCE=AXSQLSERVER
SQLSERVER_DB=PUNTO_HOGAR_1
SQLSERVER_USER=Axoft
SQLSERVER_PASSWORD=<ver .env.local>

# Carpeta donde se guardan los PDF importados
PHF_STORAGE_DIR=D:\APP\PH_FAC\storage

# Opcional: fuerza el usuario de auditoria en lugar del usuario de Windows
# PHF_USUARIO=

# Fase 2. Dejar vacia por ahora.
ANTHROPIC_API_KEY=
```

- [ ] **Step 8: Crear `.env.local` a partir del ejemplo**

```bash
cd "D:/APP/PH_FAC"
cp .env.local.example .env.local
```

`ANTHROPIC_API_KEY` queda vacía: la carga el usuario antes de la Fase 2.

- [ ] **Step 9: Escribir `src/app/globals.css` con los design tokens**

Los valores salen de la sección "Design Tokens" de `design/README.md`.

```css
@import '@fontsource/ibm-plex-sans/400.css';
@import '@fontsource/ibm-plex-sans/500.css';
@import '@fontsource/ibm-plex-sans/600.css';
@import '@fontsource/ibm-plex-sans/700.css';
@import '@fontsource/ibm-plex-mono/400.css';
@import '@fontsource/ibm-plex-mono/500.css';
@import '@fontsource/ibm-plex-mono/600.css';

:root {
  --fondo-app: #f2f1ed;
  --fondo-panel: #f7f6f3;
  --fondo-pdf: #e6e4df;
  --superficie: #ffffff;
  --fondo-header-tabla: #faf9f7;

  --texto: #17191d;
  --texto-2: #5c6068;
  --texto-3: #7b7f87;
  --texto-4: #82868e;
  --texto-5: #8b8f97;
  --texto-6: #9a9ea6;

  --borde: #e3e1dc;
  --borde-input: #dcdad5;
  --borde-sutil: #f0efec;
  --borde-sutil-2: #f4f3f0;
  --borde-sutil-3: #eeece8;
  --borde-pdf: #d8d5cf;
  --borde-dashed: #c9c6c0;

  --acento: #2b4fd0;
  --acento-hover: #1b39a3;
  --acento-tenue: #e7eef9;
  --acento-tenue-2: #f4f6fd;

  --exito: #1c7355;
  --exito-fondo: #e3f1ea;
  --conexion-ok: #3ea37c;

  --alerta: #8a5a00;
  --alerta-fondo: #fbf0dc;
  --alerta-borde: #e0cfa4;
  --alerta-hover: #fdf6e7;

  --error: #a03526;
  --error-fondo: #fae7e3;
  --error-borde: #e6b9b0;
  --error-input-fondo: #fdf6f4;

  --ia: #4a3fa8;
  --ia-fondo: #eceaf6;

  --oscuro: #17191d;
  --oscuro-2: #33363d;
  --oscuro-3: #3b3e45;
  --oscuro-texto: #b9bcc2;

  --sans: 'IBM Plex Sans', system-ui, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, monospace;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
}

body {
  background: var(--fondo-app);
  color: var(--texto);
  font-family: var(--sans);
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}

button {
  font-family: inherit;
  cursor: pointer;
}

input,
textarea,
select {
  font-family: inherit;
}
```

- [ ] **Step 10: Escribir `src/app/layout.tsx`**

```tsx
import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Comprobantes · Cuentas a pagar',
  description: 'Importador de comprobantes de compra hacia Tango',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR">
      <body>{children}</body>
    </html>
  )
}
```

- [ ] **Step 11: Escribir `src/app/page.tsx`**

```tsx
import { redirect } from 'next/navigation'

export default function Home() {
  redirect('/comprobantes')
}
```

- [ ] **Step 12: Verificar que el proyecto arranca**

Run: `pnpm dev`
Expected: compila y `http://localhost:3000` redirige a `/comprobantes`, que todavía da 404. Eso es correcto en este punto. Cortar el server.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: andamiaje del proyecto Next.js con design tokens

Mueve el prototipo a design/ como referencia.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Conexión a SQL Server

**Files:**
- Create: `src/server/db/pool.ts`, `src/server/db/tx.ts`, `tests/server/db/pool.test.ts`
- Test: `tests/server/db/pool.test.ts`

**Interfaces:**
- Consumes: variables de entorno de `.env.local`
- Produces:
  - `getPool(): Promise<sql.ConnectionPool>`
  - `cerrarPool(): Promise<void>`
  - `probarConexion(): Promise<{ ok: true; version: string } | { ok: false; error: string }>`
  - `conTransaccion<T>(fn: (tx: sql.Transaction) => Promise<T>): Promise<T>`
  - `conRollback<T>(fn: (tx: sql.Transaction) => Promise<T>): Promise<T>` — solo para tests

- [ ] **Step 1: Escribir el test que falla**

`tests/server/db/pool.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { getPool, probarConexion, cerrarPool } from '@/server/db/pool'

describe('pool de SQL Server', () => {
  afterAll(async () => {
    await cerrarPool()
  })

  it('conecta a PUNTO_HOGAR_1', async () => {
    const pool = await getPool()
    const r = await pool.request().query('SELECT DB_NAME() AS db')
    expect(r.recordset[0].db).toBe('PUNTO_HOGAR_1')
  })

  it('devuelve el mismo pool en llamadas sucesivas', async () => {
    const a = await getPool()
    const b = await getPool()
    expect(a).toBe(b)
  })

  it('probarConexion informa ok y la version del motor', async () => {
    const r = await probarConexion()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.version).toContain('SQL Server')
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `pnpm test tests/server/db/pool.test.ts`
Expected: FAIL — no existe el módulo `@/server/db/pool`.

- [ ] **Step 3: Escribir `src/server/db/pool.ts`**

`instanceName` y `port` son mutuamente excluyentes en tedious. Con instancia con nombre hay que dejar `port` sin definir y depender del SQL Browser.

```ts
import sql from 'mssql'

function leerConfig(): sql.config {
  const req = (k: string) => {
    const v = process.env[k]
    if (!v) throw new Error(`Falta la variable de entorno ${k}`)
    return v
  }

  return {
    server: req('SQLSERVER_HOST'),
    database: req('SQLSERVER_DB'),
    user: req('SQLSERVER_USER'),
    password: req('SQLSERVER_PASSWORD'),
    options: {
      instanceName: process.env.SQLSERVER_INSTANCE || undefined,
      encrypt: false,
      trustServerCertificate: true,
      // Tango guarda importes en tipos DECIMAL_TG. Sin esto, mssql
      // devuelve strings para decimales de alta precision.
      useUTC: false,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 30000,
    connectionTimeout: 15000,
  }
}

let poolPromise: Promise<sql.ConnectionPool> | null = null

export function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(leerConfig())
      .connect()
      .catch((err) => {
        poolPromise = null
        throw err
      })
  }
  return poolPromise
}

export async function cerrarPool(): Promise<void> {
  if (!poolPromise) return
  const pool = await poolPromise
  poolPromise = null
  await pool.close()
}

export type ResultadoConexion =
  | { ok: true; version: string }
  | { ok: false; error: string }

export async function probarConexion(): Promise<ResultadoConexion> {
  try {
    const pool = await getPool()
    const r = await pool.request().query('SELECT @@VERSION AS v')
    return { ok: true, version: String(r.recordset[0].v) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
```

- [ ] **Step 4: Correr el test**

Run: `pnpm test tests/server/db/pool.test.ts`
Expected: PASS, los 3 tests.

Si falla con `Failed to connect ... instance`, el servicio **SQL Server Browser** está detenido. Arrancarlo desde `services.msc` y reintentar.

- [ ] **Step 5: Escribir `src/server/db/tx.ts`**

```ts
import sql from 'mssql'
import { getPool } from './pool'

/**
 * Corre `fn` dentro de una transaccion. Commit si termina bien,
 * rollback si lanza. El error original se propaga.
 */
export async function conTransaccion<T>(
  fn: (tx: sql.Transaction) => Promise<T>,
  nivel: sql.IIsolationLevel = sql.ISOLATION_LEVEL.READ_COMMITTED,
): Promise<T> {
  const pool = await getPool()
  const tx = new sql.Transaction(pool)
  await tx.begin(nivel)
  try {
    const r = await fn(tx)
    await tx.commit()
    return r
  } catch (err) {
    try {
      await tx.rollback()
    } catch {
      // La transaccion ya podia estar abortada por el motor.
    }
    throw err
  }
}

/**
 * Igual que conTransaccion pero siempre hace rollback.
 * Es para tests que necesitan escribir sin dejar rastro.
 */
export async function conRollback<T>(
  fn: (tx: sql.Transaction) => Promise<T>,
): Promise<T> {
  const pool = await getPool()
  const tx = new sql.Transaction(pool)
  await tx.begin()
  try {
    return await fn(tx)
  } finally {
    await tx.rollback().catch(() => {})
  }
}
```

- [ ] **Step 6: Escribir `tests/server/db/tx.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { conTransaccion, conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'

describe('helpers de transaccion', () => {
  afterAll(async () => {
    await cerrarPool()
  })

  it('conTransaccion devuelve el valor de la funcion', async () => {
    const r = await conTransaccion(async (tx) => {
      const q = await tx.request().query('SELECT 42 AS n')
      return q.recordset[0].n
    })
    expect(r).toBe(42)
  })

  it('conTransaccion propaga el error y hace rollback', async () => {
    await expect(
      conTransaccion(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })

  it('conRollback no deja rastro de lo escrito', async () => {
    await conRollback(async (tx) => {
      await tx.request().query('CREATE TABLE #t (a INT); INSERT INTO #t VALUES (1)')
      const q = await tx.request().query('SELECT COUNT(*) AS n FROM #t')
      expect(q.recordset[0].n).toBe(1)
    })
  })
})
```

- [ ] **Step 7: Correr los tests**

Run: `pnpm test`
Expected: PASS, 6 tests.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: pool de conexion a SQL Server y helpers de transaccion

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Esquema propio `PHF_*`

**Files:**
- Create: `scripts/migrate.ts`, `tests/scripts/migrate.test.ts`

**Interfaces:**
- Consumes: `getPool` de `src/server/db/pool.ts`
- Produces: tablas `PHF_COMPROBANTE`, `PHF_CAMPO`, `PHF_RENGLON`, `PHF_AUDITORIA` en `PUNTO_HOGAR_1`; función `migrar(): Promise<string[]>` que devuelve las tablas creadas en esa corrida

- [ ] **Step 1: Escribir el test que falla**

`tests/scripts/migrate.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { migrar } from '../../scripts/migrate'
import { getPool, cerrarPool } from '@/server/db/pool'

const TABLAS = ['PHF_COMPROBANTE', 'PHF_CAMPO', 'PHF_RENGLON', 'PHF_AUDITORIA']

describe('migracion del esquema propio', () => {
  afterAll(async () => {
    await cerrarPool()
  })

  it('crea las cuatro tablas PHF_', async () => {
    await migrar()
    const pool = await getPool()
    const r = await pool
      .request()
      .query("SELECT name FROM sys.tables WHERE name LIKE 'PHF[_]%' ORDER BY name")
    const nombres = r.recordset.map((x) => x.name)
    for (const t of TABLAS) expect(nombres).toContain(t)
  })

  it('es idempotente: la segunda corrida no crea nada', async () => {
    await migrar()
    const creadas = await migrar()
    expect(creadas).toEqual([])
  })

  it('no crea tablas fuera del prefijo PHF_', async () => {
    const pool = await getPool()
    const antes = await pool.request().query('SELECT COUNT(*) AS n FROM sys.tables')
    await migrar()
    const despues = await pool.request().query('SELECT COUNT(*) AS n FROM sys.tables')
    expect(despues.recordset[0].n).toBe(antes.recordset[0].n)
  })

  it('rechaza un estado invalido', async () => {
    const pool = await getPool()
    await expect(
      pool.request().query(`
        INSERT INTO PHF_COMPROBANTE (ARCHIVO_NOMBRE, ARCHIVO_RUTA, ARCHIVO_HASH, ESTADO, USUARIO_ALTA)
        VALUES ('x.pdf', 'x', REPLICATE('0', 64), 'inventado', 'test')
      `),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `pnpm test tests/scripts/migrate.test.ts`
Expected: FAIL — no existe `scripts/migrate.ts`.

- [ ] **Step 3: Escribir `scripts/migrate.ts`**

`TANGO_NCOMP_IN_C` es `FLOAT` porque el tipo `ENTEROXL_TG` de Tango en `CPA04.NCOMP_IN_C` devuelve valores como `16591.0`.

```ts
import { config as cargarEnv } from 'dotenv'
import { getPool, cerrarPool } from '../src/server/db/pool'

cargarEnv({ path: '.env.local' })

type Definicion = { tabla: string; ddl: string }

const DEFINICIONES: Definicion[] = [
  {
    tabla: 'PHF_COMPROBANTE',
    ddl: `
      CREATE TABLE PHF_COMPROBANTE (
        ID                  INT IDENTITY(1,1) NOT NULL,
        ARCHIVO_NOMBRE      NVARCHAR(260)  NOT NULL,
        ARCHIVO_RUTA        NVARCHAR(500)  NOT NULL,
        ARCHIVO_HASH        CHAR(64)       NOT NULL,
        ESTADO              VARCHAR(20)    NOT NULL,
        MOTIVO_OBSERVACION  NVARCHAR(60)   NULL,
        NOTA_OBSERVACION    NVARCHAR(1000) NULL,
        TIPO                VARCHAR(10)    NULL,
        PUNTO_VENTA         VARCHAR(10)    NULL,
        NUMERO              VARCHAR(20)    NULL,
        FECHA_EMISION       DATE           NULL,
        RAZON_SOCIAL        NVARCHAR(200)  NULL,
        CUIT                VARCHAR(15)    NULL,
        TOTAL               DECIMAL(19,4)  NULL,
        CONFIANZA_PROMEDIO  DECIMAL(5,4)   NULL,
        COD_PROVEE          VARCHAR(20)    NULL,
        TANGO_NCOMP_IN_C    FLOAT          NULL,
        TANGO_T_COMP        VARCHAR(10)    NULL,
        TANGO_N_COMP        VARCHAR(20)    NULL,
        FECHA_REGISTRO      DATETIME2      NULL,
        FECHA_ALTA          DATETIME2      NOT NULL CONSTRAINT DF_PHF_COMP_ALTA DEFAULT SYSDATETIME(),
        USUARIO_ALTA        NVARCHAR(60)   NOT NULL,
        FECHA_MODIF         DATETIME2      NULL,
        USUARIO_MODIF       NVARCHAR(60)   NULL,
        CONSTRAINT PK_PHF_COMPROBANTE PRIMARY KEY (ID),
        CONSTRAINT CK_PHF_COMP_ESTADO CHECK (ESTADO IN
          ('procesando','leido','observacion','confirmado','registrado','error'))
      );
      CREATE INDEX IX_PHF_COMP_ESTADO ON PHF_COMPROBANTE (ESTADO);
      CREATE INDEX IX_PHF_COMP_DUP ON PHF_COMPROBANTE (COD_PROVEE, TIPO, NUMERO);
      CREATE INDEX IX_PHF_COMP_CUIT ON PHF_COMPROBANTE (CUIT);
    `,
  },
  {
    tabla: 'PHF_CAMPO',
    ddl: `
      CREATE TABLE PHF_CAMPO (
        ID                     INT IDENTITY(1,1) NOT NULL,
        COMPROBANTE_ID         INT            NOT NULL,
        CLAVE                  VARCHAR(40)    NOT NULL,
        VALOR_IA               NVARCHAR(500)  NULL,
        CONFIANZA              DECIMAL(5,4)   NULL,
        VALOR_FINAL            NVARCHAR(500)  NULL,
        CORREGIDO_POR_USUARIO  BIT            NOT NULL CONSTRAINT DF_PHF_CAMPO_CORR DEFAULT 0,
        CONSTRAINT PK_PHF_CAMPO PRIMARY KEY (ID),
        CONSTRAINT UQ_PHF_CAMPO UNIQUE (COMPROBANTE_ID, CLAVE),
        CONSTRAINT FK_PHF_CAMPO_COMP FOREIGN KEY (COMPROBANTE_ID)
          REFERENCES PHF_COMPROBANTE (ID) ON DELETE CASCADE
      );
    `,
  },
  {
    tabla: 'PHF_RENGLON',
    ddl: `
      CREATE TABLE PHF_RENGLON (
        ID                  INT IDENTITY(1,1) NOT NULL,
        COMPROBANTE_ID      INT            NOT NULL,
        ORDEN               INT            NOT NULL,
        CODIGO_IA           NVARCHAR(60)   NULL,
        DESCRIPCION_IA      NVARCHAR(500)  NULL,
        CANTIDAD_IA         DECIMAL(19,4)  NULL,
        PRECIO_UNITARIO_IA  DECIMAL(19,4)  NULL,
        IMPORTE_IA          DECIMAL(19,4)  NULL,
        REMITO_NCOMP_IN_S   VARCHAR(20)    NULL,
        REMITO_N_RENGL_S    INT            NULL,
        CONSTRAINT PK_PHF_RENGLON PRIMARY KEY (ID),
        CONSTRAINT UQ_PHF_RENGLON UNIQUE (COMPROBANTE_ID, ORDEN),
        CONSTRAINT FK_PHF_RENGLON_COMP FOREIGN KEY (COMPROBANTE_ID)
          REFERENCES PHF_COMPROBANTE (ID) ON DELETE CASCADE
      );
    `,
  },
  {
    tabla: 'PHF_AUDITORIA',
    ddl: `
      CREATE TABLE PHF_AUDITORIA (
        ID              INT IDENTITY(1,1) NOT NULL,
        COMPROBANTE_ID  INT            NOT NULL,
        FECHA           DATETIME2      NOT NULL CONSTRAINT DF_PHF_AUD_FECHA DEFAULT SYSDATETIME(),
        TEXTO           NVARCHAR(500)  NOT NULL,
        USUARIO         NVARCHAR(60)   NOT NULL,
        CONSTRAINT PK_PHF_AUDITORIA PRIMARY KEY (ID),
        CONSTRAINT FK_PHF_AUD_COMP FOREIGN KEY (COMPROBANTE_ID)
          REFERENCES PHF_COMPROBANTE (ID) ON DELETE CASCADE
      );
      CREATE INDEX IX_PHF_AUD_COMP ON PHF_AUDITORIA (COMPROBANTE_ID, FECHA);
    `,
  },
]

/** Crea las tablas que falten. Devuelve los nombres de las creadas. */
export async function migrar(): Promise<string[]> {
  const pool = await getPool()
  const creadas: string[] = []

  for (const { tabla, ddl } of DEFINICIONES) {
    const existe = await pool
      .request()
      .input('t', tabla)
      .query('SELECT COUNT(*) AS n FROM sys.tables WHERE name = @t')

    if (existe.recordset[0].n > 0) continue

    await pool.request().batch(ddl)
    creadas.push(tabla)
  }

  return creadas
}

const esEjecucionDirecta =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))

if (esEjecucionDirecta) {
  migrar()
    .then((creadas) => {
      if (creadas.length === 0) console.log('Esquema al dia, no habia nada que crear.')
      else console.log(`Tablas creadas: ${creadas.join(', ')}`)
    })
    .catch((err) => {
      console.error('Fallo la migracion:', err.message)
      process.exitCode = 1
    })
    .finally(() => cerrarPool())
}
```

- [ ] **Step 4: Correr la migración**

Run: `pnpm migrate`
Expected: `Tablas creadas: PHF_COMPROBANTE, PHF_CAMPO, PHF_RENGLON, PHF_AUDITORIA`

- [ ] **Step 5: Correr la migración de nuevo para verificar idempotencia**

Run: `pnpm migrate`
Expected: `Esquema al dia, no habia nada que crear.`

- [ ] **Step 6: Correr los tests**

Run: `pnpm test tests/scripts/migrate.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: esquema propio PHF_ con migracion idempotente

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Utilidades de dominio

**Files:**
- Create: `src/lib/estados.ts`, `src/lib/formato.ts`, `src/lib/usuario.ts`, `tests/lib/formato.test.ts`, `tests/lib/estados.test.ts`

**Interfaces:**
- Consumes: nada
- Produces:
  - `type Estado = 'procesando' | 'leido' | 'observacion' | 'confirmado' | 'registrado' | 'error'`
  - `ESTADOS: Record<Estado, { label: string; fondo: string; texto: string }>`
  - `ORDEN_TABS: { clave: Estado | 'todos'; label: string }[]`
  - `formatMoneda(n: number | null): string`
  - `formatFecha(d: Date | string | null): string`
  - `formatCuit(c: string | null): string`
  - `normalizarCuit(c: string | null): string | null`
  - `usuarioActual(): string`

- [ ] **Step 1: Escribir los tests que fallan**

`tests/lib/formato.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatMoneda, formatFecha, formatCuit, normalizarCuit } from '@/lib/formato'

describe('formatMoneda', () => {
  it('formatea con separador de miles y dos decimales', () => {
    expect(formatMoneda(1234567.89)).toBe('$ 1.234.567,89')
  })

  it('muestra guion cuando es cero', () => {
    expect(formatMoneda(0)).toBe('—')
  })

  it('muestra guion cuando es null', () => {
    expect(formatMoneda(null)).toBe('—')
  })

  it('redondea a dos decimales', () => {
    expect(formatMoneda(10.005)).toBe('$ 10,01')
  })
})

describe('formatFecha', () => {
  it('formatea como dd/mm/yyyy', () => {
    expect(formatFecha('2026-05-18')).toBe('18/05/2026')
  })

  it('muestra guion cuando es null', () => {
    expect(formatFecha(null)).toBe('—')
  })
})

describe('normalizarCuit', () => {
  it('quita guiones y espacios', () => {
    expect(normalizarCuit('30-64872913-7')).toBe('30648729137')
  })

  it('devuelve null si no quedan 11 digitos', () => {
    expect(normalizarCuit('30-6487')).toBeNull()
  })

  it('devuelve null cuando es null', () => {
    expect(normalizarCuit(null)).toBeNull()
  })
})

describe('formatCuit', () => {
  it('aplica la mascara de Tango', () => {
    expect(formatCuit('30648729137')).toBe('30-64872913-7')
  })

  it('devuelve el original si no son 11 digitos', () => {
    expect(formatCuit('123')).toBe('123')
  })

  it('muestra guion cuando es null', () => {
    expect(formatCuit(null)).toBe('—')
  })
})
```

`tests/lib/estados.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ESTADOS, ORDEN_TABS, esTerminal, permiteRegistrar } from '@/lib/estados'

describe('modelo de estados', () => {
  it('define los seis estados del spec', () => {
    expect(Object.keys(ESTADOS).sort()).toEqual(
      ['confirmado', 'error', 'leido', 'observacion', 'procesando', 'registrado'].sort(),
    )
  })

  it('usa los labels del diseno', () => {
    expect(ESTADOS.leido.label).toBe('Pendiente de revisión')
    expect(ESTADOS.registrado.label).toBe('Registrado en Tango')
  })

  it('registrado es terminal', () => {
    expect(esTerminal('registrado')).toBe(true)
    expect(esTerminal('confirmado')).toBe(false)
  })

  it('solo confirmado habilita el registro en Tango', () => {
    expect(permiteRegistrar('confirmado')).toBe(true)
    expect(permiteRegistrar('leido')).toBe(false)
    expect(permiteRegistrar('registrado')).toBe(false)
  })

  it('los tabs van en el orden del diseno', () => {
    expect(ORDEN_TABS.map((t) => t.clave)).toEqual([
      'todos',
      'leido',
      'observacion',
      'confirmado',
      'registrado',
      'error',
    ])
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `pnpm test tests/lib`
Expected: FAIL — no existen `@/lib/formato` ni `@/lib/estados`.

- [ ] **Step 3: Escribir `src/lib/formato.ts`**

```ts
const MONEDA = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatMoneda(n: number | null | undefined): string {
  if (n === null || n === undefined || n === 0) return '—'
  return `$ ${MONEDA.format(n)}`
}

export function formatFecha(d: Date | string | null | undefined): string {
  if (!d) return '—'
  const f = typeof d === 'string' ? new Date(`${d}T00:00:00`) : d
  if (Number.isNaN(f.getTime())) return '—'
  const dd = String(f.getDate()).padStart(2, '0')
  const mm = String(f.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${f.getFullYear()}`
}

export function normalizarCuit(c: string | null | undefined): string | null {
  if (!c) return null
  const soloDigitos = c.replace(/\D/g, '')
  return soloDigitos.length === 11 ? soloDigitos : null
}

export function formatCuit(c: string | null | undefined): string {
  if (!c) return '—'
  const n = normalizarCuit(c)
  if (!n) return c
  return `${n.slice(0, 2)}-${n.slice(2, 10)}-${n.slice(10)}`
}
```

- [ ] **Step 4: Escribir `src/lib/estados.ts`**

Los colores salen de la tabla "Modelo de estados" de `design/README.md`.

```ts
export type Estado =
  | 'procesando'
  | 'leido'
  | 'observacion'
  | 'confirmado'
  | 'registrado'
  | 'error'

export const ESTADOS: Record<Estado, { label: string; fondo: string; texto: string }> = {
  procesando:  { label: 'Procesando IA',          fondo: '#eceaf6', texto: '#4a3fa8' },
  leido:       { label: 'Pendiente de revisión',  fondo: '#e7eef9', texto: '#2b4fd0' },
  observacion: { label: 'En observación',         fondo: '#fbf0dc', texto: '#8a5a00' },
  confirmado:  { label: 'Confirmado',             fondo: '#e3f1ea', texto: '#1c7355' },
  registrado:  { label: 'Registrado en Tango',    fondo: '#17191d', texto: '#ffffff' },
  error:       { label: 'Error de lectura',       fondo: '#fae7e3', texto: '#a03526' },
}

export type ClaveTab = Estado | 'todos'

export const ORDEN_TABS: { clave: ClaveTab; label: string }[] = [
  { clave: 'todos',       label: 'Todos' },
  { clave: 'leido',       label: 'Pendientes' },
  { clave: 'observacion', label: 'En observación' },
  { clave: 'confirmado',  label: 'Confirmados' },
  { clave: 'registrado',  label: 'Registrados' },
  { clave: 'error',       label: 'Con error' },
]

export function esTerminal(e: Estado): boolean {
  return e === 'registrado'
}

export function permiteRegistrar(e: Estado): boolean {
  return e === 'confirmado'
}
```

- [ ] **Step 5: Escribir `src/lib/usuario.ts`**

```ts
import os from 'node:os'

/**
 * Usuario para la auditoria. Toma el usuario de Windows del proceso.
 *
 * Limitacion conocida: si la app se sirve desde un servidor, esto devuelve
 * la cuenta del servicio, no la del operador. Vale mientras cada operador
 * corra la app en su propia PC. PHF_USUARIO permite forzar el valor.
 */
export function usuarioActual(): string {
  const forzado = process.env.PHF_USUARIO?.trim()
  if (forzado) return forzado
  try {
    return os.userInfo().username
  } catch {
    return 'desconocido'
  }
}
```

- [ ] **Step 6: Correr los tests**

Run: `pnpm test tests/lib`
Expected: PASS, 17 tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: utilidades de formato, modelo de estados y usuario de auditoria

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Capa de lectura de Tango — proveedores

**Files:**
- Create: `src/server/tango/proveedores.ts`, `tests/server/tango/proveedores.test.ts`

**Interfaces:**
- Consumes: `getPool`, `normalizarCuit`
- Produces:
  - `type Proveedor = { codProvee: string; razonSocial: string; cuit: string | null; condicionIva: string | null; condicionCompra: number | null }`
  - `buscarProveedorPorCuit(cuit: string): Promise<Proveedor | null>`
  - `buscarProveedoresPorRazonSocial(texto: string, limite?: number): Promise<Proveedor[]>`

Las columnas de `CPA01` verificadas contra la base: `COD_PROVEE`, `N_CUIT`, `COND_IVA`, `COND_COMPR`. El nombre del proveedor se confirma en el Step 1.

- [ ] **Step 1: Confirmar el nombre de la columna de razón social**

Run:
```bash
sqlcmd -S "INFOSYS01\AXSQLSERVER" -U Axoft -P "<ver .env.local>" -d PUNTO_HOGAR_1 -h -1 -W -Q "SET NOCOUNT ON; SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('CPA01') ORDER BY column_id;"
```
Expected: una lista de columnas. Identificar la de razón social (candidatas habituales en Tango: `NOM_PROVEE`, `RAZON_SOCI`). Usar el nombre real en los pasos siguientes; donde este plan dice `NOM_PROVEE`, reemplazar por el que devuelva esta consulta.

- [ ] **Step 2: Escribir el test que falla**

`tests/server/tango/proveedores.test.ts`. Los tests no dependen de un proveedor concreto: toman uno real de la base y verifican que la búsqueda lo encuentra.

```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { buscarProveedorPorCuit, buscarProveedoresPorRazonSocial } from '@/server/tango/proveedores'
import { getPool, cerrarPool } from '@/server/db/pool'

let cuitReal: string
let razonReal: string
let codReal: string

beforeAll(async () => {
  const pool = await getPool()
  const r = await pool.request().query(`
    SELECT TOP 1 COD_PROVEE, NOM_PROVEE, N_CUIT
    FROM CPA01
    WHERE LEN(REPLACE(REPLACE(ISNULL(N_CUIT,''), '-', ''), ' ', '')) = 11
    ORDER BY COD_PROVEE
  `)
  const p = r.recordset[0]
  codReal = String(p.COD_PROVEE).trim()
  razonReal = String(p.NOM_PROVEE).trim()
  cuitReal = String(p.N_CUIT).trim()
})

afterAll(async () => {
  await cerrarPool()
})

describe('buscarProveedorPorCuit', () => {
  it('encuentra un proveedor real por su CUIT', async () => {
    const p = await buscarProveedorPorCuit(cuitReal)
    expect(p).not.toBeNull()
    expect(p!.codProvee).toBe(codReal)
  })

  it('encuentra el mismo proveedor con el CUIT sin guiones', async () => {
    const p = await buscarProveedorPorCuit(cuitReal.replace(/\D/g, ''))
    expect(p!.codProvee).toBe(codReal)
  })

  it('devuelve null cuando el CUIT no existe', async () => {
    const p = await buscarProveedorPorCuit('99-99999999-9')
    expect(p).toBeNull()
  })

  it('devuelve null cuando el CUIT esta mal formado', async () => {
    const p = await buscarProveedorPorCuit('123')
    expect(p).toBeNull()
  })
})

describe('buscarProveedoresPorRazonSocial', () => {
  it('encuentra por substring, sin distinguir mayusculas', async () => {
    const frag = razonReal.slice(0, 5).toLowerCase()
    const r = await buscarProveedoresPorRazonSocial(frag)
    expect(r.map((p) => p.codProvee)).toContain(codReal)
  })

  it('respeta el limite', async () => {
    const r = await buscarProveedoresPorRazonSocial(razonReal.slice(0, 2), 3)
    expect(r.length).toBeLessThanOrEqual(3)
  })

  it('devuelve vacio con texto de menos de dos caracteres', async () => {
    const r = await buscarProveedoresPorRazonSocial('a')
    expect(r).toEqual([])
  })
})
```

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `pnpm test tests/server/tango/proveedores.test.ts`
Expected: FAIL — no existe `@/server/tango/proveedores`.

- [ ] **Step 4: Escribir `src/server/tango/proveedores.ts`**

La comparación de CUIT normaliza de los dos lados: en `CPA01` conviven CUIT con y sin guiones.

```ts
import sql from 'mssql'
import { getPool } from '../db/pool'
import { normalizarCuit } from '@/lib/formato'

export type Proveedor = {
  codProvee: string
  razonSocial: string
  cuit: string | null
  condicionIva: string | null
  condicionCompra: number | null
}

const SELECT = `
  SELECT
    LTRIM(RTRIM(COD_PROVEE))            AS codProvee,
    LTRIM(RTRIM(ISNULL(NOM_PROVEE,''))) AS razonSocial,
    LTRIM(RTRIM(ISNULL(N_CUIT,'')))     AS cuit,
    LTRIM(RTRIM(ISNULL(COND_IVA,'')))   AS condicionIva,
    COND_COMPR                          AS condicionCompra
  FROM CPA01
`

function aProveedor(row: Record<string, unknown>): Proveedor {
  return {
    codProvee: String(row.codProvee),
    razonSocial: String(row.razonSocial),
    cuit: row.cuit ? String(row.cuit) : null,
    condicionIva: row.condicionIva ? String(row.condicionIva) : null,
    condicionCompra:
      row.condicionCompra === null || row.condicionCompra === undefined
        ? null
        : Number(row.condicionCompra),
  }
}

export async function buscarProveedorPorCuit(cuit: string): Promise<Proveedor | null> {
  const norm = normalizarCuit(cuit)
  if (!norm) return null

  const pool = await getPool()
  const r = await pool
    .request()
    .input('cuit', sql.VarChar(11), norm)
    .query(`
      ${SELECT}
      WHERE REPLACE(REPLACE(REPLACE(ISNULL(N_CUIT,''), '-', ''), ' ', ''), '.', '') = @cuit
    `)

  return r.recordset.length ? aProveedor(r.recordset[0]) : null
}

export async function buscarProveedoresPorRazonSocial(
  texto: string,
  limite = 20,
): Promise<Proveedor[]> {
  const t = texto.trim()
  if (t.length < 2) return []

  const pool = await getPool()
  const r = await pool
    .request()
    .input('q', sql.NVarChar(200), `%${t}%`)
    .input('lim', sql.Int, limite)
    .query(`
      ${SELECT.replace('SELECT', 'SELECT TOP (@lim)')}
      WHERE NOM_PROVEE LIKE @q
      ORDER BY NOM_PROVEE
    `)

  return r.recordset.map(aProveedor)
}
```

- [ ] **Step 5: Correr el test**

Run: `pnpm test tests/server/tango/proveedores.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: lectura del maestro de proveedores de Tango

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Consultas de la bandeja

**Files:**
- Create: `src/server/app/comprobantes.ts`, `tests/server/app/comprobantes.test.ts`

**Interfaces:**
- Consumes: `getPool`, `conRollback`, `Estado`, `ClaveTab`
- Produces:
  - `type FilaBandeja = { id: number; estado: Estado; tipo: string | null; puntoVenta: string | null; numero: string | null; fechaEmision: Date | null; razonSocial: string | null; cuit: string | null; total: number | null; confianzaPromedio: number | null }`
  - `type Kpis = { pendientes: number; enObservacion: number; registradosHoy: number; importePendiente: number }`
  - `type Conteos = Record<ClaveTab, number>`
  - `listarComprobantes(opts: { filtro: ClaveTab; query: string; limite?: number; offset?: number }): Promise<{ filas: FilaBandeja[]; total: number }>`
  - `obtenerKpis(): Promise<Kpis>`
  - `contarPorEstado(query: string): Promise<Conteos>`
  - `listarComprobantesEn(e, opts)`, `obtenerKpisEn(e)`, `contarPorEstadoEn(e, query)` — las mismas consultas recibiendo un ejecutor (pool o transacción). Es lo que permite testear sin dejar filas
  - `insertarComprobantePrueba(tx: sql.Transaction, datos: Partial<FilaBandeja> & { estado: Estado }): Promise<number>` — helper para tests

- [ ] **Step 1: Escribir el test que falla**

`tests/server/app/comprobantes.test.ts`. Todo corre dentro de `conRollback` para no dejar filas.

```ts
import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'
import {
  listarComprobantesEn,
  obtenerKpisEn,
  contarPorEstadoEn,
  insertarComprobantePrueba,
} from '@/server/app/comprobantes'

afterAll(async () => {
  await cerrarPool()
})

async function sembrar(tx: sql.Transaction) {
  await insertarComprobantePrueba(tx, {
    estado: 'leido',
    razonSocial: 'DISTRIBUIDORA NORTE SA',
    cuit: '30648729137',
    tipo: 'FAC A',
    numero: '0003-00018742',
    total: 100000,
  })
  await insertarComprobantePrueba(tx, {
    estado: 'observacion',
    razonSocial: 'METALURGICA DEL SUR SRL',
    cuit: '30112223334',
    tipo: 'FAC A',
    numero: '0007-00000912',
    total: 50000,
  })
  await insertarComprobantePrueba(tx, {
    estado: 'registrado',
    razonSocial: 'PAPELERA CENTRO SA',
    cuit: '33556667778',
    tipo: 'FAC B',
    numero: '0001-00004411',
    total: 25000,
  })
}

describe('listarComprobantes', () => {
  it('sin filtro devuelve todo lo sembrado', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: '' })
      expect(r.total).toBe(3)
    })
  })

  it('filtra por estado', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'leido', query: '' })
      expect(r.total).toBe(1)
      expect(r.filas[0].razonSocial).toBe('DISTRIBUIDORA NORTE SA')
    })
  })

  it('busca por razon social sin distinguir mayusculas', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: 'metalurgica' })
      expect(r.total).toBe(1)
    })
  })

  it('busca por CUIT', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: '30648729137' })
      expect(r.total).toBe(1)
    })
  })

  it('busca por numero de comprobante', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: '00018742' })
      expect(r.total).toBe(1)
    })
  })

  it('combina filtro y busqueda con AND', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'registrado', query: 'metalurgica' })
      expect(r.total).toBe(0)
    })
  })

  it('pagina con limite y offset', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: '', limite: 2, offset: 0 })
      expect(r.filas).toHaveLength(2)
      expect(r.total).toBe(3)
    })
  })
})

describe('obtenerKpis', () => {
  it('cuenta pendientes y en observacion, y suma el importe de ambos', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const k = await obtenerKpisEn(tx)
      expect(k.pendientes).toBe(1)
      expect(k.enObservacion).toBe(1)
      expect(k.importePendiente).toBe(150000)
    })
  })
})

describe('contarPorEstado', () => {
  it('devuelve el conteo de cada tab', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const c = await contarPorEstadoEn(tx, '')
      expect(c.todos).toBe(3)
      expect(c.leido).toBe(1)
      expect(c.observacion).toBe(1)
      expect(c.registrado).toBe(1)
      expect(c.confirmado).toBe(0)
      expect(c.error).toBe(0)
    })
  })

  it('aplica la busqueda al conteo', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const c = await contarPorEstadoEn(tx, 'papelera')
      expect(c.todos).toBe(1)
      expect(c.registrado).toBe(1)
    })
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `pnpm test tests/server/app/comprobantes.test.ts`
Expected: FAIL — no existe `@/server/app/comprobantes`.

- [ ] **Step 3: Escribir `src/server/app/comprobantes.ts`**

Cada consulta viene en dos formas: la pública, que usa el pool, y la `*En`, que recibe una transacción. Es lo que permite testear sin dejar filas.

```ts
import sql from 'mssql'
import { getPool } from '../db/pool'
import type { Estado, ClaveTab } from '@/lib/estados'
import { usuarioActual } from '@/lib/usuario'

export type FilaBandeja = {
  id: number
  estado: Estado
  tipo: string | null
  puntoVenta: string | null
  numero: string | null
  fechaEmision: Date | null
  razonSocial: string | null
  cuit: string | null
  total: number | null
  confianzaPromedio: number | null
}

export type Kpis = {
  pendientes: number
  enObservacion: number
  registradosHoy: number
  importePendiente: number
}

export type Conteos = Record<ClaveTab, number>

export type OpcionesListado = {
  filtro: ClaveTab
  query: string
  limite?: number
  offset?: number
}

type Ejecutor = { request(): sql.Request }

// Dos patrones distintos: el de texto conserva espacios y guiones para que
// "metalurgica del" siga matcheando la razon social; el de CUIT los saca de
// los dos lados para que "30-64872913-7" encuentre al que esta guardado sin
// guiones, y al reves.
const WHERE_BUSQUEDA = `
  (@q = ''
   OR RAZON_SOCIAL LIKE @like
   OR NUMERO LIKE @like
   OR REPLACE(REPLACE(REPLACE(ISNULL(CUIT,''), '-', ''), ' ', ''), '.', '') LIKE @likeCuit)
`

function pedido(e: Ejecutor, filtro: ClaveTab, query: string): sql.Request {
  const q = query.trim()
  return e
    .request()
    .input('q', sql.NVarChar(200), q)
    .input('like', sql.NVarChar(210), `%${q}%`)
    .input('likeCuit', sql.NVarChar(210), `%${q.replace(/[-\s.]/g, '')}%`)
    .input('estado', sql.VarChar(20), filtro === 'todos' ? null : filtro)
}

const WHERE_ESTADO = `(@estado IS NULL OR ESTADO = @estado)`

function aFila(row: Record<string, unknown>): FilaBandeja {
  return {
    id: Number(row.ID),
    estado: String(row.ESTADO) as Estado,
    tipo: row.TIPO ? String(row.TIPO) : null,
    puntoVenta: row.PUNTO_VENTA ? String(row.PUNTO_VENTA) : null,
    numero: row.NUMERO ? String(row.NUMERO) : null,
    fechaEmision: row.FECHA_EMISION ? new Date(row.FECHA_EMISION as string) : null,
    razonSocial: row.RAZON_SOCIAL ? String(row.RAZON_SOCIAL) : null,
    cuit: row.CUIT ? String(row.CUIT) : null,
    total: row.TOTAL === null || row.TOTAL === undefined ? null : Number(row.TOTAL),
    confianzaPromedio:
      row.CONFIANZA_PROMEDIO === null || row.CONFIANZA_PROMEDIO === undefined
        ? null
        : Number(row.CONFIANZA_PROMEDIO),
  }
}

export async function listarComprobantesEn(
  e: Ejecutor,
  { filtro, query, limite = 100, offset = 0 }: OpcionesListado,
): Promise<{ filas: FilaBandeja[]; total: number }> {
  const r = await pedido(e, filtro, query)
    .input('lim', sql.Int, limite)
    .input('off', sql.Int, offset)
    .query(`
      SELECT ID, ESTADO, TIPO, PUNTO_VENTA, NUMERO, FECHA_EMISION,
             RAZON_SOCIAL, CUIT, TOTAL, CONFIANZA_PROMEDIO
      FROM PHF_COMPROBANTE
      WHERE ${WHERE_ESTADO} AND ${WHERE_BUSQUEDA}
      ORDER BY FECHA_ALTA DESC, ID DESC
      OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY;

      SELECT COUNT(*) AS total
      FROM PHF_COMPROBANTE
      WHERE ${WHERE_ESTADO} AND ${WHERE_BUSQUEDA};
    `)

  return {
    filas: r.recordsets[0].map(aFila),
    total: Number((r.recordsets[1] as Record<string, unknown>[])[0].total),
  }
}

export async function listarComprobantes(opts: OpcionesListado) {
  return listarComprobantesEn(await getPool(), opts)
}

export async function obtenerKpisEn(e: Ejecutor): Promise<Kpis> {
  const r = await e.request().query(`
    SELECT
      SUM(CASE WHEN ESTADO = 'leido' THEN 1 ELSE 0 END)       AS pendientes,
      SUM(CASE WHEN ESTADO = 'observacion' THEN 1 ELSE 0 END) AS enObservacion,
      SUM(CASE WHEN ESTADO = 'registrado'
                AND CAST(FECHA_REGISTRO AS DATE) = CAST(SYSDATETIME() AS DATE)
               THEN 1 ELSE 0 END)                             AS registradosHoy,
      ISNULL(SUM(CASE WHEN ESTADO IN ('leido','observacion')
                      THEN ISNULL(TOTAL, 0) ELSE 0 END), 0)   AS importePendiente
    FROM PHF_COMPROBANTE
  `)
  const k = r.recordset[0]
  return {
    pendientes: Number(k.pendientes ?? 0),
    enObservacion: Number(k.enObservacion ?? 0),
    registradosHoy: Number(k.registradosHoy ?? 0),
    importePendiente: Number(k.importePendiente ?? 0),
  }
}

export async function obtenerKpis(): Promise<Kpis> {
  return obtenerKpisEn(await getPool())
}

export async function contarPorEstadoEn(e: Ejecutor, query: string): Promise<Conteos> {
  const r = await pedido(e, 'todos', query).query(`
    SELECT ESTADO, COUNT(*) AS n
    FROM PHF_COMPROBANTE
    WHERE ${WHERE_BUSQUEDA}
    GROUP BY ESTADO
  `)

  const c: Conteos = {
    todos: 0,
    procesando: 0,
    leido: 0,
    observacion: 0,
    confirmado: 0,
    registrado: 0,
    error: 0,
  }
  for (const row of r.recordset) {
    c[String(row.ESTADO) as Estado] = Number(row.n)
    c.todos += Number(row.n)
  }
  return c
}

export async function contarPorEstado(query: string): Promise<Conteos> {
  return contarPorEstadoEn(await getPool(), query)
}

/** Inserta un comprobante minimo. Es para los tests, no para la app. */
export async function insertarComprobantePrueba(
  tx: sql.Transaction,
  datos: Partial<FilaBandeja> & { estado: Estado },
): Promise<number> {
  const r = await tx
    .request()
    .input('nombre', sql.NVarChar(260), `prueba-${Date.now()}-${Math.random()}.pdf`)
    .input('ruta', sql.NVarChar(500), 'prueba')
    .input('hash', sql.Char(64), '0'.repeat(64))
    .input('estado', sql.VarChar(20), datos.estado)
    .input('tipo', sql.VarChar(10), datos.tipo ?? null)
    .input('pv', sql.VarChar(10), datos.puntoVenta ?? null)
    .input('numero', sql.VarChar(20), datos.numero ?? null)
    .input('razon', sql.NVarChar(200), datos.razonSocial ?? null)
    .input('cuit', sql.VarChar(15), datos.cuit ?? null)
    .input('total', sql.Decimal(19, 4), datos.total ?? null)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      INSERT INTO PHF_COMPROBANTE
        (ARCHIVO_NOMBRE, ARCHIVO_RUTA, ARCHIVO_HASH, ESTADO, TIPO, PUNTO_VENTA,
         NUMERO, RAZON_SOCIAL, CUIT, TOTAL, USUARIO_ALTA)
      OUTPUT INSERTED.ID
      VALUES (@nombre, @ruta, @hash, @estado, @tipo, @pv,
              @numero, @razon, @cuit, @total, @usuario)
    `)
  return Number(r.recordset[0].ID)
}
```

- [ ] **Step 4: Correr el test**

Run: `pnpm test tests/server/app/comprobantes.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Correr toda la suite**

Run: `pnpm test`
Expected: PASS, 44 tests (3 pool + 3 tx + 4 migrate + 17 lib + 7 proveedores + 10 comprobantes).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: consultas de bandeja con filtro, busqueda, KPIs y conteos

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Header global y componentes compartidos

**Files:**
- Create: `src/components/header-global.tsx`, `src/components/header-global.module.css`, `src/components/badge-estado.tsx`, `src/components/badge-estado.module.css`, `src/components/chip-confianza.tsx`, `src/components/chip-confianza.module.css`
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Consumes: `ESTADOS`, `Estado`, `probarConexion`, `usuarioActual`
- Produces:
  - `<HeaderGlobal />` — server component, consulta el estado de conexión
  - `<BadgeEstado estado={Estado} />`
  - `<ChipConfianza valor={number | null} />` — no renderiza nada si `valor` es `null` o `1`

Medidas de `design/README.md`, secciones "Header global", "Modelo de estados" y "Chip de confianza".

- [ ] **Step 1: Escribir `src/components/badge-estado.tsx`**

```tsx
import { ESTADOS, type Estado } from '@/lib/estados'
import styles from './badge-estado.module.css'

export function BadgeEstado({ estado }: { estado: Estado }) {
  const e = ESTADOS[estado]
  return (
    <span className={styles.badge} style={{ background: e.fondo, color: e.texto }}>
      {e.label}
    </span>
  )
}
```

`src/components/badge-estado.module.css`:

```css
.badge {
  display: inline-flex;
  align-items: center;
  height: 21px;
  padding: 0 9px;
  border-radius: 11px;
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
}
```

- [ ] **Step 2: Escribir `src/components/chip-confianza.tsx`**

Umbrales de `design/README.md`: bajo 0,80 en rojo; entre 0,80 y 0,93 en ámbar; sobre 0,93 en gris. Confianza 1 se oculta.

```tsx
import styles from './chip-confianza.module.css'

const NIVELES = [
  { max: 0.8,  fondo: '#fae7e3', texto: '#a03526' },
  { max: 0.93, fondo: '#fbf0dc', texto: '#8a5a00' },
  { max: 1.01, fondo: '#eef0f2', texto: '#6b7078' },
]

export function ChipConfianza({ valor }: { valor: number | null | undefined }) {
  if (valor === null || valor === undefined || valor >= 1) return null
  const nivel = NIVELES.find((n) => valor < n.max) ?? NIVELES[2]
  return (
    <span className={styles.chip} style={{ background: nivel.fondo, color: nivel.texto }}>
      {Math.round(valor * 100)}%
    </span>
  )
}
```

`src/components/chip-confianza.module.css`:

```css
.chip {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 7px;
  border-radius: 10px;
  font-family: var(--mono);
  font-size: 11px;
}
```

- [ ] **Step 3: Escribir `src/components/header-global.tsx`**

```tsx
import { probarConexion } from '@/server/db/pool'
import { usuarioActual } from '@/lib/usuario'
import styles from './header-global.module.css'

function iniciales(nombre: string): string {
  const partes = nombre.replace(/[._-]/g, ' ').trim().split(/\s+/)
  return partes.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?'
}

export async function HeaderGlobal() {
  const conexion = await probarConexion()
  const usuario = usuarioActual()
  const base = process.env.SQLSERVER_DB ?? ''

  return (
    <header className={styles.header}>
      <div className={styles.logo}>C</div>
      <span className={styles.marca}>Comprobantes</span>
      <span className={styles.seccion}>Cuentas a pagar</span>

      <div className={styles.derecha}>
        <span
          className={styles.punto}
          style={{ background: conexion.ok ? '#3ea37c' : '#a03526' }}
        />
        <span className={styles.conexion}>
          {conexion.ok ? `Tango · BD ${base}` : 'Sin conexión a Tango'}
        </span>

        <div className={styles.usuarioBloque}>
          <span className={styles.avatar}>{iniciales(usuario)}</span>
          <span className={styles.usuario}>{usuario}</span>
        </div>
      </div>
    </header>
  )
}
```

`src/components/header-global.module.css`:

```css
.header {
  display: flex;
  align-items: center;
  gap: 20px;
  flex: none;
  height: 56px;
  padding: 0 24px;
  background: var(--oscuro);
  color: #fff;
}

.logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  background: var(--acento);
  font-size: 12px;
  font-weight: 700;
}

.marca {
  font-size: 14px;
  font-weight: 600;
  margin-left: -12px;
}

.seccion {
  border-left: 1px solid var(--oscuro-2);
  padding-left: 10px;
  font-size: 11px;
  color: var(--texto-5);
  margin-left: -12px;
}

.derecha {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.punto {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.conexion {
  font-size: 12px;
  color: var(--oscuro-texto);
}

.usuarioBloque {
  display: flex;
  align-items: center;
  gap: 8px;
  border-left: 1px solid var(--oscuro-2);
  padding-left: 16px;
  margin-left: 8px;
}

.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--oscuro-3);
  font-size: 11px;
  font-weight: 600;
}

.usuario {
  font-size: 12.5px;
}
```

- [ ] **Step 4: Montar el header en el layout**

Reemplazar `src/app/layout.tsx`:

```tsx
import type { Metadata } from 'next'
import { HeaderGlobal } from '@/components/header-global'
import './globals.css'

export const metadata: Metadata = {
  title: 'Comprobantes · Cuentas a pagar',
  description: 'Importador de comprobantes de compra hacia Tango',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR">
      <body style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <HeaderGlobal />
        {children}
      </body>
    </html>
  )
}
```

- [ ] **Step 5: Verificar en el navegador**

Run: `pnpm dev`
Expected: el header oscuro de 56px se ve arriba, con el punto verde y `Tango · BD PUNTO_HOGAR_1`, y tu usuario de Windows a la derecha. Cortar el server.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: header global, badge de estado y chip de confianza

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Bandeja de comprobantes

**Files:**
- Create: `src/app/comprobantes/page.tsx`, `src/app/comprobantes/bandeja.module.css`, `src/components/bandeja/kpis.tsx`, `src/components/bandeja/filtros.tsx`, `src/components/bandeja/tabla.tsx`, `src/app/comprobantes/[id]/page.tsx`

**Interfaces:**
- Consumes: `listarComprobantes`, `obtenerKpis`, `contarPorEstado`, `ORDEN_TABS`, `BadgeEstado`, `ChipConfianza`, `formatMoneda`, `formatFecha`, `formatCuit`
- Produces: ruta `/comprobantes` funcionando con filtro y búsqueda por query string (`?filtro=leido&q=texto`)

Medidas de `design/README.md`, sección "Bandeja de comprobantes".

- [ ] **Step 1: Escribir `src/components/bandeja/kpis.tsx`**

```tsx
import type { Kpis } from '@/server/app/comprobantes'
import { formatMoneda } from '@/lib/formato'
import styles from './kpis.module.css'

export function FilaKpis({ kpis }: { kpis: Kpis }) {
  const tarjetas = [
    { label: 'Pendientes de revisión', valor: String(kpis.pendientes) },
    { label: 'En observación', valor: String(kpis.enObservacion), color: '#8a5a00' },
    { label: 'Registrados hoy', valor: String(kpis.registradosHoy) },
    { label: 'Importe pendiente', valor: formatMoneda(kpis.importePendiente) },
  ]

  return (
    <div className={styles.grid}>
      {tarjetas.map((t) => (
        <div key={t.label} className={styles.tarjeta}>
          <div className={styles.label}>{t.label}</div>
          <div className={styles.valor} style={t.color ? { color: t.color } : undefined}>
            {t.valor}
          </div>
        </div>
      ))}
    </div>
  )
}
```

`src/components/bandeja/kpis.module.css`:

```css
.grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.tarjeta {
  background: var(--superficie);
  border: 1px solid var(--borde);
  border-radius: 9px;
  padding: 15px 17px;
}

.label {
  font-size: 11.5px;
  color: #7b7f87;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: 8px;
}

.valor {
  font-family: var(--mono);
  font-size: 27px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
```

- [ ] **Step 2: Escribir `src/components/bandeja/filtros.tsx`**

Es un client component: el buscador necesita debounce de 250 ms y empuja el estado a la URL.

```tsx
'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import { ORDEN_TABS, type ClaveTab } from '@/lib/estados'
import type { Conteos } from '@/server/app/comprobantes'
import styles from './filtros.module.css'

export function Filtros({ filtro, query, conteos }: {
  filtro: ClaveTab
  query: string
  conteos: Conteos
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [texto, setTexto] = useState(query)
  const [, startTransition] = useTransition()

  function navegar(next: URLSearchParams) {
    startTransition(() => router.replace(`/comprobantes?${next.toString()}`))
  }

  useEffect(() => {
    if (texto === query) return
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString())
      if (texto) next.set('q', texto)
      else next.delete('q')
      navegar(next)
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texto])

  function cambiarFiltro(clave: ClaveTab) {
    const next = new URLSearchParams(params.toString())
    if (clave === 'todos') next.delete('filtro')
    else next.set('filtro', clave)
    navegar(next)
  }

  return (
    <div className={styles.fila}>
      {ORDEN_TABS.map((t) => {
        const activo = t.clave === filtro
        return (
          <button
            key={t.clave}
            type="button"
            onClick={() => cambiarFiltro(t.clave)}
            className={activo ? `${styles.tab} ${styles.tabActivo}` : styles.tab}
          >
            {t.label}
            <span className={activo ? styles.countActivo : styles.count}>
              {conteos[t.clave]}
            </span>
          </button>
        )
      })}

      <div className={styles.buscador}>
        <span className={styles.lupa}>⌕</span>
        <input
          className={styles.input}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder="Buscar proveedor, CUIT o número"
        />
      </div>
    </div>
  )
}
```

`src/components/bandeja/filtros.module.css`:

```css
.fila {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 13px;
  border-radius: 7px;
  font-size: 13px;
  background: var(--superficie);
  border: 1px solid var(--borde);
  color: #4a4e56;
}

.tabActivo {
  background: var(--oscuro);
  border-color: var(--oscuro);
  color: #fff;
}

.count {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--texto-6);
}

.countActivo {
  font-family: var(--mono);
  font-size: 11.5px;
  color: #a8abb2;
}

.buscador {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  min-width: 260px;
  height: 34px;
  padding: 0 12px;
  background: var(--superficie);
  border: 1px solid var(--borde);
  border-radius: 7px;
}

.lupa {
  color: var(--texto-6);
}

.input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--texto);
}
```

- [ ] **Step 3: Escribir `src/components/bandeja/tabla.tsx`**

El grid de columnas es idéntico en header y filas, tal como pide el diseño.

```tsx
import Link from 'next/link'
import type { FilaBandeja } from '@/server/app/comprobantes'
import { BadgeEstado } from '@/components/badge-estado'
import { ChipConfianza } from '@/components/chip-confianza'
import { formatMoneda, formatFecha, formatCuit } from '@/lib/formato'
import styles from './tabla.module.css'

export function Tabla({ filas }: { filas: FilaBandeja[] }) {
  if (filas.length === 0) {
    return (
      <div className={styles.contenedor}>
        <div className={styles.vacio}>No hay comprobantes con este filtro.</div>
      </div>
    )
  }

  return (
    <div className={styles.contenedor}>
      <div className={styles.scroll}>
        <div className={styles.header}>
          <span>Estado</span>
          <span>Tipo</span>
          <span>Comprobante</span>
          <span>Fecha</span>
          <span>Proveedor</span>
          <span>CUIT</span>
          <span className={styles.derecha}>Total</span>
          <span className={styles.centro}>Confianza</span>
          <span />
        </div>

        {filas.map((f) => (
          <Link key={f.id} href={`/comprobantes/${f.id}`} className={styles.fila}>
            <span><BadgeEstado estado={f.estado} /></span>
            <span className={styles.tipo}>{f.tipo ?? '—'}</span>
            <span className={styles.mono}>{f.numero ?? '—'}</span>
            <span className={styles.monoTenue}>{formatFecha(f.fechaEmision)}</span>
            <span className={styles.proveedor}>{f.razonSocial ?? '—'}</span>
            <span className={styles.monoTenue}>{formatCuit(f.cuit)}</span>
            <span className={styles.total}>{formatMoneda(f.total)}</span>
            <span className={styles.centro}><ChipConfianza valor={f.confianzaPromedio} /></span>
            <span className={styles.chevron}>›</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
```

`src/components/bandeja/tabla.module.css`:

```css
.contenedor {
  background: var(--superficie);
  border: 1px solid var(--borde);
  border-radius: 10px;
  overflow-x: auto;
}

.scroll {
  min-width: 1010px;
}

.header,
.fila {
  display: grid;
  grid-template-columns: 170px 92px 148px 100px minmax(200px, 1fr) 132px 132px 96px 44px;
  align-items: center;
  padding: 0 16px;
}

.header {
  height: 38px;
  background: var(--fondo-header-tabla);
  border-bottom: 1px solid var(--borde);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--texto-4);
  font-weight: 500;
}

.fila {
  height: 50px;
  border-bottom: 1px solid var(--borde-sutil);
  cursor: pointer;
  text-decoration: none;
  color: inherit;
}

.fila:hover {
  background: #f7f6f3;
}

.tipo {
  font-size: 13px;
  color: #4a4e56;
}

.mono {
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--texto);
}

.monoTenue {
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--texto-2);
}

.proveedor {
  font-size: 13.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-right: 14px;
}

.total {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 500;
  text-align: right;
}

.derecha {
  text-align: right;
}

.centro {
  text-align: center;
}

.chevron {
  font-size: 15px;
  color: #b0b4bb;
  text-align: right;
}

.vacio {
  padding: 52px;
  text-align: center;
  font-size: 13.5px;
  color: var(--texto-5);
}
```

- [ ] **Step 4: Escribir `src/app/comprobantes/page.tsx`**

El botón "+ Importar PDF" queda deshabilitado en Fase 1: la importación llega en Fase 2.

```tsx
import { listarComprobantes, obtenerKpis, contarPorEstado } from '@/server/app/comprobantes'
import type { ClaveTab } from '@/lib/estados'
import { ORDEN_TABS } from '@/lib/estados'
import { FilaKpis } from '@/components/bandeja/kpis'
import { Filtros } from '@/components/bandeja/filtros'
import { Tabla } from '@/components/bandeja/tabla'
import styles from './bandeja.module.css'

export const dynamic = 'force-dynamic'

function leerFiltro(v: string | undefined): ClaveTab {
  const valido = ORDEN_TABS.some((t) => t.clave === v)
  return valido ? (v as ClaveTab) : 'todos'
}

export default async function BandejaPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string; q?: string }>
}) {
  const sp = await searchParams
  const filtro = leerFiltro(sp.filtro)
  const query = sp.q ?? ''

  const [{ filas, total }, kpis, conteos] = await Promise.all([
    listarComprobantes({ filtro, query }),
    obtenerKpis(),
    contarPorEstado(query),
  ])

  return (
    <main className={styles.main}>
      <div className={styles.contenido}>
        <div className={styles.titulo}>
          <div>
            <h1 className={styles.h1}>Bandeja de comprobantes</h1>
            <p className={styles.sub}>
              Importá los PDF, revisá lo que leyó la IA y registralo en Tango.
            </p>
          </div>
          <button type="button" className={styles.primario} disabled title="Disponible en la Fase 2">
            + Importar PDF
          </button>
        </div>

        <FilaKpis kpis={kpis} />
        <Filtros filtro={filtro} query={query} conteos={conteos} />
        <Tabla filas={filas} />

        <p className={styles.pie}>{total} comprobantes</p>
      </div>
    </main>
  )
}
```

`src/app/comprobantes/bandeja.module.css`:

```css
.main {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: block;
}

.contenido {
  max-width: 1560px;
  margin: 0 auto;
  padding: 26px 28px 40px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.titulo {
  display: flex;
  align-items: flex-start;
}

.h1 {
  margin: 0;
  font-size: 23px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--texto);
}

.sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: #6b7078;
}

.primario {
  margin-left: auto;
  height: 38px;
  padding: 0 17px;
  background: var(--oscuro);
  color: #fff;
  font-size: 13.5px;
  font-weight: 500;
  border: none;
  border-radius: 7px;
}

.primario:hover:not(:disabled) {
  background: var(--acento);
}

.primario:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.pie {
  margin: -4px 0 0;
  font-size: 12px;
  color: var(--texto-5);
}
```

- [ ] **Step 5: Escribir el stub de revisión**

`src/app/comprobantes/[id]/page.tsx`:

```tsx
import Link from 'next/link'

export default async function RevisionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return (
    <main style={{ padding: 28 }}>
      <Link href="/comprobantes">← Bandeja</Link>
      <p style={{ marginTop: 16, color: '#6b7078', fontSize: 13 }}>
        Revisión del comprobante {id}. Llega en la Fase 2.
      </p>
    </main>
  )
}
```

- [ ] **Step 6: Sembrar datos de muestra para poder mirar la bandeja**

Este script inserta comprobantes de prueba en `PHF_COMPROBANTE`. Se borran con el `DELETE` del final de este mismo paso cuando ya no hagan falta.

`scripts/seed.ts`:

```ts
import { config as cargarEnv } from 'dotenv'
import sql from 'mssql'
import { getPool, cerrarPool } from '../src/server/db/pool'

cargarEnv({ path: '.env.local' })

const MUESTRAS = [
  { estado: 'leido',       tipo: 'FAC A', pv: '0003', nro: '0003-00018742', razon: 'DISTRIBUIDORA NORTE SA',    cuit: '30648729137', total: 1284500.5,  conf: 0.96 },
  { estado: 'leido',       tipo: 'FAC A', pv: '0007', nro: '0007-00000912', razon: 'METALURGICA DEL SUR SRL',   cuit: '30112223334', total: 486320.0,   conf: 0.78 },
  { estado: 'observacion', tipo: 'FAC B', pv: '0001', nro: '0001-00004411', razon: 'PAPELERA CENTRO SA',        cuit: '33556667778', total: 92150.75,   conf: 0.88 },
  { estado: 'confirmado',  tipo: 'FAC A', pv: '0012', nro: '0012-00033201', razon: 'INSUMOS INDUSTRIALES SRL',  cuit: '30777888990', total: 2310000.0,  conf: 0.99 },
  { estado: 'registrado',  tipo: 'FAC A', pv: '0005', nro: '0005-00071044', razon: 'TRANSPORTE ANDINO SA',      cuit: '30999111223', total: 154800.0,   conf: 1 },
  { estado: 'error',       tipo: null,    pv: null,   nro: null,            razon: null,                        cuit: null,          total: null,       conf: null },
]

async function sembrar() {
  const pool = await getPool()
  for (const m of MUESTRAS) {
    await pool
      .request()
      .input('nombre', sql.NVarChar(260), `muestra-${m.nro ?? 'ilegible'}.pdf`)
      .input('ruta', sql.NVarChar(500), 'muestra')
      .input('hash', sql.Char(64), '0'.repeat(64))
      .input('estado', sql.VarChar(20), m.estado)
      .input('tipo', sql.VarChar(10), m.tipo)
      .input('pv', sql.VarChar(10), m.pv)
      .input('nro', sql.VarChar(20), m.nro)
      .input('fecha', sql.Date, new Date())
      .input('razon', sql.NVarChar(200), m.razon)
      .input('cuit', sql.VarChar(15), m.cuit)
      .input('total', sql.Decimal(19, 4), m.total)
      .input('conf', sql.Decimal(5, 4), m.conf)
      .input('reg', sql.DateTime2, m.estado === 'registrado' ? new Date() : null)
      .query(`
        INSERT INTO PHF_COMPROBANTE
          (ARCHIVO_NOMBRE, ARCHIVO_RUTA, ARCHIVO_HASH, ESTADO, TIPO, PUNTO_VENTA, NUMERO,
           FECHA_EMISION, RAZON_SOCIAL, CUIT, TOTAL, CONFIANZA_PROMEDIO, FECHA_REGISTRO, USUARIO_ALTA)
        VALUES (@nombre, @ruta, @hash, @estado, @tipo, @pv, @nro,
                @fecha, @razon, @cuit, @total, @conf, @reg, 'seed')
      `)
  }
  console.log(`Sembrados ${MUESTRAS.length} comprobantes de muestra.`)
}

sembrar()
  .catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
  .finally(() => cerrarPool())
```

Agregar a los scripts de `package.json`: `"seed": "tsx scripts/seed.ts"`.

Run: `pnpm seed`
Expected: `Sembrados 6 comprobantes de muestra.`

Para borrarlos cuando ya no hagan falta:
```bash
sqlcmd -S "INFOSYS01\AXSQLSERVER" -U Axoft -P "<ver .env.local>" -d PUNTO_HOGAR_1 -Q "DELETE FROM PHF_COMPROBANTE WHERE USUARIO_ALTA = 'seed'"
```

- [ ] **Step 7: Verificar la bandeja en el navegador**

Run: `pnpm dev`

Verificar en `http://localhost:3000/comprobantes`, con la ventana en 1280px o más:
- Los 4 KPIs muestran 2 pendientes, 1 en observación, 1 registrado hoy, y `$ 1.862.971,25` de importe pendiente (1.284.500,50 + 486.320,00 de los pendientes, más 92.150,75 del que está en observación).
- Los 6 tabs muestran sus conteos, y al hacer clic la tabla filtra y la URL cambia.
- Escribir "metalurgica" en el buscador deja una sola fila, con un cuarto de segundo de demora.
- Escribir "30-64872913-7" también encuentra, porque la búsqueda ignora los guiones.
- Los importes, CUIT, fechas y números están en IBM Plex Mono y alinean sus dígitos.
- El chip de confianza del comprobante registrado no aparece, porque su confianza es 1.
- Clic en una fila lleva al stub de revisión.
- Filtrar por "Con error" muestra la fila sin datos; filtrar por un tab sin resultados muestra "No hay comprobantes con este filtro."

Cortar el server.

- [ ] **Step 8: Correr toda la suite**

Run: `pnpm test`
Expected: PASS, 44 tests (3 pool + 3 tx + 4 migrate + 17 lib + 7 proveedores + 10 comprobantes).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: bandeja de comprobantes con KPIs, filtros, busqueda y tabla

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Qué queda para las fases siguientes

- **Fase 2** — importación de PDFs, extracción con Claude, pantalla de revisión con resaltado por capa de texto.
- **Fase 3** — las cuatro validaciones, modal de observación, confirmación, auditoría, toasts, atajos de teclado.
- **Fase 4** — registro en Tango: la transacción de la sección 9 del spec, y la asociación de remitos.

Cada una lleva su propio plan.

## Riesgos de esta fase

- **SQL Browser.** La conexión por nombre de instancia (`INFOSYS01\AXSQLSERVER`) necesita el servicio SQL Server Browser corriendo. Si está detenido, `getPool` falla con un error de instancia. Alternativa: averiguar el puerto TCP fijo de la instancia y usar `port` en lugar de `instanceName`.
- **Nombre de la columna de razón social en `CPA01`.** El plan usa `NOM_PROVEE`, que es lo habitual en Tango pero no está verificado. El Step 1 de la Task 5 lo confirma antes de escribir código.
- **`usuarioActual()` devuelve el usuario del proceso.** Sirve mientras cada operador corra la app en su PC. Si se sirve desde un servidor central, todos los comprobantes quedarían con la cuenta del servicio. Es una limitación asumida de la decisión "sin login", y está documentada en el propio módulo.
- **Los tests escriben en la base.** Todos van dentro de `conRollback`, así que no dejan filas. Si un test se interrumpe a la fuerza, la transacción queda abierta hasta que el pool la cierre; en el peor caso hay que reiniciar el proceso de test.
