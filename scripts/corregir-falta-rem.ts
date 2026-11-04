/**
 * Corrige `CPA46.FALTA_REM` en las facturas que registró la app antes del
 * 2026-11-03 (etapa 2 de docs/superpowers/plans/2026-11-03-cpa-oc-remito-factura.md,
 * aprobada por el usuario ese mismo día).
 *
 * Hasta esa fecha la app grababa `FALTA_REM = 0`. La regla de Tango es
 * `CANTIDAD − lo cubierto por remitos (CPA48)`, y cuando un remito entra
 * después de la factura, Tango le resta lo recibido: los renglones de la app
 * quedaron negativos (−35 en la 17537). Esto deja cada renglón como lo
 * hubiera dejado Tango. Solo toca facturas que grabó la app.
 *
 * **Por defecto no escribe nada**: muestra qué cambiaría. Para aplicarlo:
 *
 *   pnpm tsx scripts/corregir-falta-rem.ts --aplicar
 */
import { config as cargarEnv } from 'dotenv'
cargarEnv({ path: '.env.local' })

import sql from 'mssql'
import { conTransaccion } from '../src/server/db/tx'
import { getPool, cerrarPool } from '../src/server/db/pool'
import {
  faltaRemDesalineadosEn,
  corregirFaltaRemEn,
  type FaltaRemDesalineado,
} from '../src/server/tango/remitosFactura'
import { auditarEn } from '../src/server/app/detalle'

/** Las facturas de artículos que registró la app (tabla propia, no del ERP). */
async function facturasDeLaApp(): Promise<{ id: number; ncompInC: number; nComp: string }[]> {
  const pool = await getPool()
  const r = await pool.request().input('tipo', sql.VarChar(20), 'articulos').query(`
    SELECT ID, TANGO_NCOMP_IN_C, ISNULL(TANGO_N_COMP, '') AS N_COMP
    FROM PHF_COMPROBANTE
    WHERE ESTADO = 'registrado' AND TIPO_FACTURA = @tipo AND TANGO_NCOMP_IN_C IS NOT NULL
    ORDER BY TANGO_NCOMP_IN_C`)
  return r.recordset.map((x) => ({
    id: Number(x.ID),
    ncompInC: Number(x.TANGO_NCOMP_IN_C),
    nComp: String(x.N_COMP).trim(),
  }))
}

async function main() {
  const aplicar = process.argv.includes('--aplicar')
  const pool = await getPool()

  const aCorregir: { factura: { id: number; ncompInC: number; nComp: string }; d: FaltaRemDesalineado }[] = []
  for (const f of await facturasDeLaApp()) {
    for (const d of await faltaRemDesalineadosEn(pool, f.ncompInC)) aCorregir.push({ factura: f, d })
  }

  console.table(
    aCorregir.map(({ factura, d }) => ({
      interno: factura.ncompInC,
      comprobante: factura.nComp,
      renglon: d.nRenglC,
      articulo: d.codArticu,
      cantidad: d.cantidad,
      'cubierto CPA48': d.cubierto,
      'FALTA_REM hoy': d.faltaRemActual,
      'FALTA_REM nuevo': d.faltaRemCorrecto,
    })),
  )
  const facturas = new Set(aCorregir.map((x) => x.factura.ncompInC)).size
  const negativos = aCorregir.filter((x) => x.d.faltaRemActual < 0).length
  console.log(`a corregir: ${aCorregir.length} renglones de ${facturas} facturas (${negativos} hoy negativos)`)

  if (!aplicar) {
    console.log('\nNo se escribió nada. Para aplicarlo: pnpm tsx scripts/corregir-falta-rem.ts --aplicar')
    return
  }
  if (aCorregir.length === 0) return

  await conTransaccion(async (tx) => {
    for (const { factura, d } of aCorregir) {
      await corregirFaltaRemEn(tx, factura.ncompInC, d)
      await auditarEn(
        tx,
        factura.id,
        `Corregido en Tango el pendiente de remito (FALTA_REM) del renglón ${d.nRenglC} (${d.codArticu}): ` +
          `${d.faltaRemActual} → ${d.faltaRemCorrecto}`,
      )
    }
  })
  console.log(`\nCorregidos ${aCorregir.length} renglones.`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => cerrarPool())
