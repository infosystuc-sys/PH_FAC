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
 * Un renglon real de orden de compra con algo pendiente de recibir, de un
 * articulo que puede entrar por remito (lleva stock, sin serie ni partida y
 * que no es un base de escala). Se busca en runtime: los datos de la base
 * cambian.
 */
async function renglonOcConPendiente(tx: sql.Transaction) {
  const r = await tx.request().query(`
    SELECT TOP 1 h.N_ORDEN_CO, h.COD_PROVEE, r.N_RENGL_OC, LTRIM(RTRIM(r.COD_ARTICU)) AS COD_ARTICU,
           r.CAN_PENDIE, r.CAN_RECIBI, LTRIM(RTRIM(ISNULL(r.COD_DEPOSI, ''))) AS COD_DEPOSI, h.TALONARIO
    FROM CPA36 r
    JOIN CPA35 h ON h.N_ORDEN_CO = r.N_ORDEN_CO
    JOIN STA11 a ON a.COD_ARTICU = r.COD_ARTICU
    WHERE r.CAN_PENDIE >= 1 AND h.ESTADO = 3
      AND a.STOCK = 1 AND ISNULL(a.USA_SERIE, 0) = 0 AND ISNULL(a.USA_PARTID, 0) = 0
      AND LTRIM(RTRIM(ISNULL(a.USA_ESC, 'N'))) <> 'B'
    ORDER BY h.N_ORDEN_CO DESC`)
  return r.recordset[0] ?? null
}

async function remitoDePrueba(
  tx: sql.Transaction,
  oc: { N_ORDEN_CO: string; COD_PROVEE: string; N_RENGL_OC: number; COD_ARTICU: string; TALONARIO: number },
  cantidad: number,
  nro: string,
) {
  const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
  await guardarCampoEn(tx, id, 'tipoFactura', 'remito')
  await guardarCampoEn(tx, id, 'tipo', 'Remito R')
  await guardarCampoEn(tx, id, 'ptovta', '9998')
  await guardarCampoEn(tx, id, 'nro', nro)
  await guardarCampoEn(tx, id, 'fecha', '20/10/2026')
  await guardarCampoEn(tx, id, 'codprovee', String(oc.COD_PROVEE).trim())
  await guardarCampoEn(tx, id, 'leyendaAsiento', 'Prueba PHF')
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
  return id
}

describe('registrarComprobanteEn con un remito', () => {
  it('graba STA14/STA20, sube el stock del 01 y descuenta lo pendiente de recibir de la orden', async () => {
    await conRollback(async (tx) => {
      const oc = await renglonOcConPendiente(tx)
      // La base tiene ordenes emitidas con pendiente de recibir: si esto
      // fallara, el test estaria pasando sin probar nada.
      expect(oc).not.toBeNull()

      const stockAntes = await tx.request().input('a', sql.VarChar(15), oc.COD_ARTICU)
        .query(`SELECT ISNULL(SUM(CANT_STOCK), 0) AS s FROM STA19 WHERE COD_ARTICU=@a AND COD_DEPOSI='01'`)
      const pendDepoAntes = await tx.request().input('a', sql.VarChar(15), oc.COD_ARTICU)
        .input('d', sql.VarChar(2), oc.COD_DEPOSI || '01')
        .query(`SELECT ISNULL(SUM(CANT_PEND), 0) AS p FROM STA19 WHERE COD_ARTICU=@a AND COD_DEPOSI=@d`)
      const proximoAntes = await tx.request().query(`SELECT PROXIMO FROM CPA56 WHERE TIPO_COMP='R'`)

      const id = await remitoDePrueba(tx, oc, 1, '87654321')
      const registro = await registrarComprobanteEn(tx, id)

      expect(registro.tComp).toBe('REM')
      expect(registro.nComp).toBe('R0999887654321')

      const h = await tx.request().input('n', sql.VarChar(14), registro.nComp).query(`
        SELECT * FROM STA14 WHERE TCOMP_IN_S='RP' AND N_COMP=@n`)
      expect(h.recordset).toHaveLength(1)
      const cab = h.recordset[0]
      expect(cab.T_COMP).toBe('REM')
      expect(cab.ESTADO_MOV).toBe('P')
      expect(cab.MOTIVO_REM).toBe('C')
      expect(cab.COD_PRO_CL.trim()).toBe(String(oc.COD_PROVEE).trim())
      expect(cab.OBSERVACIO).toBe('Prueba PHF')
      expect(Number(cab.NCOMP_IN_S)).toBe(registro.ncompInC)

      const r = await tx.request().input('n', sql.VarChar(8), cab.NCOMP_IN_S).query(`
        SELECT * FROM STA20 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
      expect(r.recordset).toHaveLength(1)
      const ren = r.recordset[0]
      expect(ren.COD_ARTICU.trim()).toBe(oc.COD_ARTICU)
      expect(ren.COD_DEPOSI).toBe('01')
      expect(ren.TIPO_MOV).toBe('E')
      expect(Number(ren.CANTIDAD)).toBe(1)
      expect(Number(ren.CANT_PEND)).toBe(1)
      expect(Number(ren.CANT_OC)).toBe(1)
      expect(ren.N_ORDEN_CO).toBe(oc.N_ORDEN_CO)
      expect(ren.ID_STA14).toBe(cab.ID_STA14)

      // El vinculo con la orden, una fila por renglon de STA20 (2026-10-29).
      const vinculo = await tx.request().input('n', sql.VarChar(8), cab.NCOMP_IN_S).query(`
        SELECT * FROM CPA_OC_REMITO WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
      expect(vinculo.recordset).toHaveLength(1)
      const v = vinculo.recordset[0]
      expect(v.N_RENGL_S).toBe(ren.N_RENGL_S)
      expect(v.N_ORDEN_CO).toBe(oc.N_ORDEN_CO)
      expect(v.N_RENGL_OC).toBe(oc.N_RENGL_OC)
      expect(v.TALONARIO_OC).toBe(ren.TALONARIO_OC)
      expect(Number(v.CANTIDAD)).toBe(1)
      expect(Number(v.CANT_OC)).toBe(1)
      expect(Number(v.CANT_DEV)).toBe(0)

      const stockDespues = await tx.request().input('a', sql.VarChar(15), oc.COD_ARTICU)
        .query(`SELECT ISNULL(SUM(CANT_STOCK), 0) AS s FROM STA19 WHERE COD_ARTICU=@a AND COD_DEPOSI='01'`)
      expect(Number(stockDespues.recordset[0].s)).toBeCloseTo(Number(stockAntes.recordset[0].s) + 1, 4)

      const pendDepoDespues = await tx.request().input('a', sql.VarChar(15), oc.COD_ARTICU)
        .input('d', sql.VarChar(2), oc.COD_DEPOSI || '01')
        .query(`SELECT ISNULL(SUM(CANT_PEND), 0) AS p FROM STA19 WHERE COD_ARTICU=@a AND COD_DEPOSI=@d`)
      expect(Number(pendDepoDespues.recordset[0].p)).toBeCloseTo(
        Math.max(0, Number(pendDepoAntes.recordset[0].p) - 1),
        4,
      )

      const ocDespues = await tx.request()
        .input('oc', sql.VarChar(14), oc.N_ORDEN_CO).input('r', sql.Int, oc.N_RENGL_OC)
        .query(`SELECT CAN_RECIBI, CAN_PENDIE FROM CPA36 WHERE N_ORDEN_CO=@oc AND N_RENGL_OC=@r`)
      expect(Number(ocDespues.recordset[0].CAN_RECIBI)).toBeCloseTo(Number(oc.CAN_RECIBI) + 1, 4)
      expect(Number(ocDespues.recordset[0].CAN_PENDIE)).toBeCloseTo(Number(oc.CAN_PENDIE) - 1, 4)

      const proximoDespues = await tx.request().query(`SELECT PROXIMO FROM CPA56 WHERE TIPO_COMP='R'`)
      expect(Number(proximoDespues.recordset[0].PROXIMO)).toBe(registro.ncompInC + 1)
      expect(registro.ncompInC).toBeGreaterThanOrEqual(Number(proximoAntes.recordset[0].PROXIMO))

      const phf = await tx.request().input('id', sql.Int, id)
        .query(`SELECT ESTADO, TANGO_T_COMP, TANGO_N_COMP FROM PHF_COMPROBANTE WHERE ID=@id`)
      expect(phf.recordset[0].ESTADO).toBe('registrado')
      expect(phf.recordset[0].TANGO_N_COMP).toBe(registro.nComp)

      // Ya en Tango: el chequeo de duplicados lo encuentra.
      expect(await buscarRemitoEnSta14(String(oc.COD_PROVEE), registro.nComp, tx)).not.toBeNull()

      // Idempotente: registrarlo de nuevo devuelve lo mismo y no graba otro.
      const otra = await registrarComprobanteEn(tx, id)
      expect(otra).toEqual(registro)
    })
  }, 150000)

  it('no deja recibir más de lo que la orden tiene pendiente', async () => {
    await conRollback(async (tx) => {
      const oc = await renglonOcConPendiente(tx)
      if (!oc) return
      const id = await remitoDePrueba(tx, oc, Number(oc.CAN_PENDIE) + 1, '87654322')
      await expect(registrarComprobanteEn(tx, id)).rejects.toThrow(/pendiente\(s\) de recibir/)
    })
  }, 150000)

  it('no deja registrar dos veces el mismo remito del proveedor', async () => {
    await conRollback(async (tx) => {
      const oc = await renglonOcConPendiente(tx)
      if (!oc || Number(oc.CAN_PENDIE) < 2) return
      const primero = await remitoDePrueba(tx, oc, 1, '87654323')
      await registrarComprobanteEn(tx, primero)
      const segundo = await remitoDePrueba(tx, oc, 1, '87654323')
      await expect(registrarComprobanteEn(tx, segundo)).rejects.toThrow(/ya está en Tango/)
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
  const ins = await tx.request()
    .input('id', sql.Int, id)
    .input('cod', sql.NVarChar(60), art.COD_ARTICU)
    .input('oc', sql.VarChar(14), art.N_ORDEN_CO)
    .input('tal', sql.Int, art.TALONARIO)
    .input('nr', sql.Int, art.N_RENGL_OC)
    .query(`
      INSERT INTO PHF_RENGLON (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA,
                               OC_N_ORDEN_CO, OC_TALONARIO, OC_N_RENGL_OC, OC_PENDIENTE, PDF_ORDEN)
      OUTPUT INSERTED.ID
      VALUES (@id, 1, @cod, 'prueba', 2, @oc, @tal, @nr, 2, 1)`)
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

  it('con las series leídas del PDF (IMSA) pide el DNRPA y registra después de cargarlo', async () => {
    await conRollback(async (tx) => {
      const art = await articuloConSerie(tx)
      expect(art).not.toBeNull()
      const { id, renglonId } = await remitoConSerie(tx, art!, '87654334')
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

      // Leidas, pero sin el DNRPA, que no sale del papel: bloquea.
      const revision = await revisarSeriesEn(tx, id, (await obtenerDetalleEn(tx, id)).renglones)
      expect(revision).toHaveLength(1)
      expect(revision[0].origen).toBe('leidas')
      expect(revision[0].problema).toMatch(/Falta el DNRPA de 2 serie/)
      expect((await validarListoParaRegistrarEn(tx, id)).bloqueante).toBe(true)

      // El operador guarda lo leido con el DNRPA y ahi se registra.
      await guardarSeriesEn(
        tx,
        id,
        renglonId,
        revision[0].series.map((s, i) => ({ ...s, comentario: `DNRPA-${i + 1}` })),
      )
      const registro = await registrarComprobanteEn(tx, id)
      const h = await tx.request()
        .input('n', sql.VarChar(8), String(registro.ncompInC).padStart(8, '0'))
        .query(`SELECT * FROM STA07 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n ORDER BY N_SERIE`)
      expect(h.recordset.map((x) => [x.N_SERIE, x.DESC1, x.DESC2, x.COMENTARIO])).toEqual([
        ['PHF-TEST-C1', '162FMJ T0000001', 'NE', 'DNRPA-1'],
        ['PHF-TEST-C2', '162FMJ T0000002', 'NE', 'DNRPA-2'],
      ])
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
})
