import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { cerrarPool } from '@/server/db/pool'
import { conRollback } from '@/server/db/tx'
import {
  insertarComprobantePrueba,
  insertarRenglonPrueba,
  insertarRenglonPdfPrueba,
} from '@/server/app/comprobantes'
import { guardarCampoEn, obtenerDetalleEn } from '@/server/app/detalle'
import { registrarComprobanteEn } from '@/server/tango/comprobantes'
import { ncompInCEnCpa48 } from '@/server/tango/remitosFactura'

afterAll(async () => {
  await cerrarPool()
})

/**
 * Un renglón real de orden de compra con pendiente de recibir y de facturar,
 * de un artículo que entra a stock sin serie ni partida, y sin remitos
 * pendientes contra la orden (la factura-remito no los consume igual, pero
 * así lo único que se mide es lo que graba ella).
 */
async function renglonOc(tx: sql.Transaction) {
  const r = await tx.request().query(`
    SELECT TOP 1 h.N_ORDEN_CO, h.TALONARIO, LTRIM(RTRIM(h.COD_PROVEE)) AS COD_PROVEE,
           g.N_RENGL_OC, LTRIM(RTRIM(g.COD_ARTICU)) AS COD_ARTICU,
           ISNULL(g.CANTIDAD_FACTURADA, 0) AS CANTIDAD_FACTURADA,
           ISNULL(g.CAN_RECIBI, 0) AS CAN_RECIBI,
           ISNULL(g.PENDIENTE_FACTURAR, 0) AS PENDIENTE_FACTURAR
    FROM CPA36 g
    JOIN CPA35 h ON h.N_ORDEN_CO = g.N_ORDEN_CO
    JOIN STA11 a ON a.COD_ARTICU = g.COD_ARTICU
    WHERE ISNULL(g.CAN_PENDIE, 0) >= 2 AND ISNULL(g.PENDIENTE_FACTURAR, 0) >= 2
      AND h.ESTADO = 3 AND ISNULL(g.PRECIO, 0) > 0
      AND a.STOCK = 1 AND ISNULL(a.USA_SERIE, 0) = 0 AND ISNULL(a.USA_PARTID, 0) = 0
      AND LTRIM(RTRIM(ISNULL(a.USA_ESC, 'N'))) <> 'B'
    ORDER BY h.FEC_EMISIO DESC`)
  return r.recordset[0] ?? null
}

type Oc = NonNullable<Awaited<ReturnType<typeof renglonOc>>>

const PTOVTA = '0087'
const NRO = '00054398'

async function facturaRemitoDePrueba(tx: sql.Transaction, oc: Oc, cantidad: number) {
  const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
  const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
  await guardarCampoEn(tx, id, 'tipo', 'FAC A')
  await guardarCampoEn(tx, id, 'ptovta', PTOVTA)
  await guardarCampoEn(tx, id, 'nro', NRO)
  await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
  await guardarCampoEn(tx, id, 'codprovee', String(oc.COD_PROVEE))
  await guardarCampoEn(tx, id, 'condcompra', String(condicion.recordset[0].COD_CONDIC))
  await guardarCampoEn(tx, id, 'tipoFactura', 'facturaRemito')
  await guardarCampoEn(tx, id, 'neto', '1.000,00')
  await guardarCampoEn(tx, id, 'total', '1.000,00')

  const renglonId = await insertarRenglonPrueba(tx, id, {
    codigo: String(oc.COD_ARTICU), descripcion: 'x', cantidad: String(cantidad),
    precioUnitario: String(1000 / cantidad), importe: '1000',
  })
  await tx.request()
    .input('id', sql.Int, renglonId)
    .input('oc', sql.VarChar(14), String(oc.N_ORDEN_CO))
    .input('tal', sql.Int, Number(oc.TALONARIO))
    .input('r', sql.Int, Number(oc.N_RENGL_OC))
    .input('p', sql.Decimal(19, 4), Number(oc.PENDIENTE_FACTURAR))
    .query(`
      UPDATE PHF_RENGLON
      SET OC_N_ORDEN_CO=@oc, OC_TALONARIO=@tal, OC_N_RENGL_OC=@r, OC_PENDIENTE=@p, PDF_ORDEN=1
      WHERE ID=@id`)
  await insertarRenglonPdfPrueba(tx, id, 1, String(oc.COD_ARTICU), String(cantidad), String(1000 / cantidad), '1000')
  return id
}

describe('registrarComprobanteEn con una factura-remito de artículos (2026-11-17)', () => {
  it('graba la factura contra la OC y el remito con el mismo número, recibiendo esa factura', async () => {
    await conRollback(async (tx) => {
      const oc = await renglonOc(tx)
      expect(oc).not.toBeNull()
      const id = await facturaRemitoDePrueba(tx, oc, 2)
      const registro = await registrarComprobanteEn(tx, id)

      // La factura, como una de artículos.
      expect(registro.tComp).toBe('FAC')
      expect(registro.nComp).toBe(`A${PTOVTA.padStart(5, '0')}${NRO}`)
      const fac = await tx.request().input('n', sql.Float, registro.ncompInC).query(`
        SELECT N_RENGL_C, CANTIDAD, FALTA_REM FROM CPA46 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)
      expect(fac.recordset).toHaveLength(1)
      // Lo que la factura tenia sin recibir lo recibio su propio remito.
      expect(Number(fac.recordset[0].FALTA_REM)).toBe(0)
      const ocf = await tx.request().input('n', sql.Float, registro.ncompInC)
        .query(`SELECT CANTIDAD FROM CPA_OC_FACTURA WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)
      expect(Number(ocf.recordset[0].CANTIDAD)).toBe(2)

      // El remito: mismo punto de venta y numero, con R.
      const nCompR = `R${PTOVTA.padStart(5, '0')}${NRO}`
      const cab = await tx.request().input('nc', sql.VarChar(14), nCompR).input('p', sql.VarChar(6), oc.COD_PROVEE)
        .query(`SELECT NCOMP_IN_S, ESTADO_MOV FROM STA14
                WHERE TCOMP_IN_S='RP' AND N_COMP=@nc AND LTRIM(RTRIM(COD_PRO_CL))=@p`)
      expect(cab.recordset).toHaveLength(1)
      expect(cab.recordset[0].ESTADO_MOV).toBe('F')
      const ncompInS = String(cab.recordset[0].NCOMP_IN_S)

      const ren = await tx.request().input('n', sql.VarChar(8), ncompInS).query(`
        SELECT LTRIM(RTRIM(COD_ARTICU)) AS art, CANTIDAD, CANT_PEND, CANT_FACTU, N_ORDEN_CO, N_RENGL_OC
        FROM STA20 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
      expect(ren.recordset).toHaveLength(1)
      expect(ren.recordset[0].art).toBe(oc.COD_ARTICU)
      expect(Number(ren.recordset[0].CANTIDAD)).toBe(2)
      expect(Number(ren.recordset[0].CANT_PEND)).toBe(0)
      expect(Number(ren.recordset[0].CANT_FACTU)).toBe(2)
      expect(ren.recordset[0].N_ORDEN_CO).toBe(oc.N_ORDEN_CO)

      // Los vinculos: factura <-> remito, y OC <-> remito <-> factura.
      const cpa48 = await tx.request()
        .input('n', sql.VarChar(8), ncompInCEnCpa48(registro.ncompInC)).input('s', sql.VarChar(8), ncompInS)
        .query(`SELECT CANTIDAD FROM CPA48 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n AND NCOMP_IN_S=@s`)
      expect(cpa48.recordset).toHaveLength(1)
      expect(Number(cpa48.recordset[0].CANTIDAD)).toBe(2)
      const ocr = await tx.request().input('s', sql.VarChar(8), ncompInS)
        .query(`SELECT CANTIDAD FROM CPA_OC_REMITO WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@s`)
      expect(ocr.recordset).toHaveLength(1)
      const orf = await tx.request().input('n', sql.Float, registro.ncompInC)
        .query(`SELECT CANTIDAD, NCOMP_IN_S FROM CPA_OC_REMITO_FACTURA WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)
      expect(orf.recordset).toHaveLength(1)
      expect(orf.recordset[0].NCOMP_IN_S).toBe(ncompInS)

      // La orden: facturado y recibido.
      const g = await tx.request().input('oc', sql.VarChar(14), oc.N_ORDEN_CO).input('r', sql.Int, oc.N_RENGL_OC)
        .query(`SELECT CANTIDAD_FACTURADA, CAN_RECIBI FROM CPA36 WHERE N_ORDEN_CO=@oc AND N_RENGL_OC=@r`)
      expect(Number(g.recordset[0].CANTIDAD_FACTURADA)).toBe(Number(oc.CANTIDAD_FACTURADA) + 2)
      expect(Number(g.recordset[0].CAN_RECIBI)).toBe(Number(oc.CAN_RECIBI) + 2)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.auditoria.some((a) => a.texto.startsWith('Registrado en Tango con la factura: remito'))).toBe(true)
    })
  })

  it('si el remito con ese número ya está en Tango, no graba nada', async () => {
    await conRollback(async (tx) => {
      const oc = await renglonOc(tx)
      expect(oc).not.toBeNull()
      // El remito gemelo, como si lo hubieran cargado desde Tango.
      await tx.request()
        .input('nc', sql.VarChar(14), `R${PTOVTA.padStart(5, '0')}${NRO}`)
        .input('p', sql.VarChar(6), oc.COD_PROVEE)
        .query(`INSERT INTO STA14 (TCOMP_IN_S, NCOMP_IN_S, T_COMP, N_COMP, COD_PRO_CL, FECHA_MOV, ESTADO_MOV)
                VALUES ('RP', 'ZZ999999', 'REM', @nc, @p, '20260601', 'P')`)
      const id = await facturaRemitoDePrueba(tx, oc, 2)
      await expect(registrarComprobanteEn(tx, id)).rejects.toThrow(/ya está en Tango/)
    })
  })
})
