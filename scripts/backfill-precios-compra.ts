/**
 * Pone al día `STA12` con las facturas que la app ya registró antes de
 * empezar a escribir esa tabla (2026-09-23).
 *
 * La app venía registrando en `CPA46` sin tocar el precio de última compra,
 * así que los artículos de esas facturas quedaron con el precio de una
 * compra anterior -- o sin fila, si nunca se habían comprado. Cualquier
 * informe de última compra o de costo de reposición de esos artículos daba
 * mal. De acá en más lo escribe `registrarComprobanteEn`; esto arregla lo
 * que quedó atrás.
 *
 * **Por defecto no escribe nada**: muestra qué cambiaría. Para aplicarlo:
 *
 *   pnpm tsx scripts/backfill-precios-compra.ts --aplicar
 *
 * A diferencia del registro en vivo --que pisa siempre, porque es la última
 * compra REGISTRADA (decisión del usuario, 2026-09-23)--, acá se saltea el
 * artículo cuyo `FECHA_ULC` actual sea POSTERIOR a la factura de la app:
 * eso significa que después se cargó otra compra desde Tango, y esa es la
 * que vale. Un backfill que corre semanas más tarde no puede hacer de
 * cuenta que el tiempo no pasó.
 */
import { config as cargarEnv } from 'dotenv'
cargarEnv({ path: '.env.local' })

import { conTransaccion } from '../src/server/db/tx'
import { getPool, cerrarPool } from '../src/server/db/pool'
import { actualizarPrecioUltimaCompraEn } from '../src/server/tango/preciosCompra'

type Fila = {
  art: string
  descripcion: string
  ncomp: number
  fechaCont: Date
  precio: number
  codProvee: string
  cotizacion: number
  monCte: boolean
  precioActual: number | null
  fechaActual: Date | null
}

/**
 * La última factura REGISTRADA POR LA APP de cada artículo, con lo que
 * STA12 dice hoy al lado. Solo las que la app grabó: las cargadas desde
 * Tango ya actualizaron STA12 por su cuenta.
 */
async function pendientes(): Promise<Fila[]> {
  const pool = await getPool()
  const r = await pool.request().query<Record<string, unknown>>(`
    WITH deLaApp AS (
      SELECT r.COD_ARTICU, r.PRECIO_NET, h.COD_PROVEE, h.FECHA_CONT, h.NCOMP_IN_C,
             h.COTIZACION, h.MON_CTE,
             ROW_NUMBER() OVER (
               PARTITION BY r.COD_ARTICU ORDER BY h.FECHA_CONT DESC, h.NCOMP_IN_C DESC
             ) AS rn
      FROM CPA46 r
      JOIN CPA04 h ON h.TCOMP_IN_C = r.TCOMP_IN_C AND h.NCOMP_IN_C = r.NCOMP_IN_C
      WHERE r.TCOMP_IN_C = 'FP'
        AND h.NCOMP_IN_C IN (
          SELECT TANGO_NCOMP_IN_C FROM PHF_COMPROBANTE WHERE TANGO_NCOMP_IN_C IS NOT NULL
        )
    )
    SELECT LTRIM(RTRIM(d.COD_ARTICU)) AS art,
           LTRIM(RTRIM(ISNULL(a.DESCRIPCIO, ''))) AS descripcion,
           d.NCOMP_IN_C AS ncomp, d.FECHA_CONT AS fechaCont, d.PRECIO_NET AS precio,
           LTRIM(RTRIM(d.COD_PROVEE)) AS codProvee, d.COTIZACION AS cotizacion,
           d.MON_CTE AS monCte,
           s.PRECIO_U_L AS precioActual, s.FECHA_ULC AS fechaActual
    FROM deLaApp d
    LEFT JOIN STA12 s ON s.COD_ARTICU = d.COD_ARTICU
    LEFT JOIN STA11 a ON a.COD_ARTICU = d.COD_ARTICU
    WHERE d.rn = 1
      AND (s.COD_ARTICU IS NULL
           OR ABS(ISNULL(s.PRECIO_U_L, 0) - d.PRECIO_NET) > 0.005
           OR s.FECHA_ULC <> d.FECHA_CONT)
    ORDER BY art
  `)
  return r.recordset.map((x) => ({
    art: String(x.art),
    descripcion: String(x.descripcion),
    ncomp: Number(x.ncomp),
    fechaCont: new Date(x.fechaCont as string),
    precio: Number(x.precio),
    codProvee: String(x.codProvee),
    cotizacion: Number(x.cotizacion),
    monCte: Boolean(x.monCte),
    precioActual: x.precioActual === null ? null : Number(x.precioActual),
    fechaActual: x.fechaActual === null ? null : new Date(x.fechaActual as string),
  }))
}

const fecha = (d: Date | null) => (d === null ? '—' : d.toLocaleDateString('es-AR'))
const plata = (n: number | null) =>
  n === null ? '(sin fila)' : n.toLocaleString('es-AR', { minimumFractionDigits: 2 })

async function main() {
  const aplicar = process.argv.includes('--aplicar')
  const filas = await pendientes()

  // Una compra POSTERIOR cargada desde Tango gana: no se pisa.
  const masNueva = filas.filter((f) => f.fechaActual !== null && f.fechaActual > f.fechaCont)
  const aCorregir = filas.filter((f) => !masNueva.includes(f))

  console.table(
    aCorregir.map((f) => ({
      articulo: f.art,
      descripcion: f.descripcion.slice(0, 28),
      factura: f.ncomp,
      fecha: fecha(f.fechaCont),
      precio: plata(f.precio),
      'STA12 hoy': plata(f.precioActual),
      'STA12 fecha': fecha(f.fechaActual),
      accion: f.precioActual === null ? 'crear fila' : 'actualizar',
    })),
  )
  console.log(`a corregir: ${aCorregir.length}`)
  if (masNueva.length > 0) {
    console.log(
      `se saltean ${masNueva.length} con una compra posterior cargada desde Tango: ` +
        masNueva.map((f) => f.art).join(', '),
    )
  }

  if (!aplicar) {
    console.log('\nSimulacion: no se escribio nada. Para aplicarlo:')
    console.log('  pnpm tsx scripts/backfill-precios-compra.ts --aplicar')
    await cerrarPool()
    return
  }

  // Todo en una transaccion: o queda STA12 entera al dia, o no se toca nada.
  await conTransaccion(async (tx) => {
    for (const f of aCorregir) {
      await actualizarPrecioUltimaCompraEn(tx, {
        codArticu: f.art,
        precioNeto: f.precio,
        codProvee: f.codProvee,
        fechaContable: f.fechaCont,
        cotizacion: f.cotizacion,
        monCte: f.monCte,
      })
    }
  })
  console.log(`\nListo: ${aCorregir.length} articulo(s) actualizado(s) en STA12.`)
  await cerrarPool()
}

main().catch(async (e) => {
  console.error(e)
  await cerrarPool()
  process.exit(1)
})
