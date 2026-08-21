import sql from 'mssql'
import { getPool } from '../db/pool'

/**
 * Simula, de solo lectura, el asiento contable que Tango generaria al
 * registrar un comprobante -- sin escribir nada, ni en PHF_* ni en el ERP.
 * El asiento real lo genera un proceso aparte de Tango cuando contabiliza
 * (`ASIENTO_COMPROBANTE_CP`, fuera de alcance -- ver el spec original §2);
 * esto es una vista previa para el operador, calculada desde las tablas de
 * configuracion del motor de asientos.
 *
 * Excepcion documentada en CLAUDE.md (2026-08-20/21): TIPO_CONTABLE, CUENTA
 * y ASIENTO_MODELO_CP no figuran en la documentacion de Axoft para Compras
 * ni Stock, pero son tablas de configuracion real -- no espejos CTA* -- y
 * estan autorizadas de solo lectura.
 */

/** El unico modelo que pidio el usuario: "FACTURAS / NOTAS DE DEBITO". */
const ID_ASIENTO_MODELO_CP = 1

export type RenglonModelo = {
  codCuenta: string
  descCuenta: string
  leyenda: string
  dh: 'D' | 'H'
  /** Si esta cuenta se puede reemplazar por la del concepto o el articulo. */
  reemplazaCuenta: boolean
}

/**
 * El modelo de asiento 1, indexado por `TIPO_CONTABLE.COD_TIPO_CONTABLE`.
 * Ese codigo es la clave: para IVA (`1`-`4`) y percepcion IIBB (`60`,`61`,
 * `62`,`68`, entre otros) son los MISMOS codigos de CPA14 que ya resuelven
 * `resolverAlicuotas`/`resolverPercepciones`/`resolverVarios` -- no hace
 * falta ningun mapeo nuevo, se busca directo por ese codigo.
 */
export async function cargarModeloAsiento(): Promise<Map<string, RenglonModelo>> {
  const pool = await getPool()
  const r = await pool
    .request()
    .input('idModelo', sql.Int, ID_ASIENTO_MODELO_CP)
    .query<Record<string, unknown>>(`
      SELECT
        t.COD_TIPO_CONTABLE                                     AS codTipoContable,
        c.COD_CUENTA                                             AS codCuenta,
        LTRIM(RTRIM(ISNULL(c.DESC_CUENTA,'')))                   AS descCuenta,
        LTRIM(RTRIM(ISNULL(r.DESC_LEYENDA_RENGLON, t.DESC_TIPO_CONTABLE))) AS leyenda,
        r.D_H                                                    AS dh,
        r.REEMPLAZA_CUENTA                                       AS reemplazaCuenta
      FROM RENGLON_MODELO_CP r
      JOIN TIPO_CONTABLE t ON t.ID_TIPO_CONTABLE = r.ID_TIPO_CONTABLE
      JOIN CUENTA c ON c.ID_CUENTA = r.ID_CUENTA
      WHERE r.ID_ASIENTO_MODELO_CP = @idModelo
    `)

  const modelo = new Map<string, RenglonModelo>()
  for (const f of r.recordset) {
    modelo.set(String(f.codTipoContable).trim(), {
      codCuenta: String(f.codCuenta).trim(),
      descCuenta: String(f.descCuenta),
      leyenda: String(f.leyenda),
      dh: f.dh === 'H' ? 'H' : 'D',
      reemplazaCuenta: f.reemplazaCuenta === 'S',
    })
  }
  return modelo
}
