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
 * Trae TODOS los comprobantes, sin filtrar por fecha (decisión del
 * usuario: "compará contra todo"). Son ~17.500 filas con cinco columnas:
 * entra holgado en memoria y evita el problema de que un comprobante
 * cargado con la fecha equivocada aparezca como faltante.
 *
 * El CUIT sale de `CPA01`, que es la única forma de llegar desde el
 * emisor que informa ARCA hasta el `COD_PROVEE` de Tango. Un proveedor sin
 * CUIT cargado --4 de 681, medido-- no puede cruzarse: queda con el CUIT
 * vacío y sus comprobantes nunca emparejan, que es la respuesta correcta y
 * no un emparejamiento inventado.
 */
export async function comprobantesParaConciliar(): Promise<FilaTango[]> {
  const pool = await getPool()
  const r = await pool.request().query<Record<string, unknown>>(`
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
    WHERE LTRIM(RTRIM(c.T_COMP)) NOT IN (${TIPOS_EXCLUIDOS})
  `)

  return r.recordset.map((x) => ({
    tipo: String(x.tipo),
    nComp: String(x.nComp),
    codProvee: String(x.codProvee),
    cuitProveedor: String(x.cuitProveedor ?? ''),
    razonProveedor: x.razonProveedor ? String(x.razonProveedor) : null,
    fechaEmision: x.fechaEmision ? new Date(x.fechaEmision as string) : null,
    importeTotal: Number(x.importeTotal),
  }))
}
