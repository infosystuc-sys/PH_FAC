import sql from 'mssql'
import { getPool } from '../db/pool'

export type CondicionCompra = {
  codigo: number
  descripcion: string
  esCredito: boolean
  cuotas: number
}

// Tango guarda la condicion de compra en dos niveles. CONDICION_COMPRA es la
// cabecera: una fila por condicion (36). CPA49 son los renglones de cuotas
// (68 filas): cada uno dice que porcentaje vence a los cuantos dias. La app
// solo necesita la cabecera -- CPA04.COND_COMPR referencia COD_CONDIC -- pero
// contar los renglones sale gratis y le dice al operador en cuantos pagos
// cae el comprobante sin tener que leer la descripcion.
const SELECT = `
  SELECT
    c.COD_CONDIC                          AS codigo,
    LTRIM(RTRIM(ISNULL(c.DESC_CONDI,''))) AS descripcion,
    c.F_CREDITO                           AS esCredito,
    ISNULL(r.cuotas, 0)                   AS cuotas
  FROM CONDICION_COMPRA c
  OUTER APPLY (
    SELECT COUNT(*) AS cuotas FROM CPA49 q WHERE q.COD_CONDIC = c.COD_CONDIC
  ) r
`

function aCondicion(row: Record<string, unknown>): CondicionCompra {
  return {
    codigo: Number(row.codigo),
    descripcion: String(row.descripcion),
    esCredito: Boolean(row.esCredito),
    cuotas: Number(row.cuotas),
  }
}

export async function listarCondicionesCompra(): Promise<CondicionCompra[]> {
  const pool = await getPool()
  const r = await pool.request().query(`${SELECT} ORDER BY c.COD_CONDIC`)
  return r.recordset.map(aCondicion)
}

/**
 * Devuelve null cuando el codigo no existe. Ojo: 640 de los 666 proveedores
 * de CPA01 tienen COND_COMPR = 0, que no es una condicion sino la ausencia
 * de una. Este metodo devuelve null para 0, igual que para cualquier codigo
 * inexistente; quien lo llame no tiene que tratar el 0 como caso especial.
 */
export async function buscarCondicionCompra(codigo: number): Promise<CondicionCompra | null> {
  if (!Number.isInteger(codigo)) return null

  const pool = await getPool()
  const r = await pool
    .request()
    .input('cod', sql.SmallInt, codigo)
    .query(`${SELECT} WHERE c.COD_CONDIC = @cod`)

  return r.recordset.length ? aCondicion(r.recordset[0]) : null
}

export type RenglonCondicionCompra = {
  nRenglon: number
  diasVencimiento: number
  porcentaje: number
}

/**
 * Los renglones de cuotas de una condicion (vista CPA49), en el orden en
 * que Tango los imprime. Verificado contra la base real: en esta
 * instalacion, `CANT_CUOTA` es siempre 1 y `DIA_MES` siempre 'D' -- ningun
 * renglon repite cuotas ni vence en un dia fijo del mes, cada cuota es su
 * propia fila con el porcentaje y los dias ya resueltos. Por eso esta
 * funcion no lee esas dos columnas: agregarlas sin un caso real que las
 * necesite seria simular una funcionalidad que esta empresa no usa.
 */
export async function renglonesCondicionCompra(codigo: number): Promise<RenglonCondicionCompra[]> {
  const pool = await getPool()
  const r = await pool
    .request()
    .input('cod', sql.SmallInt, codigo)
    .query(`SELECT N_RENGLON, A_VENCER, PORC_MONTO FROM CPA49 WHERE COD_CONDIC = @cod ORDER BY N_RENGLON`)

  return r.recordset.map((row) => ({
    nRenglon: Number(row.N_RENGLON),
    diasVencimiento: Number(row.A_VENCER),
    porcentaje: Number(row.PORC_MONTO),
  }))
}
