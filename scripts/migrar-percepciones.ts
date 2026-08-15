/**
 * Migra los comprobantes cargados antes de que las percepciones pasaran a
 * cuatro slots con jurisdicción.
 *
 *   perciibb   -> imppercep1
 *   codpercibb -> percep1  (el código se traduce a su jurisdicción)
 *   impint     -> impvarios1 + varios1 = 40 (IMP INT)
 *
 * Es idempotente: si el comprobante ya tiene los campos nuevos no lo
 * toca, así que se puede correr de nuevo sin duplicar nada. Las claves
 * viejas se borran al final -- ya no están en el catálogo, así que
 * `guardarCampoEn` las rechazaría y solo ensucian PHF_CAMPO.
 *
 *   pnpm tsx scripts/migrar-percepciones.ts
 */
import { config as cargarEnv } from 'dotenv'
import sql from 'mssql'
import { getPool, cerrarPool } from '../src/server/db/pool'
import { conTransaccion } from '../src/server/db/tx'
import { JURISDICCIONES_IIBB } from '../src/lib/percepcionIibb'

cargarEnv({ path: '.env.local' })

/** El código de CPA14 para impuesto interno, que es lo que guardaba `impint`. */
const COD_IMPUESTO_INTERNO = '40'

type Fila = { COMPROBANTE_ID: number; CLAVE: string; VALOR_FINAL: string | null }

async function main() {
  const pool = await getPool()

  const viejos = await pool.request().query<Fila>(`
    SELECT COMPROBANTE_ID, CLAVE, VALOR_FINAL
    FROM PHF_CAMPO
    WHERE CLAVE IN ('perciibb', 'codpercibb', 'impint')
    ORDER BY COMPROBANTE_ID
  `)

  if (viejos.recordset.length === 0) {
    console.log('No hay campos viejos que migrar.')
    await cerrarPool()
    return
  }

  // Agrupado por comprobante: los tres campos de uno se migran juntos.
  const porComprobante = new Map<number, Map<string, string | null>>()
  for (const f of viejos.recordset) {
    if (!porComprobante.has(f.COMPROBANTE_ID)) porComprobante.set(f.COMPROBANTE_ID, new Map())
    porComprobante.get(f.COMPROBANTE_ID)!.set(f.CLAVE, f.VALOR_FINAL)
  }

  let migrados = 0
  let sinDatos = 0

  for (const [id, campos] of porComprobante) {
    const nuevos: { clave: string; valor: string }[] = []

    const impIibb = (campos.get('perciibb') ?? '').trim()
    if (impIibb) {
      nuevos.push({ clave: 'imppercep1', valor: impIibb })
      const cod = (campos.get('codpercibb') ?? '').trim()
      const jurisdiccion = JURISDICCIONES_IIBB.find((j) => j.codigo === cod)?.jurisdiccion
      // Un código que ya no está en la norma (el 68, por ejemplo) no tiene
      // jurisdicción a la que traducirse. Se deja el importe y la
      // jurisdicción vacía: la pantalla lo va a marcar como no reconocido
      // y el operador decide, que es mejor que inventarle una.
      if (jurisdiccion) nuevos.push({ clave: 'percep1', valor: jurisdiccion })
      else if (cod) console.warn(`  comprobante ${id}: el código ${cod} ya no es una jurisdicción admitida`)
    }

    const impInt = (campos.get('impint') ?? '').trim()
    if (impInt) {
      nuevos.push({ clave: 'impvarios1', valor: impInt })
      nuevos.push({ clave: 'varios1', valor: COD_IMPUESTO_INTERNO })
    }

    if (nuevos.length === 0) {
      sinDatos += 1
      continue
    }

    await conTransaccion(async (tx) => {
      for (const n of nuevos) {
        // MERGE y no INSERT: idempotencia. Si ya se corrió antes, actualiza
        // en vez de romper contra UQ_PHF_CAMPO.
        await tx
          .request()
          .input('id', sql.Int, id)
          .input('clave', sql.VarChar(40), n.clave)
          .input('valor', sql.NVarChar(500), n.valor)
          .query(`
            MERGE PHF_CAMPO WITH (HOLDLOCK) AS destino
            USING (SELECT @id AS COMPROBANTE_ID, @clave AS CLAVE) AS origen
              ON destino.COMPROBANTE_ID = origen.COMPROBANTE_ID AND destino.CLAVE = origen.CLAVE
            WHEN MATCHED THEN UPDATE SET VALOR_FINAL = @valor
            WHEN NOT MATCHED THEN
              INSERT (COMPROBANTE_ID, CLAVE, VALOR_IA, CONFIANZA, VALOR_FINAL)
              VALUES (@id, @clave, @valor, NULL, @valor);
          `)
      }
    })

    migrados += 1
    console.log(`  comprobante ${id}: ${nuevos.map((n) => n.clave).join(', ')}`)
  }

  const borrados = await pool.request().query(`
    DELETE FROM PHF_CAMPO WHERE CLAVE IN ('perciibb', 'codpercibb', 'impint')
  `)

  console.log(
    `\nMigrados ${migrados} comprobante(s), ${sinDatos} sin datos que migrar. ` +
      `Borradas ${borrados.rowsAffected[0]} filas de las claves viejas.`,
  )

  await cerrarPool()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
