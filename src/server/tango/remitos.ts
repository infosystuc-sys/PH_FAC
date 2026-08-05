import sql from 'mssql'
import { getPool } from '../db/pool'

export type RenglonRemito = {
  nRenglon: number
  codArticulo: string
  descripcion: string | null
  codDeposito: string | null
  cantidad: number
  cantidadFacturada: number
  cantidadPendiente: number
  precio: number
}

export type RemitoPendiente = {
  numeroInterno: string
  numero: string
  fecha: Date | null
  codProvee: string
  renglones: RenglonRemito[]
}

/**
 * Los remitos de proveedor son movimientos de stock, no comprobantes de
 * compra: la factura no da de alta stock, lo da de alta el remito. Viven en
 * STA14 (encabezado) y STA20 (renglones), con TCOMP_IN_S = 'RP'.
 *
 * Tres cosas verificadas contra la base que sostienen esta consulta:
 *
 * 1. `CANT_PEND` es la cantidad que Tango mantiene como pendiente de
 *    facturar. NO se puede derivar como CANTIDAD - CANT_FACTU - CANT_DEV:
 *    hay 380 renglones de RP donde esa resta da distinto. Se lee la columna.
 * 2. `ESTADO_MOV` de la cabecera y el saldo de los renglones no se
 *    contradicen: de los 3.662 remitos en 'F' no hay ni un renglon con
 *    saldo, y los 29 que tienen saldo cuelgan de remitos en 'P'. Aun asi se
 *    filtra por las dos cosas, porque hay remitos en 'P' con todos los
 *    renglones ya facturados y no son pendientes de nada.
 * 3. `PRECIO` viene en 0 en los 13.933 renglones de RP. El precio real esta
 *    en `PRECIO_REM`.
 */
const SELECT = `
  SELECT
    LTRIM(RTRIM(h.NCOMP_IN_S))            AS numeroInterno,
    LTRIM(RTRIM(ISNULL(h.N_COMP,'')))     AS numero,
    h.FECHA_MOV                           AS fecha,
    LTRIM(RTRIM(h.COD_PRO_CL))            AS codProvee,
    r.N_RENGL_S                           AS nRenglon,
    LTRIM(RTRIM(r.COD_ARTICU))            AS codArticulo,
    LTRIM(RTRIM(ISNULL(a.DESCRIPCIO,''))) AS descripcion,
    LTRIM(RTRIM(ISNULL(r.COD_DEPOSI,''))) AS codDeposito,
    r.CANTIDAD                            AS cantidad,
    r.CANT_FACTU                          AS cantidadFacturada,
    r.CANT_PEND                           AS cantidadPendiente,
    r.PRECIO_REM                          AS precio
  FROM STA14 h
  JOIN STA20 r
    ON r.TCOMP_IN_S = h.TCOMP_IN_S
   AND r.NCOMP_IN_S = h.NCOMP_IN_S
  LEFT JOIN STA11 a
    ON a.COD_ARTICU = r.COD_ARTICU
  WHERE h.TCOMP_IN_S = 'RP'
    AND h.ESTADO_MOV = 'P'
    AND r.CANT_PEND > 0
`

/**
 * Los remitos del proveedor que todavia tienen mercaderia sin facturar, con
 * sus renglones pendientes. Un remito sin ningun renglon pendiente no
 * aparece. Los renglones ya facturados de un remito que sigue pendiente
 * tampoco: el operador solo puede asociar lo que queda.
 */
export async function buscarRemitosPendientes(codProvee: string): Promise<RemitoPendiente[]> {
  const cod = codProvee.trim()
  if (!cod) return []

  const pool = await getPool()
  const r = await pool
    .request()
    .input('prov', sql.VarChar(6), cod)
    .query<Record<string, unknown>>(`
      ${SELECT}
        AND h.COD_PRO_CL = @prov
      ORDER BY h.FECHA_MOV DESC, h.NCOMP_IN_S DESC, r.N_RENGL_S
    `)

  return agrupar(r.recordset)
}

function agrupar(filas: Record<string, unknown>[]): RemitoPendiente[] {
  const remitos: RemitoPendiente[] = []
  let actual: RemitoPendiente | null = null

  // Las filas vienen ordenadas por remito, asi que alcanza con cortar cuando
  // cambia el numero interno.
  for (const f of filas) {
    const numeroInterno = String(f.numeroInterno)
    if (!actual || actual.numeroInterno !== numeroInterno) {
      actual = {
        numeroInterno,
        numero: String(f.numero),
        fecha: f.fecha ? new Date(f.fecha as string) : null,
        codProvee: String(f.codProvee),
        renglones: [],
      }
      remitos.push(actual)
    }
    actual.renglones.push({
      nRenglon: Number(f.nRenglon),
      codArticulo: String(f.codArticulo),
      descripcion: f.descripcion ? String(f.descripcion) : null,
      codDeposito: f.codDeposito ? String(f.codDeposito) : null,
      cantidad: Number(f.cantidad),
      cantidadFacturada: Number(f.cantidadFacturada),
      cantidadPendiente: Number(f.cantidadPendiente),
      precio: Number(f.precio),
    })
  }

  return remitos
}
