import sql from 'mssql'
import { getPool } from '../db/pool'
import { tieneColumna, tieneTabla } from './esquema'
import type { CriterioOc } from '@/lib/tipoFactura'

/**
 * Las órdenes de compra de Tango: `CPA35` (encabezados) y `CPA36`
 * (renglones), las dos en la documentación oficial de Compras.
 *
 * Reemplazan al remito como fuente del detalle de una factura de artículos
 * (decisión del usuario, 2026-09-06): toda factura de artículos se imputa a
 * una OC, que siempre está cargada en Tango de antes. El remito nunca se
 * escribía en Tango --`CPA46` no tiene ninguna columna que lo referencie--
 * así que era solo de dónde salían los renglones; la OC ocupa ese lugar y
 * además deja el vínculo asentado en `CPA_OC_FACTURA`.
 *
 * Este módulo es de SOLO LECTURA. La escritura del vínculo y de los
 * contadores vive en `comprobantes.ts`, junto al resto del registro, para
 * que todo lo que toca Tango al grabar una factura esté en un solo lugar.
 */

export type RenglonOc = {
  nRenglOc: number
  codArticu: string
  descripcion: string
  /** Lo pedido en la OC. */
  cantidadPedida: number
  /** Lo que ya se facturó contra este renglón. */
  cantidadFacturada: number
  /**
   * Lo que queda pendiente según contra qué se imputa: por FACTURAR para una
   * factura, por RECIBIR para un remito (ver `CriterioOc`). Es el tope de lo
   * que puede traer el comprobante nuevo.
   */
  pendiente: number
  precio: number
}

export type OrdenCompra = {
  /** `CPA35.N_ORDEN_CO`, tal cual: viene con espacios de relleno adelante. */
  nOrdenCo: string
  talonario: number
  codProvee: string
  fechaEmision: Date | null
  estado: number
  descripcionEstado: string
  total: number
  renglones: RenglonOc[]
}

/**
 * Solo los renglones con algo pendiente de facturar. Un renglón ya
 * facturado por completo no se ofrece: no hay nada que imputarle, y
 * mostrarlo obligaría al operador a distinguir a ojo cuál puede usar.
 *
 * `PENDIENTE_FACTURAR` es el dato que manda -- lo indicó el usuario y se
 * verificó contra la base: en la OC 0000100001640, un renglón con 50
 * pedidas y 10 facturadas tiene 40 pendientes. Ojo que se mide contra lo
 * PEDIDO, no contra lo recibido: `CPA36` tiene además
 * `PENDIENTE_FACTURAR_RECIBIDA` para esa otra lectura, que esta app no usa.
 */
// Las bases mas viejas no tienen ESTADO_ORDEN_COMPRA ni el enlace desde la
// cabecera: ahi la descripcion del estado queda vacia (el numero sigue en
// `estado`).
/**
 * La columna de CPA36 que mide lo pendiente para cada criterio. Un remito
 * consume `CAN_PENDIE` (pedido menos recibido y cerrado), que Tango mantiene
 * aparte de lo pendiente de facturar.
 */
const COLUMNA_PENDIENTE: Record<CriterioOc, string> = {
  facturar: 'r.PENDIENTE_FACTURAR',
  recibir: 'r.CAN_PENDIE',
}

const selectOc = async (criterio: CriterioOc) => {
  const pendiente = COLUMNA_PENDIENTE[criterio]
  const conEstado = (await tieneTabla('ESTADO_ORDEN_COMPRA')) && (await tieneColumna('CPA35', 'ID_ESTADO_ORDEN_COMPRA'))
  return `
  SELECT
    h.N_ORDEN_CO                                        AS nOrdenCo,
    h.TALONARIO                                         AS talonario,
    LTRIM(RTRIM(h.COD_PROVEE))                          AS codProvee,
    h.FEC_EMISIO                                        AS fechaEmision,
    h.ESTADO                                            AS estado,
    ${conEstado ? "LTRIM(RTRIM(ISNULL(e.DESC_ESTADO_ORDEN_COMPRA, '')))" : "''"} AS descripcionEstado,
    ISNULL(h.TOTAL_CTE, 0)                              AS total,
    r.N_RENGL_OC                                        AS nRenglOc,
    LTRIM(RTRIM(ISNULL(r.COD_ARTICU, '')))              AS codArticu,
    LTRIM(RTRIM(ISNULL(r.DESCRIPCION_ARTICULO, '')))    AS descripcion,
    ISNULL(r.CAN_PEDIDA, 0)                             AS cantidadPedida,
    ISNULL(r.CANTIDAD_FACTURADA, 0)                     AS cantidadFacturada,
    ISNULL(${pendiente}, 0)                             AS pendiente,
    ISNULL(r.PRECIO, 0)                                 AS precio
  FROM CPA35 h
  JOIN CPA36 r ON r.N_ORDEN_CO = h.N_ORDEN_CO
  ${conEstado ? 'LEFT JOIN ESTADO_ORDEN_COMPRA e ON e.ID_ESTADO_ORDEN_COMPRA = h.ID_ESTADO_ORDEN_COMPRA' : ''}
  WHERE ISNULL(${pendiente}, 0) > 0
`
}

/**
 * Las OC del proveedor que todavía tienen algo por facturar.
 *
 * El criterio es `PENDIENTE_FACTURAR > 0` y no una lista de estados
 * --decisión del usuario, 2026-09-06--. Da lo mismo en la práctica: al
 * medirlo contra la base, las OC con pendiente estaban en los estados 3
 * (Emitida), 10 (Cumplida) y 8 (Emitida y cerrada), y ninguna anulada tenía
 * pendiente. Pero como regla es más honesta: lo que decide si se le puede
 * facturar algo a una OC es que le quede algo, no cómo esté rotulada.
 */
export async function buscarOcPendientes(
  codProvee: string,
  criterio: CriterioOc = 'facturar',
): Promise<OrdenCompra[]> {
  const cod = codProvee.trim()
  if (!cod) return []

  const pool = await getPool()
  const r = await pool
    .request()
    .input('prov', sql.VarChar(6), cod)
    .query<Record<string, unknown>>(`
      ${await selectOc(criterio)}
        AND LTRIM(RTRIM(h.COD_PROVEE)) = @prov
      ORDER BY h.FEC_EMISIO DESC, h.N_ORDEN_CO DESC, r.N_RENGL_OC
    `)

  return agrupar(r.recordset)
}

/**
 * Una OC puntual, ya elegida. Se relee de Tango en vez de confiar en lo que
 * quedó guardado al elegirla: entre que el operador la eligió y el momento
 * de registrar, otra factura pudo haber consumido parte de lo pendiente.
 */
export async function buscarOcPorNumero(
  nOrdenCo: string,
  criterio: CriterioOc = 'facturar',
): Promise<OrdenCompra | null> {
  const n = nOrdenCo.trim()
  if (!n) return null

  const pool = await getPool()
  const r = await pool
    .request()
    .input('oc', sql.VarChar(14), nOrdenCo)
    .query<Record<string, unknown>>(`
      ${await selectOc(criterio)}
        AND h.N_ORDEN_CO = @oc
      ORDER BY r.N_RENGL_OC
    `)

  const ocs = agrupar(r.recordset)
  return ocs[0] ?? null
}

function agrupar(filas: Record<string, unknown>[]): OrdenCompra[] {
  const ocs: OrdenCompra[] = []
  let actual: OrdenCompra | null = null

  // Las filas vienen ordenadas por OC, asi que alcanza con cortar cuando
  // cambia el numero -- mismo criterio que `agrupar` en remitos.ts.
  for (const f of filas) {
    const nOrdenCo = String(f.nOrdenCo)
    if (!actual || actual.nOrdenCo !== nOrdenCo) {
      actual = {
        nOrdenCo,
        talonario: Number(f.talonario),
        codProvee: String(f.codProvee),
        fechaEmision: f.fechaEmision ? new Date(f.fechaEmision as string) : null,
        estado: Number(f.estado),
        descripcionEstado: String(f.descripcionEstado),
        total: Number(f.total),
        renglones: [],
      }
      ocs.push(actual)
    }
    actual.renglones.push({
      nRenglOc: Number(f.nRenglOc),
      codArticu: String(f.codArticu),
      descripcion: String(f.descripcion),
      cantidadPedida: Number(f.cantidadPedida),
      cantidadFacturada: Number(f.cantidadFacturada),
      pendiente: Number(f.pendiente),
      precio: Number(f.precio),
    })
  }

  return ocs
}
