import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { cerrarPool } from '@/server/db/pool'
import { conRollback } from '@/server/db/tx'
import {
  insertarComprobantePrueba,
  insertarRenglonPrueba,
  insertarRenglonPdfPrueba,
} from '@/server/app/comprobantes'
import { guardarCampoEn } from '@/server/app/detalle'
import { registrarComprobanteEn } from '@/server/tango/comprobantes'
import { contadoresAlFacturar, ncompInCEnCpa48 } from '@/server/tango/remitosFactura'

afterAll(async () => {
  await cerrarPool()
})

describe('contadoresAlFacturar', () => {
  it('sin nada recibido, lo facturado queda pendiente de recibir', () => {
    expect(contadoresAlFacturar({ recibida: 0, facturada: 0 }, 2)).toEqual({
      facturada: 2,
      pendienteFacturarRecibida: 0,
      pendienteRecibirFacturada: 2,
    })
  })

  it('lo que ya entró por remito no queda pendiente de recibir', () => {
    expect(contadoresAlFacturar({ recibida: 3, facturada: 0 }, 3)).toEqual({
      facturada: 3,
      pendienteFacturarRecibida: 0,
      pendienteRecibirFacturada: 0,
    })
  })

  it('recibido de más queda por facturar', () => {
    expect(contadoresAlFacturar({ recibida: 5, facturada: 1 }, 2)).toEqual({
      facturada: 3,
      pendienteFacturarRecibida: 2,
      pendienteRecibirFacturada: 0,
    })
  })
})

describe('ncompInCEnCpa48', () => {
  it('va en 8 caracteres alineado a la derecha, como lo guarda Tango', () => {
    expect(ncompInCEnCpa48(17774)).toBe('   17774')
  })
})

/**
 * Un renglón real de orden de compra que se puede recibir por remito y
 * facturar, y que no tiene ningún remito pendiente de otro: así el único
 * remito candidato es el que arma el test.
 */
async function renglonOcParaRemitoYFactura(tx: sql.Transaction) {
  const r = await tx.request().query(`
    SELECT TOP 1 h.N_ORDEN_CO, h.TALONARIO, LTRIM(RTRIM(h.COD_PROVEE)) AS COD_PROVEE,
           g.N_RENGL_OC, LTRIM(RTRIM(g.COD_ARTICU)) AS COD_ARTICU, g.PRECIO,
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
      AND NOT EXISTS (
        SELECT 1 FROM CPA_OC_REMITO o
        JOIN STA20 s ON s.TCOMP_IN_S = o.TCOMP_IN_S AND s.NCOMP_IN_S = o.NCOMP_IN_S AND s.N_RENGL_S = o.N_RENGL_S
        WHERE o.N_ORDEN_CO = g.N_ORDEN_CO AND o.N_RENGL_OC = g.N_RENGL_OC AND s.CANT_PEND > 0)
    ORDER BY h.FEC_EMISIO DESC`)
  return r.recordset[0] ?? null
}

type Oc = NonNullable<Awaited<ReturnType<typeof renglonOcParaRemitoYFactura>>>

async function registrarRemito(tx: sql.Transaction, oc: Oc, cantidad: number) {
  const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
  await guardarCampoEn(tx, id, 'tipoFactura', 'remito')
  await guardarCampoEn(tx, id, 'tipo', 'Remito R')
  await guardarCampoEn(tx, id, 'ptovta', '9998')
  await guardarCampoEn(tx, id, 'nro', '87654399')
  await guardarCampoEn(tx, id, 'fecha', '20/10/2026')
  await guardarCampoEn(tx, id, 'codprovee', String(oc.COD_PROVEE))
  await tx.request()
    .input('id', sql.Int, id)
    .input('cod', sql.NVarChar(60), oc.COD_ARTICU)
    .input('cant', sql.Decimal(19, 4), cantidad)
    .input('oc', sql.VarChar(14), oc.N_ORDEN_CO)
    .input('tal', sql.Int, oc.TALONARIO)
    .input('nr', sql.Int, oc.N_RENGL_OC)
    .query(`
      INSERT INTO PHF_RENGLON (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA,
                               OC_N_ORDEN_CO, OC_TALONARIO, OC_N_RENGL_OC, OC_PENDIENTE, PDF_ORDEN)
      VALUES (@id, 1, @cod, 'prueba', @cant, @oc, @tal, @nr, @cant, 1)`)
  return registrarComprobanteEn(tx, id)
}

async function registrarFactura(tx: sql.Transaction, oc: Oc, cantidad: number) {
  const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
  const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
  await guardarCampoEn(tx, id, 'tipo', 'FAC A')
  await guardarCampoEn(tx, id, 'ptovta', '0088')
  await guardarCampoEn(tx, id, 'nro', '00054399')
  await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
  await guardarCampoEn(tx, id, 'codprovee', String(oc.COD_PROVEE))
  await guardarCampoEn(tx, id, 'condcompra', String(condicion.recordset[0].COD_CONDIC))
  await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')
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
  return registrarComprobanteEn(tx, id)
}

describe('registrarComprobanteEn: la factura consume el remito de su orden', () => {
  it('con el remito recibido por completo: CPA48, el pendiente en 0, el remito Facturado y FALTA_REM en 0', async () => {
    await conRollback(async (tx) => {
      const oc = await renglonOcParaRemitoYFactura(tx)
      // La base tiene ordenes con pendiente de recibir y de facturar: si
      // esto fallara, el test estaria pasando sin probar nada.
      expect(oc).not.toBeNull()

      const remito = await registrarRemito(tx, oc, 1)
      const factura = await registrarFactura(tx, oc, 1)

      const cab = await tx.request().input('n', sql.Float, remito.ncompInC)
        .query(`SELECT NCOMP_IN_S, ESTADO_MOV FROM STA14 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S = RIGHT('00000000' + CAST(CAST(@n AS bigint) AS varchar(8)), 8)`)
      expect(cab.recordset).toHaveLength(1)
      const ncompInS = cab.recordset[0].NCOMP_IN_S

      const link = await tx.request()
        .input('c', sql.VarChar(8), String(factura.ncompInC).padStart(8, ' '))
        .query(`SELECT * FROM CPA48 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@c`)
      expect(link.recordset).toHaveLength(1)
      expect(link.recordset[0].TCOMP_IN_S).toBe('RP')
      expect(link.recordset[0].NCOMP_IN_S).toBe(ncompInS)
      expect(Number(link.recordset[0].N_RENGL_S)).toBe(1)
      expect(Number(link.recordset[0].N_RENGL_C)).toBe(1)
      expect(Number(link.recordset[0].CANTIDAD)).toBe(1)

      // CANT_PEND baja; CANT_FACTU no se toca (decision del usuario).
      const ren = await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT CANT_PEND, CANT_FACTU FROM STA20 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
      expect(Number(ren.recordset[0].CANT_PEND)).toBe(0)
      expect(Number(ren.recordset[0].CANT_FACTU)).toBe(0)
      const despues = await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT ESTADO_MOV FROM STA14 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
      expect(despues.recordset[0].ESTADO_MOV).toBe('F')

      const cpa46 = await tx.request().input('n', sql.Float, factura.ncompInC)
        .query(`SELECT FALTA_REM FROM CPA46 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)
      expect(Number(cpa46.recordset[0].FALTA_REM)).toBe(0)

      // Lo recibido y facturado no queda pendiente de nada.
      const cpa36 = await tx.request()
        .input('oc', sql.VarChar(14), String(oc.N_ORDEN_CO)).input('r', sql.Int, Number(oc.N_RENGL_OC))
        .query(`SELECT PENDIENTE_FACTURAR_RECIBIDA, PENDIENTE_RECIBIR_FACTURADA, CAN_RECIBI, CANTIDAD_FACTURADA
                FROM CPA36 WHERE N_ORDEN_CO=@oc AND N_RENGL_OC=@r`)
      const c = cpa36.recordset[0]
      expect(Number(c.PENDIENTE_FACTURAR_RECIBIDA)).toBe(
        Math.max(0, Number(c.CAN_RECIBI) - Number(c.CANTIDAD_FACTURADA)),
      )
      expect(Number(c.PENDIENTE_RECIBIR_FACTURADA)).toBe(
        Math.max(0, Number(c.CANTIDAD_FACTURADA) - Number(c.CAN_RECIBI)),
      )

      const aud = await tx.request()
        .input('t', sql.NVarChar(500), '%Facturó contra remito%')
        .query(`SELECT COUNT(*) AS n FROM PHF_AUDITORIA WHERE TEXTO LIKE @t`)
      expect(Number(aud.recordset[0].n)).toBeGreaterThanOrEqual(1)
    })
  }, 180000)

  it('si el remito cubre menos que la factura, el resto queda en FALTA_REM y el remito en Facturado', async () => {
    await conRollback(async (tx) => {
      const oc = await renglonOcParaRemitoYFactura(tx)
      expect(oc).not.toBeNull()

      const remito = await registrarRemito(tx, oc, 1)
      const factura = await registrarFactura(tx, oc, 2)

      const link = await tx.request()
        .input('c', sql.VarChar(8), String(factura.ncompInC).padStart(8, ' '))
        .query(`SELECT CANTIDAD FROM CPA48 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@c`)
      expect(link.recordset).toHaveLength(1)
      expect(Number(link.recordset[0].CANTIDAD)).toBe(1)

      const cpa46 = await tx.request().input('n', sql.Float, factura.ncompInC)
        .query(`SELECT CANTIDAD, FALTA_REM FROM CPA46 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)
      expect(Number(cpa46.recordset[0].CANTIDAD)).toBe(2)
      expect(Number(cpa46.recordset[0].FALTA_REM)).toBe(1)

      const cab = await tx.request().input('n', sql.Float, remito.ncompInC)
        .query(`SELECT ESTADO_MOV FROM STA14 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S = RIGHT('00000000' + CAST(CAST(@n AS bigint) AS varchar(8)), 8)`)
      expect(cab.recordset[0].ESTADO_MOV).toBe('F')
    })
  }, 180000)

  it('sin remito recibido la factura se registra como siempre, sin CPA48', async () => {
    await conRollback(async (tx) => {
      const oc = await renglonOcParaRemitoYFactura(tx)
      expect(oc).not.toBeNull()

      const factura = await registrarFactura(tx, oc, 1)

      const link = await tx.request()
        .input('c', sql.VarChar(8), String(factura.ncompInC).padStart(8, ' '))
        .query(`SELECT COUNT(*) AS n FROM CPA48 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@c`)
      expect(Number(link.recordset[0].n)).toBe(0)

      const cpa46 = await tx.request().input('n', sql.Float, factura.ncompInC)
        .query(`SELECT FALTA_REM FROM CPA46 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)
      expect(Number(cpa46.recordset[0].FALTA_REM)).toBe(1)
    })
  }, 180000)
})
