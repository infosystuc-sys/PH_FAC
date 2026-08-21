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

export type CuentaContable = { codCuenta: string; descCuenta: string }

/**
 * La cuenta que reemplaza a Subtotal gravado/exento cuando el comprobante
 * es de conceptos o de tarjeta. `CPA45.COD_CONCEP` es el mismo codigo que
 * ya resuelve `buscarConceptoProveedor`/`buscarConceptoTarjeta`
 * (`src/server/tango/conceptos.ts`); el join a `CONCEPTO_CP` va por
 * `ID_CPA45`, no por el codigo de texto.
 */
export async function cuentaDelConcepto(codConcepto: string): Promise<CuentaContable | null> {
  const cod = codConcepto.trim()
  if (!cod) return null

  const pool = await getPool()
  const r = await pool
    .request()
    .input('cod', sql.VarChar(20), cod)
    .query<Record<string, unknown>>(`
      SELECT c.COD_CUENTA AS codCuenta, LTRIM(RTRIM(ISNULL(c.DESC_CUENTA,''))) AS descCuenta
      FROM CPA45 cp45
      JOIN CONCEPTO_CP cc ON cc.ID_CPA45 = cp45.ID_CPA45
      JOIN CUENTA c ON c.ID_CUENTA = cc.ID_CUENTA
      WHERE LTRIM(RTRIM(cp45.COD_CONCEP)) = @cod
    `)

  if (r.recordset.length === 0) return null
  const f = r.recordset[0]
  return { codCuenta: String(f.codCuenta).trim(), descCuenta: String(f.descCuenta) }
}

/**
 * La cuenta de compras de cada articulo, para reemplazar Subtotal gravado
 * en facturas de articulos. Una query por codigo (la lista es a lo sumo
 * los articulos distintos de un comprobante, tipicamente unos pocos) en
 * vez de un IN dinamico: mas simple y sigue parametrizado.
 */
export async function cuentasDeArticulos(codigos: string[]): Promise<Map<string, CuentaContable>> {
  const mapa = new Map<string, CuentaContable>()
  if (codigos.length === 0) return mapa

  const pool = await getPool()
  for (const codigo of codigos) {
    const r = await pool
      .request()
      .input('cod', sql.VarChar(20), codigo)
      .query<Record<string, unknown>>(`
        SELECT c.COD_CUENTA AS codCuenta, LTRIM(RTRIM(ISNULL(c.DESC_CUENTA,''))) AS descCuenta
        FROM ARTICULO_CUENTA ac
        JOIN CUENTA c ON c.ID_CUENTA = ac.ID_CUENTA_COMPRAS
        WHERE LTRIM(RTRIM(ac.COD_STA11)) = @cod
      `)
    if (r.recordset.length > 0) {
      const f = r.recordset[0]
      mapa.set(codigo, { codCuenta: String(f.codCuenta).trim(), descCuenta: String(f.descCuenta) })
    }
  }
  return mapa
}
