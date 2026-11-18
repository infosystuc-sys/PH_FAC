import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { cerrarPool, getPool } from '@/server/db/pool'
import { conRollback, conTransaccion, fijarXactAbort } from '@/server/db/tx'
import {
  insertarComprobantePrueba,
  insertarRenglonPrueba,
  insertarRenglonPdfPrueba,
} from '@/server/app/comprobantes'
import { guardarCampoEn, obtenerDetalleEn } from '@/server/app/detalle'
import { guardarSeriesEn } from '@/server/app/series'
import { sincronizarRenglonesRemitoEn, elegirFacturaRenglonEn } from '@/server/app/remitoFactura'
import { registrarComprobanteEn } from '@/server/tango/comprobantes'
import { TIPO_MOVIMIENTO_AUDITORIA } from '@/server/tango/preciosCompra'
import { TERMINAL_APP } from '@/server/tango/estadoCircuito'
import { descripcionesSerie } from '@/server/tango/series'
import { usuarioActual } from '@/lib/usuario'

afterAll(async () => {
  await cerrarPool()
})

/**
 * El circuito orden de compra -> factura vinculada a la OC -> remito
 * vinculado a esa factura, comparado contra lo que grabo Tango Compras 26.1
 * el 17/11/2026 en la base de desarrollo (factura A0000100001704 y remito
 * R0000100001704, D:\TGA_MOV\envio_app). Los puntos F y R son los del pedido
 * de correccion de ese dia.
 *
 * Todo corre dentro de `conRollback`: escribe en las tablas de Tango y se
 * revierte entero. La OC es una real de la base, descubierta en runtime: una
 * emitida (estado 3), de un solo renglon, sin nada facturado ni recibido,
 * de un articulo que entra a stock. Dentro de la transaccion se le cambia el
 * deposito al 02 (para ver que el remito usa el de la OC y no el 01) y se
 * marca el articulo con numero de serie (para ver las series del remito).
 */
async function ocSinTocar(tx: sql.Transaction) {
  const r = await tx.request().query(`
    SELECT TOP 1 h.N_ORDEN_CO, h.TALONARIO, LTRIM(RTRIM(h.COD_PROVEE)) AS COD_PROVEE,
           h.ESTADO AS ESTADO_OC, r.N_RENGL_OC, LTRIM(RTRIM(r.COD_ARTICU)) AS COD_ARTICU,
           r.CAN_PEDIDA, r.PRECIO, CAST(r.CIERRE AS int) AS CIERRE, r.REC_MAS_OC
    FROM CPA35 h
    JOIN CPA36 r ON r.N_ORDEN_CO = h.N_ORDEN_CO AND r.TALONARIO = h.TALONARIO
    JOIN STA11 a ON a.COD_ARTICU = r.COD_ARTICU
    WHERE h.ESTADO = 3 AND ISNULL(r.CAN_RECIBI, 0) = 0 AND ISNULL(r.CANTIDAD_FACTURADA, 0) = 0
      AND r.PENDIENTE_FACTURAR = r.CAN_PEDIDA AND r.CAN_PENDIE = r.CAN_PEDIDA
      AND r.CAN_PEDIDA BETWEEN 2 AND 20 AND r.CAN_PEDIDA = FLOOR(r.CAN_PEDIDA)
      AND ISNULL(r.PRECIO, 0) > 0 AND ISNULL(r.CIERRE, 0) = 0
      AND a.STOCK = 1 AND ISNULL(a.USA_PARTID, 0) = 0 AND LTRIM(RTRIM(ISNULL(a.USA_ESC, 'N'))) <> 'B'
      AND (SELECT COUNT(*) FROM CPA36 x WHERE x.N_ORDEN_CO = h.N_ORDEN_CO AND x.TALONARIO = h.TALONARIO) = 1
      AND EXISTS (SELECT 1 FROM CPA01 p WHERE p.COD_PROVEE = h.COD_PROVEE)
    ORDER BY r.CAN_PEDIDA, h.N_ORDEN_CO DESC`)
  const f = r.recordset[0]
  if (!f) return null
  return {
    nOrdenCo: String(f.N_ORDEN_CO),
    talonario: Number(f.TALONARIO),
    codProvee: String(f.COD_PROVEE),
    nRenglOc: Number(f.N_RENGL_OC),
    codArticu: String(f.COD_ARTICU),
    cantidad: Number(f.CAN_PEDIDA),
    precioOc: Number(f.PRECIO),
  }
}
type Oc = NonNullable<Awaited<ReturnType<typeof ocSinTocar>>>

const PTOVTA = '9997'
const NRO = '00077101'
/** Distinto del de la OC a proposito: el remito tiene que llevar el de la factura (R5). */
const PRECIO_FACTURA = 1000.5
const DEPOSITO_OC = '02'

function redondear(n: number): number {
  return Math.round(n * 100) / 100
}

async function facturaContraOc(tx: sql.Transaction, oc: Oc, opciones: { talonarioRenglon?: number; nro?: string } = {}) {
  const neto = redondear(oc.cantidad * PRECIO_FACTURA)
  const iva = redondear(neto * 0.21)
  const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
  const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
  await guardarCampoEn(tx, id, 'tipo', 'FAC A')
  await guardarCampoEn(tx, id, 'ptovta', PTOVTA)
  await guardarCampoEn(tx, id, 'nro', opciones.nro ?? NRO)
  await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
  // La fecha contable corregida a mano al mes siguiente: asi difiere de la
  // de emision y se ve cual va a STA12 (F10).
  await guardarCampoEn(tx, id, 'fechacontable', '01/07/2026')
  await guardarCampoEn(tx, id, 'codprovee', oc.codProvee)
  await guardarCampoEn(tx, id, 'condcompra', String(condicion.recordset[0].COD_CONDIC))
  await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')
  await guardarCampoEn(tx, id, 'neto', String(neto).replace('.', ','))
  await guardarCampoEn(tx, id, 'porciva1', '21')
  await guardarCampoEn(tx, id, 'impiva1', String(iva).replace('.', ','))
  await guardarCampoEn(tx, id, 'total', String(redondear(neto + iva)).replace('.', ','))

  const renglonId = await insertarRenglonPrueba(tx, id, {
    codigo: oc.codArticu, descripcion: 'x', cantidad: String(oc.cantidad),
    precioUnitario: String(PRECIO_FACTURA), importe: String(neto),
  })
  await tx.request()
    .input('id', sql.Int, renglonId)
    .input('oc', sql.VarChar(14), oc.nOrdenCo)
    .input('tal', sql.Int, opciones.talonarioRenglon ?? oc.talonario)
    .input('r', sql.Int, oc.nRenglOc)
    .input('p', sql.Decimal(19, 4), oc.cantidad)
    .query(`
      UPDATE PHF_RENGLON
      SET OC_N_ORDEN_CO=@oc, OC_TALONARIO=@tal, OC_N_RENGL_OC=@r, OC_PENDIENTE=@p, PDF_ORDEN=1
      WHERE ID=@id`)
  await insertarRenglonPdfPrueba(tx, id, 1, oc.codArticu, String(oc.cantidad), String(PRECIO_FACTURA), String(neto))
  return { id, total: redondear(neto + iva) }
}

async function remitoContraFactura(
  tx: sql.Transaction,
  oc: Oc,
  factura: { ncompInC: number },
  cantidad: number,
  nro: string,
  series: { nSerie: string; desc1?: string; desc2?: string; comentario: string }[],
) {
  const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
  await guardarCampoEn(tx, id, 'tipoFactura', 'remito')
  await guardarCampoEn(tx, id, 'tipo', 'Remito R')
  await guardarCampoEn(tx, id, 'ptovta', PTOVTA)
  await guardarCampoEn(tx, id, 'nro', nro)
  await guardarCampoEn(tx, id, 'fecha', '17/11/2026')
  await guardarCampoEn(tx, id, 'codprovee', oc.codProvee)
  await tx.request()
    .input('id', sql.Int, id)
    .input('cod', sql.NVarChar(60), oc.codArticu)
    .input('cant', sql.Decimal(19, 4), cantidad)
    .query(`INSERT INTO PHF_RENGLON_PDF (COMPROBANTE_ID, ORDEN, CODIGO, DESCRIPCION, CANTIDAD)
            VALUES (@id, 1, @cod, 'prueba', @cant)`)
  await sincronizarRenglonesRemitoEn(tx, id)
  const d = await obtenerDetalleEn(tx, id)
  expect(d.renglones).toHaveLength(1)
  const renglonId = d.renglones[0].id
  await elegirFacturaRenglonEn(tx, id, renglonId, { tcompInC: 'FP', ncompInC: factura.ncompInC, nRenglC: 1 })
  await guardarSeriesEn(tx, id, renglonId, series)
  return id
}

async function xactAbortOn(tx: sql.Transaction): Promise<boolean> {
  const r = await tx.request().query<{ x: number }>('SELECT @@OPTIONS & 16384 AS x')
  return r.recordset[0].x === 16384
}

describe('circuito OC -> factura -> remito, como Tango (2026-11-17)', () => {
  it('factura toda la OC, la recibe en dos remitos y deja cada tabla como Tango', async () => {
    await conRollback(async (tx) => {
      const oc = await ocSinTocar(tx)
      // La base tiene OC emitidas sin tocar: si esto fallara, el test estaria
      // pasando sin probar nada.
      expect(oc).not.toBeNull()
      const o = oc!

      await tx.request()
        .input('oc', sql.VarChar(14), o.nOrdenCo).input('tal', sql.SmallInt, o.talonario)
        .input('dep', sql.VarChar(2), DEPOSITO_OC).input('art', sql.VarChar(15), o.codArticu)
        .query(`
          UPDATE CPA36 SET COD_DEPOSI = @dep WHERE N_ORDEN_CO = @oc AND TALONARIO = @tal;
          UPDATE STA11 SET USA_SERIE = 1 WHERE COD_ARTICU = @art;`)

      const antes = await tx.request()
        .input('prov', sql.VarChar(6), o.codProvee).input('art', sql.VarChar(15), o.codArticu)
        .input('dep', sql.VarChar(2), DEPOSITO_OC)
        .query(`
          SELECT SALDO_CC, SALDO_CC_UNIDADES FROM CPA01 WHERE COD_PROVEE = @prov;
          SELECT PRECIO_U_L, PRECIO_U_E, PRECIO_REP, ID_CPA01, MON_CTE, MON_CTE_UC FROM STA12 WHERE COD_ARTICU = @art;
          SELECT ISNULL(SUM(CANT_STOCK), 0) AS stock FROM STA19 WHERE COD_ARTICU = @art AND COD_DEPOSI = @dep;`)
      const [saldoAntes] = (antes.recordsets as unknown as Record<string, unknown>[][])[0]
      const sta12Antes = (antes.recordsets as unknown as Record<string, unknown>[][])[1][0] ?? null
      const stockAntes = Number((antes.recordsets as unknown as Record<string, unknown>[][])[2][0].stock)

      // ---------- La factura ----------
      const fac = await facturaContraOc(tx, o)
      const registro = await registrarComprobanteEn(tx, fac.id)
      const n = registro.ncompInC

      // F6: la transaccion del registro queda con XACT_ABORT ON.
      expect(await xactAbortOn(tx)).toBe(true)

      // F5: el semaforo de numeracion de Tango queda tomado hasta el commit.
      // Otra conexion que lo pida con UPDLOCK no lo consigue.
      const pool = await getPool()
      await expect(
        pool.request().query(`
          SET LOCK_TIMEOUT 0;
          SELECT ID_PROXIMO_NUMERO FROM PROXIMO_NUMERO WITH (UPDLOCK) WHERE TABLA = 'CPA10' AND CAMPO = 'PROX_N_INT';`),
      ).rejects.toThrow(/Lock request time out/i)
      // Y el numero sigue la serie de Tango (FS, FP, DP, CP).
      const mx = await tx.request().input('n', sql.Float, n).query(`
        SELECT MAX(NCOMP_IN_C) AS mx FROM CPA04 WHERE TCOMP_IN_C IN ('FS','FP','DP','CP') AND NCOMP_IN_C <> @n`)
      expect(n).toBe(Number(mx.recordset[0].mx) + 1)

      const c04 = (await tx.request().input('n', sql.Float, n).query(`
        SELECT ESTADO_STK, UNIDADES, IMPORTE_TO,
               CONVERT(varchar(23), FECHA_INGRESO, 121) AS FECHA_INGRESO,
               CONVERT(varchar(23), FECHA_VTO, 121) AS FECHA_VTO,
               CONVERT(varchar(23), FECHA_ULTIMA_MODIFICACION, 121) AS FECHA_ULT_MOD,
               CONVERT(varchar(23), CAICAE_VTO, 121) AS CAICAE_VTO,
               CONVERT(varchar(23), FECHA_ANULACION_OP, 121) AS FECHA_ANULACION_OP,
               CONVERT(varchar(10), FECHA_EMIS, 121) AS FECHA_EMIS,
               CONVERT(varchar(10), FECHA_CONT, 121) AS FECHA_CONT
        FROM CPA04 WHERE TCOMP_IN_C = 'FP' AND NCOMP_IN_C = @n`)).recordset[0]
      // F3: sin remito, pendiente de remitir.
      expect(c04.ESTADO_STK).toBe('P')
      // F14: la fecha vacia de Tango, exacta, sin hora.
      expect(c04.FECHA_VTO).toBe('1800-01-01 00:00:00.000')
      expect(c04.FECHA_ULT_MOD).toBe('1800-01-01 00:00:00.000')
      expect(c04.CAICAE_VTO).toBe('1800-01-01 00:00:00.000')
      expect(c04.FECHA_ANULACION_OP).toBe('1800-01-01 00:00:00.000')
      // F15: FECHA_INGRESO sin hora.
      const hoy = new Date()
      const hoyTexto = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`
      expect(c04.FECHA_INGRESO).toBe(`${hoyTexto} 00:00:00.000`)
      expect(c04.FECHA_EMIS).toBe('2026-06-01')
      expect(c04.FECHA_CONT).toBe('2026-07-01')
      expect(Number(c04.UNIDADES)).toBe(fac.total)
      expect(Number(c04.IMPORTE_TO)).toBe(fac.total)

      // F1: el saldo del proveedor baja en el total; las unidades, en
      // CPA04.UNIDADES.
      const saldo = (await tx.request().input('prov', sql.VarChar(6), o.codProvee)
        .query('SELECT SALDO_CC, SALDO_CC_UNIDADES FROM CPA01 WHERE COD_PROVEE = @prov')).recordset[0]
      expect(Number(saldo.SALDO_CC)).toBeCloseTo(Number(saldoAntes.SALDO_CC) - fac.total, 7)
      expect(Number(saldo.SALDO_CC_UNIDADES)).toBeCloseTo(Number(saldoAntes.SALDO_CC_UNIDADES) - fac.total, 7)

      // F11: la unidad de stock del articulo; FALTA_REM = cantidad.
      const c46 = (await tx.request().input('n', sql.Float, n).query(`
        SELECT d.FALTA_REM, d.ID_MEDIDA_STOCK, d.ID_MEDIDA_COMPRA, d.ID_MEDIDA_STOCK_2, d.COD_DEPOSI,
               a.ID_MEDIDA_STOCK AS MEDIDA_STA11
        FROM CPA46 d JOIN STA11 a ON a.COD_ARTICU = d.COD_ARTICU
        WHERE d.TCOMP_IN_C = 'FP' AND d.NCOMP_IN_C = @n`)).recordset[0]
      expect(Number(c46.FALTA_REM)).toBe(o.cantidad)
      expect(c46.ID_MEDIDA_STOCK).not.toBeNull()
      expect(c46.ID_MEDIDA_STOCK).toBe(c46.MEDIDA_STA11)
      expect(c46.ID_MEDIDA_COMPRA).toBeNull()
      expect(c46.ID_MEDIDA_STOCK_2).toBeNull()

      // F2: la OC toda facturada y nada recibido sigue Emitida (3), en la
      // cabecera y en el renglon; cambia solo la auditoria de modificacion.
      const cabOc = async () => (await tx.request()
        .input('oc', sql.VarChar(14), o.nOrdenCo).input('tal', sql.SmallInt, o.talonario)
        .query(`
          SELECT ESTADO, ID_ESTADO_ORDEN_COMPRA,
                 CONVERT(varchar(23), FECHA_ULTIMA_MODIFICACION, 121) AS FECHA,
                 CONVERT(varchar(23), CAST(CAST(GETDATE() AS date) AS datetime), 121) AS HOY_SERVIDOR,
                 HORA_ULTIMA_MODIFICACION AS HORA, USUA_ULTIMA_MODIFICACION AS USUA, TERM_ULTIMA_MODIFICACION AS TERM
          FROM CPA35 WHERE N_ORDEN_CO = @oc AND TALONARIO = @tal`)).recordset[0]
      let h35 = await cabOc()
      expect(h35.ESTADO).toBe(3)
      expect(h35.ID_ESTADO_ORDEN_COMPRA).toBe(3)
      expect(h35.FECHA).toBe(h35.HOY_SERVIDOR)
      expect(h35.HORA).toMatch(/^\d{6}$/)
      expect(h35.USUA).toBe(usuarioActual().slice(0, 120))
      expect(h35.TERM).toBe(TERMINAL_APP)
      const renOc = async () => (await tx.request()
        .input('oc', sql.VarChar(14), o.nOrdenCo).input('tal', sql.SmallInt, o.talonario)
        .query(`
          SELECT ESTADO, CAN_RECIBI, CAN_PENDIE, PENDIENTE_FACTURAR, PENDIENTE_RECIBIR_FACTURADA,
                 CAST(CIERRE AS int) AS CIERRE, REC_MAS_OC
          FROM CPA36 WHERE N_ORDEN_CO = @oc AND TALONARIO = @tal`)).recordset[0]
      let r36 = await renOc()
      expect(r36.ESTADO).toBe(3)
      expect(Number(r36.PENDIENTE_FACTURAR)).toBe(0)
      expect(Number(r36.PENDIENTE_RECIBIR_FACTURADA)).toBe(o.cantidad)

      // F10: STA12 con la fecha de EMISION (no la contable), sin pisar
      // ID_CPA01 ni MON_CTE/MON_CTE_UC de una fila que ya existia.
      const s12 = (await tx.request().input('art', sql.VarChar(15), o.codArticu).query(`
        SELECT PRECIO_U_L, PRECIO_U_E, PRECIO_REP, COD_PROV_U, ID_CPA01, MON_CTE, MON_CTE_UC,
               CONVERT(varchar(23), FECHA_ULC, 121) AS FECHA_ULC, CONVERT(varchar(23), FECHA_REPOS, 121) AS FECHA_REPOS
        FROM STA12 WHERE COD_ARTICU = @art`)).recordset[0]
      expect(Number(s12.PRECIO_U_L)).toBe(PRECIO_FACTURA)
      expect(Number(s12.PRECIO_REP)).toBe(PRECIO_FACTURA)
      expect(String(s12.COD_PROV_U).trim()).toBe(o.codProvee)
      expect(s12.FECHA_ULC).toBe('2026-06-01 00:00:00.000')
      expect(s12.FECHA_REPOS).toBe('2026-06-01 00:00:00.000')
      if (sta12Antes) {
        expect(s12.ID_CPA01).toBe(sta12Antes.ID_CPA01)
        expect(s12.MON_CTE).toBe(sta12Antes.MON_CTE)
        expect(s12.MON_CTE_UC).toBe(sta12Antes.MON_CTE_UC)
      }

      // F9: una fila de auditoria de costo por renglon, con el precio
      // anterior y el actual.
      const aud = await tx.request().input('n', sql.Float, n).query(`
        SELECT FECHA_COMPROBANTE, COD_PROVEE, T_COMP, N_COMP, TCOMP_IN_S, NCOMP_IN_S, N_RENGL_S,
               TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, NRO_SUCURS, MON_CTE, MON_CTE_UC, COTIZACION,
               LTRIM(RTRIM(COD_ARTICU)) AS COD_ARTICU,
               PRECIO_U_L_ANTERIOR, PRECIO_U_E_ANTERIOR, PRECIO_U_L_ACTUAL, PRECIO_U_E_ACTUAL,
               PRECIO_S_L_ANTERIOR, PRECIO_S_E_ANTERIOR, PRECIO_S_L_ACTUAL, PRECIO_S_E_ACTUAL,
               PRECIO_REP_ANTERIOR, PRECIO_REP_ACTUAL, ACT_PREC_U, ACT_REPOSI, TIPO_MOVIMIENTO,
               CONVERT(varchar(23), FECHA_INGRESO, 121) AS FECHA_INGRESO, HORA_INGRESO,
               USUARIO_INGRESO, TERMINAL_INGRESO,
               CONVERT(varchar(23), FECHA_COMPROBANTE, 121) AS FECHA_COMPROBANTE_TXT
        FROM STA_AUDITORIA_COSTO_COMPRA WHERE TCOMP_IN_C = 'FP' AND NCOMP_IN_C = @n`)
      expect(aud.recordset).toHaveLength(1)
      const a = aud.recordset[0]
      expect(a).toMatchObject({
        COD_PROVEE: o.codProvee, T_COMP: 'FAC', N_COMP: `A${PTOVTA.padStart(5, '0')}${NRO}`,
        TCOMP_IN_S: '  ', NCOMP_IN_S: '        ', N_RENGL_S: 0,
        TCOMP_IN_C: 'FP', N_RENGL_C: 1, NRO_SUCURS: 0, MON_CTE: true, MON_CTE_UC: true,
        COD_ARTICU: o.codArticu, ACT_PREC_U: true, ACT_REPOSI: true,
        TIPO_MOVIMIENTO: TIPO_MOVIMIENTO_AUDITORIA, FECHA_INGRESO: `${hoyTexto} 00:00:00.000`,
        USUARIO_INGRESO: usuarioActual().slice(0, 120), TERMINAL_INGRESO: TERMINAL_APP,
        FECHA_COMPROBANTE_TXT: '2026-06-01 00:00:00.000',
      })
      expect(TIPO_MOVIMIENTO_AUDITORIA).toBe('Compras\\Comprobantes\\Factura sobre remito')
      expect(Number(a.NCOMP_IN_C)).toBe(n)
      expect(Number(a.COTIZACION)).toBe(1)
      expect(a.HORA_INGRESO).toMatch(/^\d{6}$/)
      expect(Number(a.PRECIO_U_L_ANTERIOR)).toBe(Number(sta12Antes?.PRECIO_U_L ?? 0))
      expect(Number(a.PRECIO_U_E_ANTERIOR)).toBe(Number(sta12Antes?.PRECIO_U_E ?? 0))
      expect(Number(a.PRECIO_REP_ANTERIOR)).toBe(Number(sta12Antes?.PRECIO_REP ?? 0))
      expect(Number(a.PRECIO_U_L_ACTUAL)).toBe(PRECIO_FACTURA)
      expect(Number(a.PRECIO_U_E_ACTUAL)).toBe(PRECIO_FACTURA)
      expect(Number(a.PRECIO_REP_ACTUAL)).toBe(PRECIO_FACTURA)
      for (const col of ['PRECIO_S_L_ANTERIOR', 'PRECIO_S_E_ANTERIOR', 'PRECIO_S_L_ACTUAL', 'PRECIO_S_E_ACTUAL']) {
        expect(Number(a[col])).toBe(0)
      }

      // F15: el asiento con el momento del registro, sin milisegundos.
      const asi = (await tx.request().input('n', sql.Float, n).query(`
        SELECT DATEPART(millisecond, FECHA_CONTABILIZACION) AS ms,
               CONVERT(varchar(10), FECHA_CONTABILIZACION, 121) AS dia
        FROM ASIENTO_COMPROBANTE_CP WHERE NCOMP_IN_C = @n`)).recordset[0]
      expect(asi.ms).toBe(0)
      expect(asi.dia).toBe(hoyTexto)

      // ---------- Remito parcial: 1 unidad ----------
      const rem1 = await remitoContraFactura(tx, o, { ncompInC: n }, 1, '00077201', [
        // Sin descripciones: Tango repite la serie (R7).
        { nSerie: 'PHF-CIRC-01', comentario: 'DNRPA-01' },
      ])
      const reg1 = await registrarComprobanteEn(tx, rem1)
      expect(await xactAbortOn(tx)).toBe(true) // R8
      const ncompInS1 = String(reg1.ncompInC).padStart(8, '0')

      // R1: le queda algo sin remitir, sigue 'P'.
      const estadoStk = async () => (await tx.request().input('n', sql.Float, n)
        .query(`SELECT ESTADO_STK FROM CPA04 WHERE TCOMP_IN_C = 'FP' AND NCOMP_IN_C = @n`)).recordset[0].ESTADO_STK
      expect(await estadoStk()).toBe('P')
      // R2: con pendiente de recibir, CIERRE y REC_MAS_OC no se tocan.
      r36 = await renOc()
      expect(Number(r36.CAN_PENDIE)).toBe(o.cantidad - 1)
      expect(r36.CIERRE).toBe(0)
      expect(r36.REC_MAS_OC).toBe('')
      expect(r36.ESTADO).toBe(3)

      // ---------- Remito del resto ----------
      const resto = o.cantidad - 1
      const seriesResto = Array.from({ length: resto }, (_, i) => ({
        nSerie: `PHF-CIRC-${String(i + 2).padStart(2, '0')}`,
        desc1: i === 0 ? 'MOTOR-X' : undefined,
        comentario: `DNRPA-${i + 2}`,
      }))
      const rem2 = await remitoContraFactura(tx, o, { ncompInC: n }, resto, '00077202', seriesResto)
      const reg2 = await registrarComprobanteEn(tx, rem2)
      const ncompInS2 = String(reg2.ncompInC).padStart(8, '0')

      // R1: todo remitido, 'R'.
      expect(await estadoStk()).toBe('R')
      const falta = (await tx.request().input('n', sql.Float, n)
        .query(`SELECT FALTA_REM FROM CPA46 WHERE TCOMP_IN_C = 'FP' AND NCOMP_IN_C = @n`)).recordset[0]
      expect(Number(falta.FALTA_REM)).toBe(0)

      // R2: el renglon de la OC sin pendiente: CIERRE = 1, REC_MAS_OC = 'S', 10.
      r36 = await renOc()
      expect(Number(r36.CAN_RECIBI)).toBe(o.cantidad)
      expect(Number(r36.CAN_PENDIE)).toBe(0)
      expect(Number(r36.PENDIENTE_RECIBIR_FACTURADA)).toBe(0)
      expect(r36.CIERRE).toBe(1)
      expect(r36.REC_MAS_OC).toBe('S')
      expect(r36.ESTADO).toBe(10)

      // R3: la OC pasa a Cumplida con el remito, y actualiza su auditoria.
      h35 = await cabOc()
      expect(h35.ESTADO).toBe(10)
      expect(h35.ID_ESTADO_ORDEN_COMPRA).toBe(10)
      expect(h35.FECHA).toBe(h35.HOY_SERVIDOR)
      expect(h35.HORA).toMatch(/^\d{6}$/)
      expect(h35.TERM).toBe(TERMINAL_APP)

      // R5 / R6: STA20 al deposito de la OC y con el precio de la factura.
      for (const [ncompInS, cant] of [[ncompInS1, 1], [ncompInS2, resto]] as const) {
        const s20 = (await tx.request().input('s', sql.VarChar(8), ncompInS).query(`
          SELECT COD_DEPOSI, CANTIDAD, PRECIO, PRECIO_REM, PLISTA_REM, PRECIO_REMITO_VENTAS
          FROM STA20 WHERE TCOMP_IN_S = 'RP' AND NCOMP_IN_S = @s`)).recordset[0]
        expect(s20.COD_DEPOSI).toBe(DEPOSITO_OC)
        expect(Number(s20.CANTIDAD)).toBe(cant)
        expect(Number(s20.PRECIO)).toBe(0)
        expect(Number(s20.PRECIO_REM)).toBe(PRECIO_FACTURA)
        expect(Number(s20.PLISTA_REM)).toBe(PRECIO_FACTURA)
        expect(Number(s20.PRECIO_REMITO_VENTAS)).toBe(PRECIO_FACTURA)
      }
      expect(PRECIO_FACTURA).not.toBe(o.precioOc)

      // R4 / R6: STA19 del deposito de la OC, con fecha y hora de saldo.
      const s19 = (await tx.request().input('art', sql.VarChar(15), o.codArticu).input('dep', sql.VarChar(2), DEPOSITO_OC)
        .query(`
          SELECT CANT_STOCK, DATEDIFF(second, FECHA_ACTUALIZACION_SALDO, GETDATE()) AS hace
          FROM STA19 WHERE COD_ARTICU = @art AND COD_DEPOSI = @dep`)).recordset[0]
      expect(Number(s19.CANT_STOCK)).toBe(stockAntes + o.cantidad)
      expect(s19.hace).not.toBeNull()
      expect(Number(s19.hace)).toBeGreaterThanOrEqual(0)
      expect(Number(s19.hace)).toBeLessThan(300)

      // R7: una fila por unidad en STA06 y STA07, al deposito de la OC, con
      // las descripciones vacias iguales a la serie.
      const s07 = await tx.request().input('s1', sql.VarChar(8), ncompInS1).input('s2', sql.VarChar(8), ncompInS2)
        .query(`
          SELECT NCOMP_IN_S, N_RENGL_S, TCOMP_IN_S, N_SERIE, DESC1, DESC2, COMENTARIO, COD_DEPOSI, N_PARTIDA, FILLER
          FROM STA07 WHERE TCOMP_IN_S = 'RP' AND NCOMP_IN_S IN (@s1, @s2) ORDER BY N_SERIE`)
      expect(s07.recordset).toHaveLength(o.cantidad)
      expect(s07.recordset[0]).toEqual({
        NCOMP_IN_S: ncompInS1, N_RENGL_S: 1, TCOMP_IN_S: 'RP', N_SERIE: 'PHF-CIRC-01',
        DESC1: 'PHF-CIRC-01', DESC2: 'PHF-CIRC-01', COMENTARIO: 'DNRPA-01',
        COD_DEPOSI: DEPOSITO_OC, N_PARTIDA: '', FILLER: '',
      })
      // Lo que cargo el operador se graba tal cual.
      expect(s07.recordset[1]).toMatchObject({
        NCOMP_IN_S: ncompInS2, N_RENGL_S: 1, N_SERIE: 'PHF-CIRC-02',
        DESC1: 'MOTOR-X', DESC2: 'PHF-CIRC-02', COMENTARIO: 'DNRPA-2', COD_DEPOSI: DEPOSITO_OC,
      })
      const s06 = await tx.request().input('art', sql.VarChar(15), o.codArticu).query(`
        SELECT N_SERIE, DESC1, DESC2, COMENTARIO, COD_DEPOSI, N_PARTIDA, FILLER
        FROM STA06 WHERE COD_ARTICU = @art AND N_SERIE LIKE 'PHF-CIRC-%' ORDER BY N_SERIE`)
      expect(s06.recordset).toHaveLength(o.cantidad)
      expect(s06.recordset[0]).toEqual({
        N_SERIE: 'PHF-CIRC-01', DESC1: 'PHF-CIRC-01', DESC2: 'PHF-CIRC-01', COMENTARIO: 'DNRPA-01',
        COD_DEPOSI: DEPOSITO_OC, N_PARTIDA: '', FILLER: '',
      })

      // R9: STA20.ID_STA11 / ID_STA14 los sigue completando la app (Tango los
      // deja en NULL): no se cambio, a proposito.
      const ids = (await tx.request().input('s', sql.VarChar(8), ncompInS1)
        .query(`SELECT ID_STA11, ID_STA14 FROM STA20 WHERE TCOMP_IN_S = 'RP' AND NCOMP_IN_S = @s`)).recordset[0]
      expect(ids.ID_STA11).not.toBeNull()
      expect(ids.ID_STA14).not.toBeNull()
    })
  }, 300000)

  it('F7: no registra una factura que el proveedor ya tiene en Tango con ese número', async () => {
    // Dos comprobantes de la app con el mismo proveedor y numero: la misma
    // factura importada dos veces. Factura de conceptos de 010151 (el
    // proveedor con concepto configurado), que no depende de ninguna OC.
    await conRollback(async (tx) => {
      const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const cargar = async () => {
        const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
        await guardarCampoEn(tx, id, 'tipo', 'FAC A')
        await guardarCampoEn(tx, id, 'ptovta', PTOVTA)
        await guardarCampoEn(tx, id, 'nro', '00077104')
        await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
        await guardarCampoEn(tx, id, 'codprovee', '010151')
        await guardarCampoEn(tx, id, 'condcompra', String(condicion.recordset[0].COD_CONDIC))
        await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
        await guardarCampoEn(tx, id, 'neto', '1.000,00')
        await guardarCampoEn(tx, id, 'total', '1.000,00')
        return id
      }
      await registrarComprobanteEn(tx, await cargar())
      const segunda = await cargar()
      await expect(registrarComprobanteEn(tx, segunda)).rejects.toThrow(/ya existe en Tango/)
      const comp = await tx.request().input('id', sql.Int, segunda)
        .query('SELECT ESTADO, TANGO_NCOMP_IN_C FROM PHF_COMPROBANTE WHERE ID = @id')
      expect(comp.recordset[0]).toEqual({ ESTADO: 'confirmado', TANGO_NCOMP_IN_C: null })
    })
  }, 120000)

  it('F8: corta con lo que bloquea "Listo para registrar", antes de escribir en Tango', async () => {
    await conRollback(async (tx) => {
      const oc = await ocSinTocar(tx)
      expect(oc).not.toBeNull()
      const fac = await facturaContraOc(tx, oc!, { nro: '00077102' })
      // Un punto de venta que no entra en el formato de Tango.
      await guardarCampoEn(tx, fac.id, 'ptovta', '1234567')
      await expect(registrarComprobanteEn(tx, fac.id)).rejects.toThrow(/no está listo para registrar/)
      const cpa04 = await tx.request().input('prov', sql.VarChar(6), oc!.codProvee)
        .query(`SELECT COUNT(*) AS c FROM CPA04 WHERE COD_PROVEE = @prov AND N_COMP LIKE '%00077102'`)
      expect(cpa04.recordset[0].c).toBe(0)
    })
  }, 120000)

  it('F18: el renglón de la OC se busca con su talonario', async () => {
    await conRollback(async (tx) => {
      const oc = await ocSinTocar(tx)
      expect(oc).not.toBeNull()
      const fac = await facturaContraOc(tx, oc!, { talonarioRenglon: 999, nro: '00077103' })
      await expect(registrarComprobanteEn(tx, fac.id)).rejects.toThrow(/ya no existe/)
    })
  }, 120000)

  it('F6: cada transacción arranca con XACT_ABORT OFF aunque la conexión lo haya dejado en ON', async () => {
    // El registro deja la sesión en ON y mssql devuelve la conexión al pool
    // sin resetearla. Con el pool en una sola conexión ocupada, la siguiente
    // transacción la reusa.
    await conRollback(async (tx) => {
      await fijarXactAbort(tx, true)
      expect(await xactAbortOn(tx)).toBe(true)
    })
    for (let i = 0; i < 3; i++) {
      await conTransaccion(async (tx) => {
        expect(await xactAbortOn(tx)).toBe(false)
      })
    }
  })
})

describe('descripcionesSerie (R7)', () => {
  it('repite la serie en lo que el operador dejó vacío, como Tango', () => {
    expect(descripcionesSerie({ nSerie: 'ABC', desc1: '', desc2: '', comentario: '' })).toEqual({
      desc1: 'ABC', desc2: 'ABC', comentario: 'ABC',
    })
    expect(descripcionesSerie({ nSerie: 'ABC', desc1: 'MOTOR', desc2: 'ROJO', comentario: 'DNRPA' })).toEqual({
      desc1: 'MOTOR', desc2: 'ROJO', comentario: 'DNRPA',
    })
  })
})
