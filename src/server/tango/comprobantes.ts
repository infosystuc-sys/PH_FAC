import sql from 'mssql'
import { getPool } from '../db/pool'

export type ComprobanteCpa04 = {
  nComp: string
  codProvee: string
  total: number
  fechaEmision: Date
}

/**
 * Solo T_COMP = 'FAC': es el unico tipo que esta app procesa (facturas de
 * compra). N_COMP codifica letra+puntoVenta(5)+numero(8) -- ver la nota de
 * verificacion en el plan de la Fase 3. `nComp` viene ya armado por
 * `src/lib/validaciones.ts::nComp`, esta funcion no reconstruye nada.
 */
export async function buscarFacturaEnCpa04(
  codProvee: string,
  nComp: string,
): Promise<ComprobanteCpa04 | null> {
  const pool = await getPool()
  const r = await pool
    .request()
    .input('cp', sql.VarChar(6), codProvee)
    .input('nc', sql.VarChar(14), nComp)
    .query(`
      SELECT TOP 1 N_COMP, COD_PROVEE, IMPORTE_TO, FECHA_EMIS
      FROM CPA04
      WHERE T_COMP = 'FAC' AND COD_PROVEE = @cp AND N_COMP = @nc
    `)

  if (r.recordset.length === 0) return null
  const row = r.recordset[0]
  return {
    nComp: String(row.N_COMP).trim(),
    codProvee: String(row.COD_PROVEE).trim(),
    total: Number(row.IMPORTE_TO),
    fechaEmision: new Date(row.FECHA_EMIS),
  }
}
