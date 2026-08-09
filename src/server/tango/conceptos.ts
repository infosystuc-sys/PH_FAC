import sql from 'mssql'
import { getPool } from '../db/pool'

export type ConceptoProveedor = { codConcepto: string; descripcion: string }

/**
 * CPA_CONCEPTOS_PROVEEDOR es 1:1 por proveedor en toda la base hoy (ningun
 * COD_PROVEE tiene mas de una fila) -- no hace falta manejar ambiguedad como
 * con las percepciones de Fase 4. ID_CPA45 enlaza al maestro de conceptos
 * (CPA45), de donde sale la descripcion para mostrarle al operador cual
 * concepto se va a grabar, no solo el codigo.
 */
export async function buscarConceptoProveedor(codProvee: string): Promise<ConceptoProveedor | null> {
  const cod = codProvee.trim()
  if (!cod) return null

  const pool = await getPool()
  const r = await pool
    .request()
    .input('cod', sql.VarChar(6), cod)
    .query(`
      SELECT cp.COD_CONCEPT AS codConcepto, LTRIM(RTRIM(ISNULL(c.DESC_CONCE,''))) AS descripcion
      FROM CPA_CONCEPTOS_PROVEEDOR cp
      LEFT JOIN CPA45 c ON c.ID_CPA45 = cp.ID_CPA45
      WHERE cp.COD_PROVEE = @cod
    `)

  if (r.recordset.length === 0) return null
  const row = r.recordset[0]
  return { codConcepto: String(row.codConcepto).trim(), descripcion: String(row.descripcion) }
}
