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

/**
 * El concepto al que van TODAS las liquidaciones de tarjeta: 406,
 * "COMISIONES TARJETAS DE CREDITO" (decision del usuario, 2026-08-16).
 *
 * Va fijo y no sale de la ficha del proveedor como en las facturas de
 * conceptos. La razon es que el proveedor de una liquidacion es la
 * tarjeta o el banco -- VISA, Naranja, Mastercard --, y su ficha suele
 * tener otro concepto o ninguno; lo que se imputa siempre es la comision,
 * sin importar quien la cobre.
 */
export const COD_CONCEPTO_TARJETA = '406'

/**
 * Lee del maestro la descripcion del concepto fijo de tarjeta, para
 * mostrarsela al operador con el mismo formato que la del proveedor.
 *
 * No se hardcodea la descripcion junto al codigo: si en Tango la renombran,
 * la pantalla tiene que decir lo que dice Tango. Si el concepto no existe
 * devuelve null y quien llama decide -- para el registro eso es un error,
 * porque el INSERT a CPA47 iria contra un codigo inexistente.
 */
export async function buscarConceptoTarjeta(): Promise<ConceptoProveedor | null> {
  const pool = await getPool()
  const r = await pool
    .request()
    .input('cod', sql.VarChar(3), COD_CONCEPTO_TARJETA)
    .query(`
      SELECT LTRIM(RTRIM(COD_CONCEP)) AS codConcepto,
             LTRIM(RTRIM(ISNULL(DESC_CONCE,''))) AS descripcion
      FROM CPA45 WHERE LTRIM(RTRIM(COD_CONCEP)) = @cod
    `)

  if (r.recordset.length === 0) return null
  const row = r.recordset[0]
  return { codConcepto: String(row.codConcepto), descripcion: String(row.descripcion) }
}

/**
 * El concepto que le corresponde a un comprobante segun su tipo: el de la
 * ficha del proveedor en las facturas de conceptos, el fijo de comisiones
 * en las liquidaciones de tarjeta, y ninguno en las de articulos (esas se
 * imputan por renglon).
 *
 * Existe para que la pantalla de revision, la validacion y el registro
 * resuelvan el concepto por el mismo camino y no puedan discrepar.
 */
export async function conceptoDelComprobante(
  tipoFactura: string | null | undefined,
  codProvee: string | null,
): Promise<ConceptoProveedor | null> {
  if (tipoFactura === 'tarjeta') return buscarConceptoTarjeta()
  if (tipoFactura === 'conceptos') return codProvee ? buscarConceptoProveedor(codProvee) : null
  return null
}
