import sql from 'mssql'
import { getPool } from '../db/pool'
import type { FilaTango } from '@/lib/conciliacion'

/**
 * Los comprobantes de compra cargados en Tango, para cruzarlos contra lo
 * que ARCA informa (2026-10-09, pedido del usuario).
 *
 * `CPA04` y `CPA01` son las dos de la documentación oficial de Compras, y
 * esto es de SOLO LECTURA: la conciliación compara y muestra, no corrige
 * nada en el ERP.
 */

/**
 * Las órdenes de pago quedan afuera. No son comprobantes fiscales --ARCA
 * no las informa-- y son 10.115 de las 27.598 filas de la tabla: incluirlas
 * llenaría la pantalla de faltantes que no faltan. Además traen fechas
 * imposibles (2202, 2062) que ensuciarían el período.
 */
const TIPOS_EXCLUIDOS = "'O/P'"

/**
 * Cuántos números entran por consulta. El driver corta a los 2.100
 * parámetros; 1.500 deja margen para el resto.
 */
const NUMEROS_POR_TANDA = 1500

export type AlcanceConciliacion = {
  /**
   * Los números de comprobante que informa el archivo de ARCA.
   *
   * Es el filtro que hace viable la pantalla. Traer las 17.496 filas de
   * `CPA04` reventaba el render con `RangeError: Maximum call stack size
   * exceeded` y la dejaba colgada para siempre --la promesa se rechazaba
   * sin manejar y el request nunca terminaba-- aunque la consulta tardara
   * 120 ms. Medido el 2026-10-13 adentro de Next: con 5.000 filas anda y
   * con 17.500 explota; el mismo volumen procesado en un script no falla,
   * así que el techo está en el render y no en la base.
   *
   * Filtrar por número es, además, EQUIVALENTE: el emparejador exige que
   * el número coincida (ver `clave` en lib/conciliacion.ts), así que una
   * fila de Tango con otro número no podría cruzar con ninguna de ARCA.
   * Sobre el archivo real baja de 17.496 filas a 273, en 66 ms.
   *
   * Se descartaron dos filtros antes que éste: por CUIT del emisor, que
   * obliga a normalizar con REPLACE y no usa índice (2,3 s), y por
   * `COD_PROVEE`, que sí es rápido pero deja 10.032 filas, todavía por
   * encima del techo.
   */
  numeros: number[]
  /**
   * El período que cubre el archivo, para traer los comprobantes de Tango
   * que ARCA no informa. Fuera de ese rango la ausencia no significa nada.
   */
  desde: Date | null
  hasta: Date | null
}

const SELECT = `
  SELECT
    LTRIM(RTRIM(c.T_COMP))                                        AS tipo,
    c.N_COMP                                                      AS nComp,
    LTRIM(RTRIM(c.COD_PROVEE))                                    AS codProvee,
    REPLACE(REPLACE(REPLACE(ISNULL(p.N_CUIT, ''), '-', ''), ' ', ''), '.', '') AS cuitProveedor,
    LTRIM(RTRIM(ISNULL(p.NOM_PROVEE, '')))                        AS razonProveedor,
    c.FECHA_EMIS                                                  AS fechaEmision,
    ISNULL(c.IMPORTE_TO, 0)                                       AS importeTotal
  FROM CPA04 c
  LEFT JOIN CPA01 p ON p.COD_PROVEE = c.COD_PROVEE
`

function aFila(x: Record<string, unknown>): FilaTango {
  return {
    tipo: String(x.tipo),
    nComp: String(x.nComp),
    codProvee: String(x.codProvee),
    cuitProveedor: String(x.cuitProveedor ?? ''),
    razonProveedor: x.razonProveedor ? String(x.razonProveedor) : null,
    fechaEmision: x.fechaEmision ? new Date(x.fechaEmision as string) : null,
    importeTotal: Number(x.importeTotal),
  }
}

/**
 * Los comprobantes de Tango que pueden participar del cruce.
 *
 * NO se acota por fecha la búsqueda de cada fila de ARCA --eso es lo que
 * pidió el usuario con "compará contra todo"--: un comprobante cargado con
 * la fecha equivocada aparece como cargado y no como faltante, que es
 * justamente lo que evita que lo carguen dos veces. Lo que se acota es el
 * VOLUMEN, por número de comprobante, que no cambia ningún resultado.
 *
 * Los últimos ocho caracteres de `N_COMP` son el número. Es la misma
 * lectura "desde atrás" que hace `partirNComp`, y por el mismo motivo:
 * `N_COMP` no tiene un formato único --conviven la letra, el guion y el
 * punto de venta de seis-- pero el número siempre ocupa esas ocho
 * posiciones. `TRY_CAST` deja afuera las pocas filas con basura en vez de
 * romper la consulta entera.
 */
export async function comprobantesParaConciliar(
  alcance: AlcanceConciliacion,
): Promise<FilaTango[]> {
  const pool = await getPool()
  const numeros = [...new Set(alcance.numeros.filter((n) => Number.isSafeInteger(n) && n >= 0))]
  const salida: FilaTango[] = []
  const vistos = new Set<string>()

  const agregar = (filas: Record<string, unknown>[]) => {
    for (const x of filas) {
      const fila = aFila(x)
      // Las dos consultas pueden traer el mismo comprobante --uno del
      // período cuyo número también está en el archivo--. La clave es la
      // misma terna que es única en la base: proveedor + número + tipo.
      const k = `${fila.codProvee}|${fila.nComp}|${fila.tipo}`
      if (vistos.has(k)) continue
      vistos.add(k)
      salida.push(fila)
    }
  }

  // Por número, en tandas para no pasarse del tope de parámetros.
  for (let i = 0; i < numeros.length; i += NUMEROS_POR_TANDA) {
    const tanda = numeros.slice(i, i + NUMEROS_POR_TANDA)
    const req = pool.request()
    const marcadores = tanda.map((n, j) => {
      req.input(`n${j}`, sql.BigInt, n)
      return `@n${j}`
    })
    const r = await req.query<Record<string, unknown>>(`
      ${SELECT}
      WHERE LTRIM(RTRIM(c.T_COMP)) NOT IN (${TIPOS_EXCLUIDOS})
        AND TRY_CAST(RIGHT(RTRIM(c.N_COMP), 8) AS BIGINT) IN (${marcadores.join(', ')})
    `)
    agregar(r.recordset)
  }

  // Y los del período, que son los candidatos a "está en Tango y ARCA no
  // lo informa".
  if (alcance.desde && alcance.hasta) {
    const r = await pool
      .request()
      .input('desde', sql.Date, alcance.desde)
      .input('hasta', sql.Date, alcance.hasta)
      .query<Record<string, unknown>>(`
        ${SELECT}
        WHERE LTRIM(RTRIM(c.T_COMP)) NOT IN (${TIPOS_EXCLUIDOS})
          AND c.FECHA_EMIS >= @desde AND c.FECHA_EMIS <= @hasta
      `)
    agregar(r.recordset)
  }

  return salida
}
