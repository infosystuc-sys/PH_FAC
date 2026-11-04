/**
 * Informe del costo de IA por comprobante (2026-11-03). Solo lee
 * PHF_COMPROBANTE.
 *
 *   pnpm costo-ia        -> últimos 30 días
 *   pnpm costo-ia 7      -> últimos 7 días
 *
 * Cuenta solo los comprobantes con consumo medido (IA_LLAMADAS no NULL):
 * los leídos antes de que existieran esas columnas no tienen dato. Los
 * tokens son acumulados por comprobante, así que un reproceso o un
 * reintento cuentan, que es lo que se paga. El costo sale de las tarifas de
 * src/lib/usoIa.ts; un modelo sin tarifa muestra "s/tarifa".
 */
import { config as cargarEnv } from 'dotenv'
import sql from 'mssql'
import { getPool, cerrarPool } from '../src/server/db/pool'
import { costoUsd, type UsoTokens } from '../src/lib/usoIa'

cargarEnv({ path: '.env.local' })

// Los que fallaron antes de la primera lectura buena no tienen modelo
// grabado: se les asume el que usa la app.
const MODELO_DEFAULT = process.env.ANTHROPIC_MODELO || 'claude-opus-5'

type Fila = UsoTokens & { comprobantes: number; llamadas: number; modelo: string }

function sumar(filas: Fila[]): Fila & { costo: number | null } {
  const t: Fila = {
    comprobantes: 0, llamadas: 0, entrada: 0, salida: 0, cacheLectura: 0, cacheEscritura: 0, modelo: '',
  }
  let costo: number | null = 0
  for (const f of filas) {
    t.comprobantes += f.comprobantes
    t.llamadas += f.llamadas
    t.entrada += f.entrada
    t.salida += f.salida
    t.cacheLectura += f.cacheLectura
    t.cacheEscritura += f.cacheEscritura
    const c = costoUsd(f.modelo, f)
    costo = c === null || costo === null ? null : costo + c
  }
  return { ...t, costo }
}

const n = (x: number) => x.toLocaleString('es-AR')
const usd = (x: number | null) => (x === null ? 's/tarifa' : `US$ ${x.toFixed(4)}`)

function linea(etiqueta: string, filas: Fila[]): string {
  const t = sumar(filas)
  const porComp = t.costo === null || t.comprobantes === 0 ? null : t.costo / t.comprobantes
  return [
    etiqueta.padEnd(12),
    String(t.comprobantes).padStart(6),
    String(t.llamadas).padStart(8),
    n(t.entrada).padStart(12),
    n(t.cacheLectura + t.cacheEscritura).padStart(10),
    n(t.salida).padStart(11),
    usd(t.costo).padStart(14),
    usd(porComp).padStart(14),
  ].join('  ')
}

async function main() {
  const dias = Math.max(1, Number(process.argv[2]) || 30)
  const pool = await getPool()
  const r = await pool.request().input('dias', sql.Int, dias).query(`
    SELECT CAST(FECHA_ALTA AS DATE) AS DIA,
           ISNULL(TIPO_FACTURA, '(sin tipo)') AS TIPO,
           EXTRACCION_MODELO AS MODELO,
           COUNT(*) AS COMPROBANTES,
           SUM(IA_LLAMADAS) AS LLAMADAS,
           SUM(CAST(IA_TOKENS_ENTRADA AS BIGINT)) AS ENTRADA,
           SUM(CAST(IA_TOKENS_SALIDA AS BIGINT)) AS SALIDA,
           SUM(CAST(ISNULL(IA_TOKENS_CACHE_LECTURA, 0) AS BIGINT)) AS CACHE_LECTURA,
           SUM(CAST(ISNULL(IA_TOKENS_CACHE_ESCRITURA, 0) AS BIGINT)) AS CACHE_ESCRITURA
    FROM PHF_COMPROBANTE
    WHERE IA_LLAMADAS IS NOT NULL
      AND FECHA_ALTA >= DATEADD(DAY, -@dias, CAST(SYSDATETIME() AS DATE))
    GROUP BY CAST(FECHA_ALTA AS DATE), ISNULL(TIPO_FACTURA, '(sin tipo)'), EXTRACCION_MODELO
  `)

  const filas = r.recordset.map((x) => ({
    dia: (x.DIA as Date).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }),
    tipo: String(x.TIPO),
    comprobantes: Number(x.COMPROBANTES),
    llamadas: Number(x.LLAMADAS),
    entrada: Number(x.ENTRADA),
    salida: Number(x.SALIDA),
    cacheLectura: Number(x.CACHE_LECTURA),
    cacheEscritura: Number(x.CACHE_ESCRITURA),
    modelo: (x.MODELO as string | null) ?? MODELO_DEFAULT,
  }))

  console.log(`Costo de IA — últimos ${dias} días (solo comprobantes con consumo medido)\n`)
  if (filas.length === 0) {
    console.log('Sin comprobantes medidos en el período.')
    return
  }

  const encabezado = [
    ''.padEnd(12), 'COMPR.'.padStart(6), 'LLAMADOS'.padStart(8), 'TOK. ENTRADA'.padStart(12),
    'TOK. CACHÉ'.padStart(10), 'TOK. SALIDA'.padStart(11), 'COSTO'.padStart(14), 'POR COMPR.'.padStart(14),
  ].join('  ')

  const agrupar = (clave: (f: (typeof filas)[number]) => string) => {
    const m = new Map<string, Fila[]>()
    for (const f of filas) m.set(clave(f), [...(m.get(clave(f)) ?? []), f])
    return m
  }

  console.log('POR TIPO')
  console.log(encabezado)
  for (const [tipo, fs] of [...agrupar((f) => f.tipo)].sort()) console.log(linea(tipo, fs))
  console.log(linea('TOTAL', filas))

  console.log('\nPOR DÍA')
  console.log(encabezado)
  const porDia = [...agrupar((f) => f.dia)].sort(([a], [b]) =>
    a.split('/').reverse().join('').localeCompare(b.split('/').reverse().join('')),
  )
  for (const [dia, fs] of porDia) console.log(linea(dia, fs))
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => cerrarPool())
