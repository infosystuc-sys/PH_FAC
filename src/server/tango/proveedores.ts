import sql from 'mssql'
import { getPool } from '../db/pool'
import { normalizarCuit } from '@/lib/formato'

export type Proveedor = {
  codProvee: string
  razonSocial: string
  cuit: string | null
  condicionIva: string | null
  condicionCompra: number | null
}

const SELECT = `
  SELECT
    LTRIM(RTRIM(COD_PROVEE))            AS codProvee,
    LTRIM(RTRIM(ISNULL(NOM_PROVEE,''))) AS razonSocial,
    LTRIM(RTRIM(ISNULL(N_CUIT,'')))     AS cuit,
    LTRIM(RTRIM(ISNULL(COND_IVA,'')))   AS condicionIva,
    COND_COMPR                          AS condicionCompra
  FROM CPA01
`

function aProveedor(row: Record<string, unknown>): Proveedor {
  return {
    codProvee: String(row.codProvee),
    razonSocial: String(row.razonSocial),
    cuit: row.cuit ? String(row.cuit) : null,
    condicionIva: row.condicionIva ? String(row.condicionIva) : null,
    condicionCompra:
      row.condicionCompra === null || row.condicionCompra === undefined
        ? null
        : Number(row.condicionCompra),
  }
}

export async function buscarProveedorPorCuit(cuit: string): Promise<Proveedor | null> {
  const norm = normalizarCuit(cuit)
  if (!norm) return null

  const pool = await getPool()
  // Hay CUIT duplicados en CPA01 (verificado: 7 casos, uno con 4 filas). El
  // ORDER BY solo garantiza que la eleccion sea determinística entre
  // corridas, no que sea la correcta -- eso requiere ofrecerle las
  // coincidencias al operador para que elija, que es trabajo de Fase 3.
  const r = await pool
    .request()
    .input('cuit', sql.VarChar(11), norm)
    .query(`
      ${SELECT}
      WHERE REPLACE(REPLACE(REPLACE(ISNULL(N_CUIT,''), '-', ''), ' ', ''), '.', '') = @cuit
      ORDER BY COD_PROVEE
    `)

  return r.recordset.length ? aProveedor(r.recordset[0]) : null
}

export async function buscarProveedoresPorRazonSocial(
  texto: string,
  limite = 20,
): Promise<Proveedor[]> {
  const t = texto.trim()
  if (t.length < 2) return []

  const pool = await getPool()
  const r = await pool
    .request()
    .input('q', sql.NVarChar(200), `%${t}%`)
    .input('lim', sql.Int, limite)
    .query(`
      ${SELECT.replace('SELECT', 'SELECT TOP (@lim)')}
      WHERE NOM_PROVEE LIKE @q
      ORDER BY NOM_PROVEE
    `)

  return r.recordset.map(aProveedor)
}
