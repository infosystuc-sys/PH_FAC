import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { cerrarPool } from '@/server/db/pool'
import { conRollback } from '@/server/db/tx'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { guardarCampoEn, obtenerDetalleEn } from '@/server/app/detalle'
import { registrarComprobanteEn } from '@/server/tango/comprobantes'
import { contadoresOc, nCompRemito, buscarRemitoEnSta14 } from '@/server/tango/remitosCompra'
import { guardarSeriesEn, guardarSeriesPdfEn, revisarSeriesEn } from '@/server/app/series'
import { reglaSeriesDe } from '@/lib/seriesProveedor'
import { validarListoParaRegistrarEn } from '@/server/app/validaciones'
import {
  sincronizarRenglonesRemitoEn,
  elegirFacturaRenglonEn,
  marcarRemitoSinReferenciaEn,
} from '@/server/app/remitoFactura'

afterAll(async () => {
  await cerrarPool()
})

describe('contadoresOc', () => {
  it('recibir parte de lo pedido deja el resto pendiente y lo recibido por facturar', () => {
    expect(contadoresOc({ pedida: 10, recibida: 0, cerrada: 0, facturada: 0 }, 4)).toEqual({
      recibida: 4,
      pendienteRecibir: 6,
      pendienteFacturarRecibida: 4,
      pendienteRecibirFacturada: 0,
    })
  })

  it('si ya estaba facturado de antes, lo recibido baja lo pendiente de recibir facturado', () => {
    expect(contadoresOc({ pedida: 10, recibida: 0, cerrada: 0, facturada: 6 }, 4)).toEqual({
      recibida: 4,
      pendienteRecibir: 6,
      pendienteFacturarRecibida: 0,
      pendienteRecibirFacturada: 2,
    })
  })

  it('lo cerrado no queda pendiente', () => {
    expect(contadoresOc({ pedida: 10, recibida: 5, cerrada: 3, facturada: 0 }, 2).pendienteRecibir).toBe(0)
  })
})

describe('nCompRemito', () => {
  it('arma el N_COMP con la R, como lo guarda STA14', () => {
    expect(nCompRemito('11', '25490')).toBe('R0001100025490')
  })
})

/**
 * Un renglon real de factura de compra (FP) de un articulo que puede entrar
 * por remito (lleva stock, sin serie ni partida y que no es un base de
 * escala), que ningun remito recibio todavia (sin CPA48). Con o sin orden
 * de compra (CPA_OC_FACTURA). Se le deja FALTA_REM = CANTIDAD dentro de la
 * transaccion, que se revierte: asi el test no depende de que hoy haya una
 * factura sin recibir de ese tipo.
 */
async function renglonFacturaParaRecibir(tx: sql.Transaction, conOc: boolean) {
  const r = await tx.request().input('conOc', sql.Bit, conOc).query(`
    SELECT TOP 1 LTRIM(RTRIM(d.TCOMP_IN_C)) AS TCOMP_IN_C, d.NCOMP_IN_C, d.N_RENGL_C,
           LTRIM(RTRIM(d.COD_ARTICU)) AS COD_ARTICU, d.CANTIDAD,
           LTRIM(RTRIM(c.COD_PROVEE)) AS COD_PROVEE, LTRIM(RTRIM(c.N_COMP)) AS N_COMP,
           o.N_ORDEN_CO, o.N_RENGL_OC, o.CANTIDAD AS CANT_OC_FAC
    FROM CPA46 d
    JOIN CPA04 c ON c.TCOMP_IN_C = d.TCOMP_IN_C AND c.NCOMP_IN_C = d.NCOMP_IN_C
    JOIN STA11 a ON a.COD_ARTICU = d.COD_ARTICU
    OUTER APPLY (SELECT TOP 1 f.N_ORDEN_CO, f.N_RENGL_OC, f.CANTIDAD FROM CPA_OC_FACTURA f
                 WHERE f.TCOMP_IN_C = d.TCOMP_IN_C AND f.NCOMP_IN_C = d.NCOMP_IN_C AND f.N_RENGL_C = d.N_RENGL_C) o
    WHERE d.TCOMP_IN_C = 'FP' AND d.CANTIDAD >= 2 AND d.CANTIDAD = FLOOR(d.CANTIDAD)
      AND a.STOCK = 1 AND ISNULL(a.USA_SERIE, 0) = 0 AND ISNULL(a.USA_PARTID, 0) = 0
      AND LTRIM(RTRIM(ISNULL(a.USA_ESC, 'N'))) <> 'B'
      AND (CASE WHEN o.N_ORDEN_CO IS NULL THEN 0 ELSE 1 END) = @conOc
      AND (o.N_ORDEN_CO IS NULL OR o.CANTIDAD >= d.CANTIDAD)
      AND NOT EXISTS (SELECT 1 FROM CPA48 x WHERE x.TCOMP_IN_C = d.TCOMP_IN_C
                      AND x.NCOMP_IN_C = RIGHT(SPACE(8) + CAST(CAST(d.NCOMP_IN_C AS BIGINT) AS VARCHAR(8)), 8)
                      AND x.N_RENGL_C = d.N_RENGL_C)
      AND NOT EXISTS (SELECT 1 FROM CPA_OC_REMITO_FACTURA t WHERE t.TCOMP_IN_C = d.TCOMP_IN_C
                      AND t.NCOMP_IN_C = d.NCOMP_IN_C AND t.N_RENGL_C = d.N_RENGL_C)
    ORDER BY d.NCOMP_IN_C DESC`)
  const f = r.recordset[0]
  if (!f) return null
  await tx.request()
    .input('t', sql.VarChar(2), f.TCOMP_IN_C).input('n', sql.Float, f.NCOMP_IN_C).input('r', sql.Int, f.N_RENGL_C)
    .query('UPDATE CPA46 SET FALTA_REM = CANTIDAD WHERE TCOMP_IN_C=@t AND NCOMP_IN_C=@n AND N_RENGL_C=@r')
  return f as {
    TCOMP_IN_C: string
    NCOMP_IN_C: number
    N_RENGL_C: number
    COD_ARTICU: string
    CANTIDAD: number
    COD_PROVEE: string
    N_COMP: string
    N_ORDEN_CO: string | null
    N_RENGL_OC: number | null
  }
}

/** Un remito de prueba con UN renglon en el papel, armado como lo deja la cola. */
async function remitoDePrueba(
  tx: sql.Transaction,
  p: { codProvee: string; codArticu: string },
  cantidad: number,
  nro: string,
) {
  const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
  await guardarCampoEn(tx, id, 'tipoFactura', 'remito')
  await guardarCampoEn(tx, id, 'tipo', 'Remito R')
  await guardarCampoEn(tx, id, 'ptovta', '9998')
  await guardarCampoEn(tx, id, 'nro', nro)
  await guardarCampoEn(tx, id, 'fecha', '20/10/2026')
  await guardarCampoEn(tx, id, 'codprovee', p.codProvee.trim())
  await guardarCampoEn(tx, id, 'leyendaAsiento', 'Prueba PHF')
  await tx.request()
    .input('id', sql.Int, id)
    .input('cod', sql.NVarChar(60), p.codArticu)
    .input('cant', sql.Decimal(19, 4), cantidad)
    .query(`INSERT INTO PHF_RENGLON_PDF (COMPROBANTE_ID, ORDEN, CODIGO, DESCRIPCION, CANTIDAD)
            VALUES (@id, 1, @cod, 'prueba', @cant)`)
  await sincronizarRenglonesRemitoEn(tx, id)
  const d = await obtenerDetalleEn(tx, id)
  expect(d.renglones).toHaveLength(1)
  expect(d.renglones[0].codigo).toBe(p.codArticu)
  return { id, renglonId: d.renglones[0].id }
}

/**
 * Un renglon sin factura va contra la orden que tenga su articulo pendiente
 * de recibir (2026-11-18). Para probar el caso sin ninguna referencia, se le
 * saca la que se le haya propuesto.
 */
async function sinOc(tx: sql.Transaction, renglonId: number) {
  await tx.request().input('id', sql.Int, renglonId).query(`
    UPDATE PHF_RENGLON SET OC_N_ORDEN_CO = NULL, OC_TALONARIO = NULL, OC_N_RENGL_OC = NULL, OC_PENDIENTE = NULL
    WHERE ID = @id`)
}

async function vincularA(
  tx: sql.Transaction,
  id: number,
  renglonId: number,
  f: { TCOMP_IN_C: string; NCOMP_IN_C: number; N_RENGL_C: number },
) {
  await elegirFacturaRenglonEn(tx, id, renglonId, {
    tcompInC: f.TCOMP_IN_C,
    ncompInC: Number(f.NCOMP_IN_C),
    nRenglC: f.N_RENGL_C,
  })
}

describe('registrarComprobanteEn con un remito contra una factura (2026-11-16)', () => {
  it('factura con OC: CPA48, FALTA_REM, la OC heredada y el remito facturado', async () => {
    await conRollback(async (tx) => {
      const f = await renglonFacturaParaRecibir(tx, true)
      // La base tiene miles de facturas con OC: si esto fallara, el test
      // estaria pasando sin probar nada.
      expect(f).not.toBeNull()
      const ocAntes = await tx.request()
        .input('oc', sql.VarChar(14), f!.N_ORDEN_CO).input('r', sql.Int, f!.N_RENGL_OC)
        .query('SELECT CAN_RECIBI FROM CPA36 WHERE N_ORDEN_CO=@oc AND N_RENGL_OC=@r')
      const stockAntes = await tx.request().input('a', sql.VarChar(15), f!.COD_ARTICU)
        .query(`SELECT ISNULL(SUM(CANT_STOCK), 0) AS s FROM STA19 WHERE COD_ARTICU=@a AND COD_DEPOSI='01'`)

      const { id, renglonId } = await remitoDePrueba(tx, { codProvee: f!.COD_PROVEE, codArticu: f!.COD_ARTICU }, 1, '87654321')

      // Sin factura ni orden todavia: bloquea y el registro no avanza.
      await elegirFacturaRenglonEn(tx, id, renglonId, null)
      await sinOc(tx, renglonId)
      let listo = await validarListoParaRegistrarEn(tx, id)
      expect(listo.ordenCompra.estado).toBe('error')
      expect(listo.ordenCompra.mensaje).toMatch(/sin comprobante de referencia/)
      await expect(registrarComprobanteEn(tx, id)).rejects.toThrow(/sin factura ni orden de compra de referencia/)

      await vincularA(tx, id, renglonId, f!)
      listo = await validarListoParaRegistrarEn(tx, id)
      expect(listo.ordenCompra.estado).toBe('ok')
      expect(listo.ordenCompra.mensaje).toContain(f!.N_COMP)

      const registro = await registrarComprobanteEn(tx, id)
      expect(registro.nComp).toBe('R0999887654321')
      const ncompInS = String(registro.ncompInC).padStart(8, '0')

      const cab = (await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT * FROM STA14 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)).recordset[0]
      expect(cab.ESTADO_MOV).toBe('F')
      const ren = (await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT * FROM STA20 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)).recordset[0]
      expect(Number(ren.CANTIDAD)).toBe(1)
      expect(Number(ren.CANT_PEND)).toBe(0)
      expect(Number(ren.CANT_FACTU)).toBe(1)
      expect(Number(ren.CANT_OC)).toBe(1)
      expect(ren.N_ORDEN_CO).toBe(f!.N_ORDEN_CO)
      expect(ren.N_RENGL_OC).toBe(f!.N_RENGL_OC)

      const v48 = await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT * FROM CPA48 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
      expect(v48.recordset).toHaveLength(1)
      expect(v48.recordset[0].TCOMP_IN_C).toBe('FP')
      expect(Number(v48.recordset[0].NCOMP_IN_C)).toBe(Number(f!.NCOMP_IN_C))
      expect(v48.recordset[0].N_RENGL_C).toBe(f!.N_RENGL_C)
      expect(Number(v48.recordset[0].CANTIDAD)).toBe(1)

      const d46 = await tx.request()
        .input('n', sql.Float, f!.NCOMP_IN_C).input('r', sql.Int, f!.N_RENGL_C)
        .query(`SELECT FALTA_REM FROM CPA46 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n AND N_RENGL_C=@r`)
      expect(Number(d46.recordset[0].FALTA_REM)).toBeCloseTo(Number(f!.CANTIDAD) - 1, 4)

      const ocRem = await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT * FROM CPA_OC_REMITO WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
      expect(ocRem.recordset).toHaveLength(1)
      expect(ocRem.recordset[0].N_ORDEN_CO).toBe(f!.N_ORDEN_CO)
      const triple = await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT * FROM CPA_OC_REMITO_FACTURA WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
      expect(triple.recordset).toHaveLength(1)
      expect(Number(triple.recordset[0].NCOMP_IN_C)).toBe(Number(f!.NCOMP_IN_C))
      expect(Number(triple.recordset[0].CANTIDAD)).toBe(1)

      const ocDespues = await tx.request()
        .input('oc', sql.VarChar(14), f!.N_ORDEN_CO).input('r', sql.Int, f!.N_RENGL_OC)
        .query('SELECT CAN_RECIBI FROM CPA36 WHERE N_ORDEN_CO=@oc AND N_RENGL_OC=@r')
      expect(Number(ocDespues.recordset[0].CAN_RECIBI)).toBeCloseTo(Number(ocAntes.recordset[0].CAN_RECIBI) + 1, 4)

      const stockDespues = await tx.request().input('a', sql.VarChar(15), f!.COD_ARTICU)
        .query(`SELECT ISNULL(SUM(CANT_STOCK), 0) AS s FROM STA19 WHERE COD_ARTICU=@a AND COD_DEPOSI='01'`)
      expect(Number(stockDespues.recordset[0].s)).toBeCloseTo(Number(stockAntes.recordset[0].s) + 1, 4)

      // Idempotente.
      expect(await registrarComprobanteEn(tx, id)).toEqual(registro)
    })
  }, 150000)

  it('factura sin OC: CPA48 y FALTA_REM, sin tocar ninguna orden', async () => {
    await conRollback(async (tx) => {
      const f = await renglonFacturaParaRecibir(tx, false)
      if (!f) return
      const { id, renglonId } = await remitoDePrueba(tx, { codProvee: f.COD_PROVEE, codArticu: f.COD_ARTICU }, 2, '87654324')
      await vincularA(tx, id, renglonId, f)
      const registro = await registrarComprobanteEn(tx, id)
      const ncompInS = String(registro.ncompInC).padStart(8, '0')
      const ren = (await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT * FROM STA20 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)).recordset[0]
      expect(ren.N_ORDEN_CO.trim()).toBe('')
      expect(Number(ren.CANT_PEND)).toBe(0)
      const ocRem = await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT COUNT(*) AS c FROM CPA_OC_REMITO WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
      expect(ocRem.recordset[0].c).toBe(0)
      const d46 = await tx.request()
        .input('n', sql.Float, f.NCOMP_IN_C).input('r', sql.Int, f.N_RENGL_C)
        .query(`SELECT FALTA_REM FROM CPA46 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n AND N_RENGL_C=@r`)
      expect(Number(d46.recordset[0].FALTA_REM)).toBeCloseTo(Number(f.CANTIDAD) - 2, 4)
    })
  }, 150000)

  it('sin factura de referencia, confirmado: entra a stock sin vínculos y queda pendiente', async () => {
    await conRollback(async (tx) => {
      const f = await renglonFacturaParaRecibir(tx, true)
      if (!f) return
      const { id, renglonId } = await remitoDePrueba(tx, { codProvee: f.COD_PROVEE, codArticu: f.COD_ARTICU }, 1, '87654325')
      await elegirFacturaRenglonEn(tx, id, renglonId, null)
      await sinOc(tx, renglonId)
      await marcarRemitoSinReferenciaEn(tx, id, true)
      const listo = await validarListoParaRegistrarEn(tx, id)
      expect(listo.ordenCompra.estado).toBe('advertencia')
      expect(listo.bloqueante).toBe(false)

      const registro = await registrarComprobanteEn(tx, id)
      const ncompInS = String(registro.ncompInC).padStart(8, '0')
      const cab = (await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT ESTADO_MOV FROM STA14 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)).recordset[0]
      expect(cab.ESTADO_MOV).toBe('P')
      const ren = (await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT * FROM STA20 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)).recordset[0]
      expect(Number(ren.CANT_PEND)).toBe(1)
      expect(Number(ren.CANT_FACTU)).toBe(0)
      expect(ren.N_ORDEN_CO.trim()).toBe('')
      const v = await tx.request().input('n', sql.VarChar(8), ncompInS).query(`
        SELECT (SELECT COUNT(*) FROM CPA48 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n)
             + (SELECT COUNT(*) FROM CPA_OC_REMITO WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n) AS c`)
      expect(v.recordset[0].c).toBe(0)
    })
  }, 150000)

  it('no deja recibir más de lo que la factura tiene sin recibir', async () => {
    await conRollback(async (tx) => {
      const f = await renglonFacturaParaRecibir(tx, true)
      if (!f) return
      const { id, renglonId } = await remitoDePrueba(
        tx, { codProvee: f.COD_PROVEE, codArticu: f.COD_ARTICU }, Number(f.CANTIDAD) + 1, '87654322',
      )
      await vincularA(tx, id, renglonId, f)
      const listo = await validarListoParaRegistrarEn(tx, id)
      expect(listo.ordenCompra.estado).toBe('error')
      expect(listo.ordenCompra.mensaje).toMatch(/le faltan recibir/)
      await expect(registrarComprobanteEn(tx, id)).rejects.toThrow(/le faltan recibir/)
    })
  }, 150000)

  it('sin factura, va contra la orden de compra y queda pendiente de facturar (2026-11-18)', async () => {
    await conRollback(async (tx) => {
      // Un renglon de OC real con algo pendiente de recibir, de un articulo
      // que entra por remito sin series ni partidas.
      const q = await tx.request().query(`
        SELECT TOP 1 LTRIM(RTRIM(h.COD_PROVEE)) AS COD_PROVEE, LTRIM(RTRIM(r.COD_ARTICU)) AS COD_ARTICU
        FROM CPA36 r
        JOIN CPA35 h ON h.N_ORDEN_CO = r.N_ORDEN_CO AND h.TALONARIO = r.TALONARIO
        JOIN STA11 a ON a.COD_ARTICU = r.COD_ARTICU
        WHERE r.CAN_PENDIE >= 1 AND a.STOCK = 1 AND ISNULL(a.USA_SERIE, 0) = 0 AND ISNULL(a.USA_PARTID, 0) = 0
          AND LTRIM(RTRIM(ISNULL(a.USA_ESC, 'N'))) <> 'B'
        ORDER BY h.FEC_EMISIO DESC`)
      const p = q.recordset[0]
      expect(p).toBeDefined()

      const { id, renglonId } = await remitoDePrueba(tx, { codProvee: p.COD_PROVEE, codArticu: p.COD_ARTICU }, 1, '87654329')
      // Aunque el proveedor tenga una factura sin recibir, se prueba el caso
      // sin factura: el renglon toma la orden.
      await elegirFacturaRenglonEn(tx, id, renglonId, null)
      const r = (await obtenerDetalleEn(tx, id)).renglones[0]
      expect(r.factura).toBeNull()
      expect(r.ocNOrdenCo).not.toBeNull()
      const oc = { n: r.ocNOrdenCo!, renglon: r.ocNRenglOc!, tal: r.ocTalonario! }

      const listo = await validarListoParaRegistrarEn(tx, id)
      expect(listo.ordenCompra.estado).toBe('ok')
      expect(listo.ordenCompra.mensaje).toMatch(/contra la orden de compra/)
      expect(listo.bloqueante).toBe(false)

      const antes = (await tx.request()
        .input('oc', sql.VarChar(14), oc.n).input('r', sql.Int, oc.renglon).input('t', sql.SmallInt, oc.tal)
        .query('SELECT CAN_RECIBI, CAN_PENDIE FROM CPA36 WHERE N_ORDEN_CO=@oc AND N_RENGL_OC=@r AND TALONARIO=@t')).recordset[0]

      const registro = await registrarComprobanteEn(tx, id)
      const ncompInS = String(registro.ncompInC).padStart(8, '0')

      const cab = (await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT ESTADO_MOV FROM STA14 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)).recordset[0]
      expect(cab.ESTADO_MOV).toBe('P')
      const ren = (await tx.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT * FROM STA20 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)).recordset[0]
      expect(ren.N_ORDEN_CO).toBe(oc.n)
      expect(ren.N_RENGL_OC).toBe(oc.renglon)
      expect(Number(ren.CANT_PEND)).toBe(1)
      expect(Number(ren.CANT_FACTU)).toBe(0)
      expect(Number(ren.CANT_OC)).toBe(1)
      // Como Tango en los remitos contra OC sin factura: precio en 0.
      expect(Number(ren.PRECIO_REM)).toBe(0)

      const v = await tx.request().input('n', sql.VarChar(8), ncompInS).query(`
        SELECT (SELECT COUNT(*) FROM CPA_OC_REMITO WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n) AS ocRem,
               (SELECT COUNT(*) FROM CPA48 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n) AS cpa48`)
      expect(v.recordset[0].ocRem).toBe(1)
      expect(v.recordset[0].cpa48).toBe(0)

      const despues = (await tx.request()
        .input('oc', sql.VarChar(14), oc.n).input('r', sql.Int, oc.renglon).input('t', sql.SmallInt, oc.tal)
        .query('SELECT CAN_RECIBI, CAN_PENDIE FROM CPA36 WHERE N_ORDEN_CO=@oc AND N_RENGL_OC=@r AND TALONARIO=@t')).recordset[0]
      expect(Number(despues.CAN_RECIBI)).toBeCloseTo(Number(antes.CAN_RECIBI) + 1, 4)
      expect(Number(despues.CAN_PENDIE)).toBeCloseTo(Number(antes.CAN_PENDIE) - 1, 4)
    })
  }, 150000)

  it('no deja registrar dos veces el mismo remito del proveedor', async () => {
    await conRollback(async (tx) => {
      const f = await renglonFacturaParaRecibir(tx, true)
      if (!f) return
      const primero = await remitoDePrueba(tx, { codProvee: f.COD_PROVEE, codArticu: f.COD_ARTICU }, 1, '87654323')
      await vincularA(tx, primero.id, primero.renglonId, f)
      await registrarComprobanteEn(tx, primero.id)
      const segundo = await remitoDePrueba(tx, { codProvee: f.COD_PROVEE, codArticu: f.COD_ARTICU }, 1, '87654323')
      await vincularA(tx, segundo.id, segundo.renglonId, f)
      await expect(registrarComprobanteEn(tx, segundo.id)).rejects.toThrow(/ya está en Tango/)
    })
  }, 150000)
})

type ArticuloConSerie = {
  COD_ARTICU: string
  COD_PROVEE: string
  N_ORDEN_CO: string | null
  N_RENGL_OC: number | null
  TALONARIO: number | null
  conOc: boolean
}

/**
 * Un articulo con numero de serie que puede entrar por remito y, si hay,
 * un renglon de orden de compra emitida con al menos 2 pendientes de
 * recibir. Sin orden, el renglon entra igual (como un cargo): lo que se
 * prueba aca son las series.
 */
async function articuloConSerie(tx: sql.Transaction): Promise<ArticuloConSerie | null> {
  const conOc = await tx.request().query(`
    SELECT TOP 1 h.N_ORDEN_CO, h.COD_PROVEE, r.N_RENGL_OC, LTRIM(RTRIM(r.COD_ARTICU)) AS COD_ARTICU, h.TALONARIO
    FROM CPA36 r
    JOIN CPA35 h ON h.N_ORDEN_CO = r.N_ORDEN_CO
    JOIN STA11 a ON a.COD_ARTICU = r.COD_ARTICU
    WHERE r.CAN_PENDIE >= 2 AND h.ESTADO = 3
      AND a.STOCK = 1 AND a.USA_SERIE = 1 AND ISNULL(a.USA_PARTID, 0) = 0
      AND LTRIM(RTRIM(ISNULL(a.USA_ESC, 'N'))) <> 'B'
    ORDER BY h.N_ORDEN_CO DESC`)
  if (conOc.recordset[0]) return { ...conOc.recordset[0], conOc: true }
  const sinOc = await tx.request().query(`
    SELECT TOP 1 LTRIM(RTRIM(a.COD_ARTICU)) AS COD_ARTICU, (SELECT TOP 1 COD_PROVEE FROM CPA01) AS COD_PROVEE
    FROM STA11 a
    WHERE a.STOCK = 1 AND a.USA_SERIE = 1 AND ISNULL(a.USA_PARTID, 0) = 0
      AND LTRIM(RTRIM(ISNULL(a.USA_ESC, 'N'))) <> 'B'`)
  const f = sinOc.recordset[0]
  return f ? { ...f, N_ORDEN_CO: null, N_RENGL_OC: null, TALONARIO: null, conOc: false } : null
}

async function remitoConSerie(tx: sql.Transaction, art: ArticuloConSerie, nro: string) {
  const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
  await guardarCampoEn(tx, id, 'tipoFactura', 'remito')
  await guardarCampoEn(tx, id, 'tipo', 'Remito R')
  await guardarCampoEn(tx, id, 'ptovta', '9998')
  await guardarCampoEn(tx, id, 'nro', nro)
  await guardarCampoEn(tx, id, 'fecha', '20/10/2026')
  await guardarCampoEn(tx, id, 'codprovee', String(art.COD_PROVEE).trim())
  // Lo que se prueba aca son las series: el remito va sin factura de
  // referencia, confirmado (2026-11-16; antes iba contra la OC).
  const ins = await tx.request()
    .input('id', sql.Int, id)
    .input('cod', sql.NVarChar(60), art.COD_ARTICU)
    .query(`
      UPDATE PHF_COMPROBANTE SET REMITO_SIN_REFERENCIA = 1 WHERE ID = @id;
      INSERT INTO PHF_RENGLON (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA, PDF_ORDEN, FAC_ELEGIDA)
      OUTPUT INSERTED.ID
      VALUES (@id, 1, @cod, 'prueba', 2, 1, 1)`)
  return { id, renglonId: Number(ins.recordset[0].ID) }
}

describe('registrarComprobanteEn con un remito de artículos con número de serie', () => {
  it('graba una fila por serie en STA07 y en STA06, como Tango', async () => {
    await conRollback(async (tx) => {
      const art = await articuloConSerie(tx)
      // Hay 33 articulos con serie en la base: si esto fallara, el test
      // estaria pasando sin probar nada.
      expect(art).not.toBeNull()
      const { id, renglonId } = await remitoConSerie(tx, art!, '87654331')
      await guardarSeriesEn(tx, id, renglonId, [
        { nSerie: 'phf-test-s1', desc1: 'M1111', desc2: 'C1111', comentario: 'CERT 1' },
        { nSerie: 'PHF-TEST-S2', desc1: 'M2222', desc2: 'C2222', comentario: 'CERT 2' },
      ])

      const listo = await validarListoParaRegistrarEn(tx, id)
      expect(listo.renglonesNeto.estado).toBe('ok')
      expect(listo.renglonesNeto.mensaje).toMatch(/Con 2 número\(s\) de serie/)

      const registro = await registrarComprobanteEn(tx, id)
      const ncompInS = String(registro.ncompInC).padStart(8, '0')

      const h = await tx.request().input('n', sql.VarChar(8), ncompInS).query(`
        SELECT * FROM STA07 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n ORDER BY N_SERIE`)
      expect(h.recordset).toHaveLength(2)
      expect(h.recordset[0]).toMatchObject({
        FILLER: '', COD_ARTICU: art!.COD_ARTICU, DESC1: 'M1111', DESC2: 'C1111', N_RENGL_S: 1,
        N_SERIE: 'PHF-TEST-S1', COD_DEPOSI: '01', COMENTARIO: 'CERT 1', N_PARTIDA: '',
      })
      expect(h.recordset[1]).toMatchObject({ N_SERIE: 'PHF-TEST-S2', COMENTARIO: 'CERT 2' })

      const enStock = await tx.request().input('a', sql.VarChar(15), art!.COD_ARTICU).query(`
        SELECT * FROM STA06 WHERE COD_ARTICU=@a AND N_SERIE LIKE 'PHF-TEST-S%' ORDER BY N_SERIE`)
      expect(enStock.recordset).toHaveLength(2)
      expect(enStock.recordset[0]).toMatchObject({
        FILLER: '', DESC1: 'M1111', DESC2: 'C1111', COD_DEPOSI: '01', COMENTARIO: 'CERT 1', N_PARTIDA: '',
      })

      // Una serie ya en stock no puede volver a entrar.
      const otro = await remitoConSerie(tx, art!, '87654332')
      await guardarSeriesEn(tx, otro.id, otro.renglonId, [
        { nSerie: 'PHF-TEST-S1', comentario: 'D1' },
        { nSerie: 'PHF-TEST-S3', comentario: 'D3' },
      ])
      const listoOtro = await validarListoParaRegistrarEn(tx, otro.id)
      expect(listoOtro.renglonesNeto.mensaje).toMatch(/ya tiene en stock la serie PHF-TEST-S1/)
      expect(listoOtro.bloqueante).toBe(true)
    })
  }, 150000)

  it('sin una serie por unidad no registra y "Listo para registrar" bloquea', async () => {
    await conRollback(async (tx) => {
      const art = await articuloConSerie(tx)
      if (!art) return
      const { id, renglonId } = await remitoConSerie(tx, art, '87654333')
      await guardarSeriesEn(tx, id, renglonId, [{ nSerie: 'PHF-TEST-S9' }])
      const listo = await validarListoParaRegistrarEn(tx, id)
      expect(listo.renglonesNeto.estado).toBe('error')
      expect(listo.renglonesNeto.mensaje).toMatch(/1 de 2/)
      await expect(registrarComprobanteEn(tx, id)).rejects.toThrow(/1 de 2/)
    })
  }, 150000)

  it('con las series leídas del PDF (IMSA) registra sin el DNRPA (2026-11-18)', async () => {
    await conRollback(async (tx) => {
      const art = await articuloConSerie(tx)
      expect(art).not.toBeNull()
      const { id } = await remitoConSerie(tx, art!, '87654334')
      // Lo que deja la cola despues de la lectura de series de IMSA: el
      // renglon del PDF 1 trae dos unidades, y el color sale del codigo.
      const n = await guardarSeriesPdfEn(
        tx,
        id,
        [
          { orden: 1, serie: 'phf-test-c1', adicional1: '162FMJ T0000001' },
          { orden: 1, serie: 'PHF-TEST-C2', adicional1: '162FMJ T0000002' },
          { orden: 9, serie: 'PHF-TEST-C9', adicional1: 'no hay renglon 9' },
        ],
        new Map([[1, 'MNTD-150NE-LLE2']]),
        reglaSeriesDe('010337')!,
      )
      expect(n).toBe(2)

      // Leidas y sin el DNRPA, que no sale del papel: ya no bloquea, se
      // carga despues en Tango.
      const revision = await revisarSeriesEn(tx, id, (await obtenerDetalleEn(tx, id)).renglones)
      expect(revision).toHaveLength(1)
      expect(revision[0].origen).toBe('leidas')
      expect(revision[0].problema).toBeNull()
      expect((await validarListoParaRegistrarEn(tx, id)).bloqueante).toBe(false)

      // Sin DNRPA, COMENTARIO lleva la serie, como hace Tango.
      const registro = await registrarComprobanteEn(tx, id)
      const h = await tx.request()
        .input('n', sql.VarChar(8), String(registro.ncompInC).padStart(8, '0'))
        .query(`SELECT * FROM STA07 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n ORDER BY N_SERIE`)
      expect(h.recordset.map((x) => [x.N_SERIE, x.DESC1, x.DESC2, x.COMENTARIO])).toEqual([
        ['PHF-TEST-C1', '162FMJ T0000001', 'NE', 'PHF-TEST-C1'],
        ['PHF-TEST-C2', '162FMJ T0000002', 'NE', 'PHF-TEST-C2'],
      ])

      // Ya registrado, las series en stock son las de este remito: no es un
      // problema (2026-11-18).
      const despues = await revisarSeriesEn(tx, id, (await obtenerDetalleEn(tx, id)).renglones)
      expect(despues[0].problema).toBeNull()
    })
  }, 150000)

  it('las series que guarda el operador (con el DNRPA) ganan sobre las leídas', async () => {
    await conRollback(async (tx) => {
      const art = await articuloConSerie(tx)
      if (!art) return
      const { id, renglonId } = await remitoConSerie(tx, art, '87654335')
      await guardarSeriesPdfEn(
        tx,
        id,
        [
          { orden: 1, serie: 'PHF-TEST-D1', adicional1: 'M1' },
          { orden: 1, serie: 'PHF-TEST-D2', adicional1: 'M2' },
        ],
        new Map([[1, 'MNTD-150AZ-LLE2']]),
        reglaSeriesDe('010337')!,
      )
      await guardarSeriesEn(tx, id, renglonId, [
        { nSerie: 'PHF-TEST-D1', desc1: 'M1', desc2: 'AZ', comentario: 'DNRPA-1' },
        { nSerie: 'PHF-TEST-D2', desc1: 'M2', desc2: 'AZ', comentario: 'DNRPA-2' },
      ])
      const revision = await revisarSeriesEn(tx, id, (await obtenerDetalleEn(tx, id)).renglones)
      expect(revision[0].origen).toBe('cargadas')
      expect(revision[0].series.map((s) => s.comentario)).toEqual(['DNRPA-1', 'DNRPA-2'])
    })
  }, 150000)

  it('NEWSAN: el DNRPA viene del papel y el remito se registra sin cargarlo a mano (2026-11-16)', async () => {
    await conRollback(async (tx) => {
      const art = await articuloConSerie(tx)
      if (!art) return
      const { id } = await remitoConSerie(tx, art, '87654336')
      await guardarSeriesPdfEn(
        tx,
        id,
        [
          { orden: 1, serie: 'phf-test-vin1', adicional1: '1P52FMH T0000001', comentario: 'M-0000000001/2026' },
          { orden: 1, serie: 'PHF-TEST-VIN2', adicional1: '1P52FMH T0000002', comentario: 'M-0000000002/2026' },
        ],
        new Map([[1, 'CUBQU110BASEAZUL']]),
        reglaSeriesDe('010003')!,
      )
      const revision = await revisarSeriesEn(tx, id, (await obtenerDetalleEn(tx, id)).renglones)
      expect(revision[0].origen).toBe('leidas')
      expect(revision[0].problema).toBeNull()

      const registro = await registrarComprobanteEn(tx, id)
      const h = await tx.request()
        .input('n', sql.VarChar(8), String(registro.ncompInC).padStart(8, '0'))
        .query(`SELECT * FROM STA07 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n ORDER BY N_SERIE`)
      expect(h.recordset.map((x) => [x.N_SERIE, x.DESC1, x.DESC2, x.COMENTARIO])).toEqual([
        ['PHF-TEST-VIN1', '1P52FMH T0000001', 'AZUL', 'M-0000000001/2026'],
        ['PHF-TEST-VIN2', '1P52FMH T0000002', 'AZUL', 'M-0000000002/2026'],
      ])
    })
  }, 150000)
})
