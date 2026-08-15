/**
 * Completa la condición de compra de los comprobantes de conceptos que se
 * cargaron antes de que la cola la pusiera sola.
 *
 * La norma es que toda factura de conceptos va con la condición de compra
 * 2 (ver COND_COMPRA_CONCEPTOS en src/server/app/cola.ts). Desde ahora la
 * escribe `procesarUno` al terminar la extracción, pero los que ya estaban
 * en la bandeja quedaron sin ella.
 *
 * Solo toca comprobantes que cumplen las tres condiciones: son de
 * conceptos, no tienen condición de compra cargada, y no están
 * registrados. Un comprobante ya registrado es terminal -- no se lo toca
 * ni acá. Y una condición puesta a mano por el operador tampoco se pisa:
 * es una corrección deliberada, no un hueco.
 *
 *   pnpm tsx scripts/migrar-condcompra-conceptos.ts
 */
import { config as cargarEnv } from 'dotenv'
import sql from 'mssql'
import { getPool, cerrarPool } from '../src/server/db/pool'
import { conTransaccion } from '../src/server/db/tx'
import { COND_COMPRA_CONCEPTOS } from '../src/server/app/cola'

cargarEnv({ path: '.env.local' })

async function main() {
  const pool = await getPool()

  const pendientes = await pool.request().query<{ ID: number }>(`
    SELECT c.ID
    FROM PHF_COMPROBANTE c
    WHERE EXISTS (
            SELECT 1 FROM PHF_CAMPO t
            WHERE t.COMPROBANTE_ID = c.ID AND t.CLAVE = 'tipoFactura'
              AND t.VALOR_FINAL = 'conceptos')
      AND NOT EXISTS (
            SELECT 1 FROM PHF_CAMPO d
            WHERE d.COMPROBANTE_ID = c.ID AND d.CLAVE = 'condcompra'
              AND LTRIM(RTRIM(ISNULL(d.VALOR_FINAL, ''))) <> '')
      AND c.ESTADO <> 'registrado'
    ORDER BY c.ID
  `)

  if (pendientes.recordset.length === 0) {
    console.log('No hay comprobantes de conceptos sin condición de compra.')
    await cerrarPool()
    return
  }

  for (const { ID } of pendientes.recordset) {
    await conTransaccion(async (tx) => {
      // MERGE y no INSERT: puede existir la fila con VALOR_FINAL vacío o
      // NULL, que es justamente el caso que estamos completando. VALOR_IA
      // queda en NULL a propósito -- esto no lo leyó la IA, es la norma de
      // registración, igual que lo que escribe la cola.
      await tx
        .request()
        .input('id', sql.Int, ID)
        .input('valor', sql.NVarChar(500), COND_COMPRA_CONCEPTOS)
        .query(`
          MERGE PHF_CAMPO WITH (HOLDLOCK) AS destino
          USING (SELECT @id AS COMPROBANTE_ID, 'condcompra' AS CLAVE) AS origen
            ON destino.COMPROBANTE_ID = origen.COMPROBANTE_ID AND destino.CLAVE = origen.CLAVE
          WHEN MATCHED THEN UPDATE SET VALOR_FINAL = @valor
          WHEN NOT MATCHED THEN
            INSERT (COMPROBANTE_ID, CLAVE, VALOR_IA, CONFIANZA, VALOR_FINAL)
            VALUES (@id, 'condcompra', NULL, NULL, @valor);
        `)
    })
    console.log(`  comprobante ${ID}: condcompra = ${COND_COMPRA_CONCEPTOS}`)
  }

  console.log(`\nCompletados ${pendientes.recordset.length} comprobante(s).`)
  await cerrarPool()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
