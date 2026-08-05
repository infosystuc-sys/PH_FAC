import { getPool } from '../db/pool'

/**
 * `IV` alicuotas de IVA, `IB` ingresos brutos, `II` impuestos internos,
 * `OT` el resto (retenciones, percepciones varias). Es CPA14.TIPO_ALI.
 */
export type TipoAlicuota = 'IV' | 'IB' | 'II' | 'OT'

export type AlicuotaIva = {
  codigo: number
  descripcion: string
  porcentaje: number
  percepcion: boolean
}

export type CodigoImpuesto = AlicuotaIva & {
  tipo: TipoAlicuota
  jurisdiccion: string | null
}

// CPA14 es "Codigos de impuestos" en la documentacion de Tango, y es un solo
// maestro para dos cosas distintas: las alicuotas que van en los cinco slots
// de IVA de la cabecera (CPA04.COD_IVA1..5) y los codigos que van en CPA18,
// la tabla de valores de impuestos.
//
// La particion es TIPO_ALI y esta verificada contra la base: CPA18 usa 15
// codigos distintos, CPA14 tiene exactamente 15 filas con TIPO_ALI in
// (IB, II, OT), y ninguna fila de CPA18 apunta a una fila con TIPO_ALI = 'IV'.
const SELECT = `
  SELECT
    COD_IVA                          AS codigo,
    LTRIM(RTRIM(ISNULL(DESC_IVA,'')))AS descripcion,
    PORC_IVA                         AS porcentaje,
    PERCEPCION                       AS percepcion,
    LTRIM(RTRIM(ISNULL(TIPO_ALI,'')))AS tipo,
    LTRIM(RTRIM(ISNULL(JURISDIC,'')))AS jurisdiccion
  FROM CPA14
`

function aAlicuota(row: Record<string, unknown>): AlicuotaIva {
  return {
    codigo: Number(row.codigo),
    descripcion: String(row.descripcion),
    porcentaje: Number(row.porcentaje),
    percepcion: Boolean(row.percepcion),
  }
}

function aCodigo(row: Record<string, unknown>): CodigoImpuesto {
  return {
    ...aAlicuota(row),
    tipo: String(row.tipo) as TipoAlicuota,
    jurisdiccion: row.jurisdiccion ? String(row.jurisdiccion) : null,
  }
}

/**
 * Las alicuotas validas para los slots de IVA de la cabecera. Incluye las dos
 * percepciones de IVA (RG 3337 y percepcion de IVA), que Tango tambien admite
 * ahi; `percepcion` las distingue.
 */
export async function listarAlicuotasIva(): Promise<AlicuotaIva[]> {
  const pool = await getPool()
  const r = await pool.request().query(`
    ${SELECT}
    WHERE TIPO_ALI = 'IV'
    ORDER BY PERCEPCION, PORC_IVA DESC, COD_IVA
  `)
  return r.recordset.map(aAlicuota)
}

/**
 * Los codigos que pueden ir en CPA18: percepciones de ingresos brutos,
 * impuestos internos, retenciones y demas. No incluye las alicuotas de IVA.
 */
export async function listarCodigosImpuesto(): Promise<CodigoImpuesto[]> {
  const pool = await getPool()
  const r = await pool.request().query(`
    ${SELECT}
    WHERE TIPO_ALI IN ('IB', 'II', 'OT')
    ORDER BY TIPO_ALI, COD_IVA
  `)
  return r.recordset.map(aCodigo)
}
