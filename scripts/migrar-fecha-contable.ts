/**
 * Completa la fecha contable de los comprobantes que ya estaban en la
 * bandeja cuando se agregó el campo (2026-09-07).
 *
 * Los nuevos la calculan solos al leerse (`calcularFechaContableEn` en
 * completarLectura.ts) y al corregir la fecha de emisión; los que ya estaban cargados
 * quedarían con el campo vacío hasta que alguien los tocara. Usa la misma
 * función que la cola, así que si la regla cambia, cambia en los dos lados.
 *
 * Es idempotente y no pisa una corrección del operador. Los comprobantes en
 * `registrado` o `existente` no se tocan: `guardarCampoEn` los rechaza por
 * su cuenta.
 *
 *   pnpm tsx scripts/migrar-fecha-contable.ts
 */
import { config as cargarEnv } from 'dotenv'
import { getPool, cerrarPool } from '../src/server/db/pool'
import { conTransaccion } from '../src/server/db/tx'
import { calcularFechaContableEn } from '../src/server/app/completarLectura'
import { cierreContable } from '../src/server/tango/parametros'

cargarEnv({ path: '.env.local' })

async function main() {
  const pool = await getPool()

  const cierre = await cierreContable()
  console.log(`Cierre contable de Tango (CPA10.CIERRE_CON): ${cierre ? cierre.toLocaleDateString('es-AR') : '(sin cierre)'}\n`)

  const candidatos = await pool.request().query<{ ID: number }>(`
    SELECT c.ID
    FROM PHF_COMPROBANTE c
    WHERE c.ESTADO NOT IN ('registrado', 'existente')
      AND EXISTS (
        SELECT 1 FROM PHF_CAMPO k
        WHERE k.COMPROBANTE_ID = c.ID AND k.CLAVE = 'fecha'
          AND LTRIM(RTRIM(ISNULL(k.VALOR_FINAL, ''))) <> '')
    ORDER BY c.ID
  `)

  let completados = 0
  let corridos = 0
  for (const fila of candidatos.recordset) {
    const antes = await pool.request().query<{ v: string | null }>(`
      SELECT VALOR_FINAL AS v FROM PHF_CAMPO
      WHERE COMPROBANTE_ID = ${fila.ID} AND CLAVE = 'fecha'`)
    const contable = await conTransaccion((tx) => calcularFechaContableEn(tx, fila.ID))
    if (!contable) continue
    completados += 1
    if (contable !== (antes.recordset[0]?.v ?? '').trim()) {
      corridos += 1
      console.log(`  comprobante ${fila.ID}: emisión ${antes.recordset[0]?.v} → contable ${contable}`)
    }
  }

  console.log(
    `\nCompletados ${completados} de ${candidatos.recordset.length} comprobante(s); ` +
      `${corridos} quedaron con fecha contable distinta de la de emisión.`,
  )

  await cerrarPool()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
