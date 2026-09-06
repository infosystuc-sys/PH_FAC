/**
 * Manda a los slots de alícuota las percepciones de IVA que quedaron
 * atrapadas en los de impuestos varios, en los comprobantes ya leídos.
 *
 * Desde el 2026-09-06 la cola lo hace sola al procesar (`mudarPercepcionIvaEn`
 * en cola.ts), pero los comprobantes que ya estaban en la bandeja quedaron
 * como estaban: con el desplegable de "Impuestos varios" en rojo y ninguna
 * opción correcta para elegir, porque los códigos de percepción de IVA no
 * pertenecen a esa lista. Este script los arregla sin volver a llamar a la
 * IA, así que no se pierde ninguna corrección que el operador ya haya hecho
 * -- que es justo lo que sí pasaría reprocesándolos.
 *
 * Usa la misma función que la cola: si el criterio cambia, cambia en los dos
 * lados a la vez.
 *
 * Es idempotente. Los comprobantes en estado `registrado` o `existente` no se
 * tocan: `guardarCampoEn` los rechaza por su cuenta.
 *
 *   pnpm tsx scripts/migrar-percepcion-iva.ts
 */
import { config as cargarEnv } from 'dotenv'
import { getPool, cerrarPool } from '../src/server/db/pool'
import { conTransaccion } from '../src/server/db/tx'
import { mudarPercepcionIvaEn } from '../src/server/app/cola'
import { tipoFacturaODefault } from '../src/lib/tipoFactura'

cargarEnv({ path: '.env.local' })

async function main() {
  const pool = await getPool()

  // Solo los que tienen algo en los slots de varios: no hay razón para
  // recorrer la bandeja entera.
  const candidatos = await pool.request().query<{ ID: number; TIPO_FACTURA: string | null }>(`
    SELECT c.ID, c.TIPO_FACTURA
    FROM PHF_COMPROBANTE c
    WHERE c.ESTADO NOT IN ('registrado', 'existente')
      AND EXISTS (
        SELECT 1 FROM PHF_CAMPO k
        WHERE k.COMPROBANTE_ID = c.ID
          AND k.CLAVE IN ('varios1', 'varios2')
          AND LTRIM(RTRIM(ISNULL(k.VALOR_FINAL, ''))) <> ''
      )
    ORDER BY c.ID
  `)

  let mudados = 0
  for (const fila of candidatos.recordset) {
    const cuantas = await conTransaccion((tx) =>
      mudarPercepcionIvaEn(tx, fila.ID, tipoFacturaODefault(fila.TIPO_FACTURA)),
    )
    if (cuantas > 0) {
      mudados += 1
      console.log(`  comprobante ${fila.ID}: ${cuantas} percepción(es) de IVA movida(s)`)
    }
  }

  console.log(
    `\nRevisados ${candidatos.recordset.length} comprobante(s) con impuestos varios; ` +
      `${mudados} con percepción de IVA mal ubicada.`,
  )

  await cerrarPool()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
