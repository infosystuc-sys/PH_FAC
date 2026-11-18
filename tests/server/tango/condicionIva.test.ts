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
import { previsualizarAsientoEn } from '@/server/tango/asiento'

afterAll(async () => {
  await cerrarPool()
})

/**
 * N3 y N4 del 2026-11-18: el gravado, el exento y la fila al 0% de CPA63
 * como los graba Tango segun la condicion de IVA del proveedor. Ver
 * src/lib/condicionIva.ts, donde estan las cifras medidas sobre la base.
 *
 * Todo corre dentro de `conRollback`. Los proveedores son reales,
 * descubiertos en runtime: uno con la condicion pedida y concepto
 * configurado en Tango (las facturas de conceptos no registran sin el).
 */
async function proveedorConConcepto(tx: sql.Transaction, condIva: string): Promise<string | null> {
  const r = await tx.request().input('c', sql.VarChar(3), condIva).query<{ cod: string }>(`
    SELECT TOP 1 LTRIM(RTRIM(p.COD_PROVEE)) AS cod
    FROM CPA01 p
    JOIN CPA_CONCEPTOS_PROVEEDOR c ON c.COD_PROVEE = p.COD_PROVEE
    WHERE LTRIM(RTRIM(p.COND_IVA)) = @c
    ORDER BY p.COD_PROVEE`)
  return r.recordset[0]?.cod ?? null
}

type Importes = { neto?: string; exento?: string; porciva1?: string; impiva1?: string; total: string }

async function facturaDeConceptos(tx: sql.Transaction, codProvee: string, letra: string, nro: string, imp: Importes) {
  const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
  const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
  await guardarCampoEn(tx, id, 'tipo', `FAC ${letra}`)
  await guardarCampoEn(tx, id, 'ptovta', '9996')
  await guardarCampoEn(tx, id, 'nro', nro)
  await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
  await guardarCampoEn(tx, id, 'codprovee', codProvee)
  await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
  await guardarCampoEn(tx, id, 'condcompra', String(condicion.recordset[0].COD_CONDIC))
  await guardarCampoEn(tx, id, 'moneda', 'ARS')
  await guardarCampoEn(tx, id, 'cotizacion', '1')
  for (const [clave, valor] of Object.entries(imp)) {
    if (valor !== undefined) await guardarCampoEn(tx, id, clave, valor)
  }
  return id
}

async function leerFactura(tx: sql.Transaction, ncompInC: number) {
  const r = await tx.request().input('n', sql.Float, ncompInC).query(`
    SELECT RTRIM(CAT_IVA) AS CAT_IVA, IMPORTE_NE, SUBT_GRAVA, IMPORTE_EX, SUBT_EXENT, IMPORTE_TO
    FROM CPA04 WHERE TCOMP_IN_C = 'FP' AND NCOMP_IN_C = @n;
    SELECT IMPORTE_NE, IMPORTE_GRAVADO, IMPORTE_EXENTO FROM CPA47 WHERE TCOMP_IN_C = 'FP' AND NCOMP_IN_C = @n;
    SELECT RTRIM(CLAS_SIAP) AS clas, PORC_ALICU AS porc, IMPORTE AS importe
    FROM CPA63 WHERE TCOMP_IN_C = 'FP' AND NCOMP_IN_C = @n ORDER BY PORC_ALICU DESC;
    SELECT a.D_H, a.IMPORTE_RENGLON_BASE_CP AS importe
    FROM ASIENTO_CP a JOIN ASIENTO_COMPROBANTE_CP h ON h.ID_ASIENTO_COMPROBANTE_CP = a.ID_ASIENTO_COMPROBANTE_CP
    WHERE h.NCOMP_IN_C = @n;`)
  const sets = r.recordsets as unknown as Record<string, unknown>[][]
  const num = (v: unknown) => Number(v)
  return {
    cpa04: sets[0][0],
    cpa47: sets[1],
    cpa63: sets[2].map((f) => ({ clas: String(f.clas), porc: num(f.porc), importe: num(f.importe) })),
    debe: sets[3].filter((f) => f.D_H === 'D').reduce((a, f) => a + num(f.importe), 0),
    haber: sets[3].filter((f) => f.D_H === 'H').reduce((a, f) => a + num(f.importe), 0),
  }
}

describe('registro segun la condicion de IVA del proveedor', () => {
  it('N3: la factura C de un monotributista va toda exenta, con su fila C9 al 0%', async () => {
    await conRollback(async (tx) => {
      const prov = await proveedorConConcepto(tx, 'RS')
      // La base tiene monotributistas con concepto: si no, el test pasaria sin probar nada.
      expect(prov).not.toBeNull()
      // Lo que lee la IA de una factura C: el total como neto, sin IVA.
      const id = await facturaDeConceptos(tx, prov!, 'C', '00088101', { neto: '10.000,00', total: '10.000,00' })

      // La vista previa del asiento ya muestra el subtotal como exento.
      const preview = await previsualizarAsientoEn(tx, id)
      expect(preview.lineas.filter((l) => l.debe > 0).map((l) => l.debe)).toEqual([10000])

      const registro = await registrarComprobanteEn(tx, id)
      const f = await leerFactura(tx, registro.ncompInC)

      expect(f.cpa04.CAT_IVA).toBe('RS')
      expect(Number(f.cpa04.IMPORTE_NE)).toBe(0)
      expect(Number(f.cpa04.SUBT_GRAVA)).toBe(0)
      expect(Number(f.cpa04.IMPORTE_EX)).toBe(10000)
      expect(Number(f.cpa04.SUBT_EXENT)).toBe(10000)
      expect(Number(f.cpa04.IMPORTE_TO)).toBe(10000)
      expect(f.cpa47).toHaveLength(1)
      expect(Number(f.cpa47[0].IMPORTE_GRAVADO)).toBe(0)
      expect(Number(f.cpa47[0].IMPORTE_EXENTO)).toBe(10000)
      expect(Number(f.cpa47[0].IMPORTE_NE)).toBe(10000)
      expect(f.cpa63).toEqual([{ clas: 'C9', porc: 0, importe: 10000 }])
      expect(f.debe).toBeCloseTo(10000, 2)
      expect(f.haber).toBeCloseTo(10000, 2)
    })
  })

  it('N3: el proveedor exento va todo exento, con su fila C7 al 0%', async () => {
    await conRollback(async (tx) => {
      const prov = await proveedorConConcepto(tx, 'EX')
      expect(prov).not.toBeNull()
      const id = await facturaDeConceptos(tx, prov!, 'C', '00088102', { neto: '2.500,50', total: '2.500,50' })
      const registro = await registrarComprobanteEn(tx, id)
      const f = await leerFactura(tx, registro.ncompInC)

      expect(Number(f.cpa04.IMPORTE_NE)).toBe(0)
      expect(Number(f.cpa04.IMPORTE_EX)).toBe(2500.5)
      expect(f.cpa63).toEqual([{ clas: 'C7', porc: 0, importe: 2500.5 }])
    })
  })

  it('N4: la factura de un RI solo exenta lleva su fila SIN al 0%', async () => {
    await conRollback(async (tx) => {
      const prov = await proveedorConConcepto(tx, 'RI')
      expect(prov).not.toBeNull()
      const id = await facturaDeConceptos(tx, prov!, 'A', '00088103', { exento: '5.000,00', total: '5.000,00' })
      const registro = await registrarComprobanteEn(tx, id)
      const f = await leerFactura(tx, registro.ncompInC)

      expect(f.cpa04.CAT_IVA).toBe('RI')
      expect(Number(f.cpa04.IMPORTE_NE)).toBe(0)
      expect(Number(f.cpa04.IMPORTE_EX)).toBe(5000)
      expect(Number(f.cpa47[0].IMPORTE_EXENTO)).toBe(5000)
      expect(f.cpa63).toEqual([{ clas: 'SIN', porc: 0, importe: 5000 }])
    })
  })

  it('N4: la de un RI con IVA y parte exenta lleva la fila del IVA y la del exento', async () => {
    await conRollback(async (tx) => {
      const prov = await proveedorConConcepto(tx, 'RI')
      expect(prov).not.toBeNull()
      const id = await facturaDeConceptos(tx, prov!, 'A', '00088104', {
        neto: '10.000,00', exento: '500,00', porciva1: '21', impiva1: '2.100,00', total: '12.600,00',
      })
      const registro = await registrarComprobanteEn(tx, id)
      const f = await leerFactura(tx, registro.ncompInC)

      // El gravado sigue gravado: un RI no se reclasifica.
      expect(Number(f.cpa04.IMPORTE_NE)).toBe(10000)
      expect(Number(f.cpa04.IMPORTE_EX)).toBe(500)
      expect(f.cpa63).toEqual([
        { clas: 'SIN', porc: 21, importe: 2100 },
        { clas: 'SIN', porc: 0, importe: 500 },
      ])
    })
  })

  it('N3: la factura de articulos de un monotributista graba los renglones exentos', async () => {
    await conRollback(async (tx) => {
      // Una OC real emitida y sin tocar, de un renglon (mismo criterio que
      // circuitoOcFacturaRemito.test.ts). Su proveedor pasa a monotributista
      // dentro de la transaccion.
      const r = await tx.request().query(`
        SELECT TOP 1 h.N_ORDEN_CO, h.TALONARIO, LTRIM(RTRIM(h.COD_PROVEE)) AS COD_PROVEE,
               r.N_RENGL_OC, LTRIM(RTRIM(r.COD_ARTICU)) AS COD_ARTICU, r.CAN_PEDIDA
        FROM CPA35 h
        JOIN CPA36 r ON r.N_ORDEN_CO = h.N_ORDEN_CO AND r.TALONARIO = h.TALONARIO
        JOIN STA11 a ON a.COD_ARTICU = r.COD_ARTICU
        WHERE h.ESTADO = 3 AND ISNULL(r.CAN_RECIBI, 0) = 0 AND ISNULL(r.CANTIDAD_FACTURADA, 0) = 0
          AND r.PENDIENTE_FACTURAR = r.CAN_PEDIDA AND r.CAN_PENDIE = r.CAN_PEDIDA
          AND r.CAN_PEDIDA BETWEEN 2 AND 20 AND r.CAN_PEDIDA = FLOOR(r.CAN_PEDIDA)
          AND ISNULL(r.PRECIO, 0) > 0 AND ISNULL(r.CIERRE, 0) = 0
          AND a.STOCK = 1 AND ISNULL(a.USA_PARTID, 0) = 0 AND ISNULL(a.USA_SERIE, 0) = 0
          AND LTRIM(RTRIM(ISNULL(a.USA_ESC, 'N'))) <> 'B'
          AND (SELECT COUNT(*) FROM CPA36 x WHERE x.N_ORDEN_CO = h.N_ORDEN_CO AND x.TALONARIO = h.TALONARIO) = 1
          AND EXISTS (SELECT 1 FROM CPA01 p WHERE p.COD_PROVEE = h.COD_PROVEE)
        ORDER BY r.CAN_PEDIDA, h.N_ORDEN_CO DESC`)
      const oc = r.recordset[0]
      expect(oc).toBeDefined()
      const codProvee = String(oc.COD_PROVEE)
      const cantidad = Number(oc.CAN_PEDIDA)
      const precio = 1000.5
      const neto = Math.round(cantidad * precio * 100) / 100
      const netoTexto = String(neto).replace('.', ',')

      await tx.request().input('p', sql.VarChar(6), codProvee)
        .query(`UPDATE CPA01 SET COND_IVA = 'RS' WHERE COD_PROVEE = @p`)

      const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC C')
      await guardarCampoEn(tx, id, 'ptovta', '9996')
      await guardarCampoEn(tx, id, 'nro', '00088105')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'codprovee', codProvee)
      await guardarCampoEn(tx, id, 'condcompra', String(condicion.recordset[0].COD_CONDIC))
      await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')
      await guardarCampoEn(tx, id, 'neto', netoTexto)
      await guardarCampoEn(tx, id, 'total', netoTexto)
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: String(oc.COD_ARTICU), descripcion: 'x', cantidad: String(cantidad),
        precioUnitario: String(precio), importe: String(neto),
      })
      await tx.request()
        .input('id', sql.Int, renglonId)
        .input('oc', sql.VarChar(14), String(oc.N_ORDEN_CO))
        .input('tal', sql.Int, Number(oc.TALONARIO))
        .input('r', sql.Int, Number(oc.N_RENGL_OC))
        .input('p', sql.Decimal(19, 4), cantidad)
        .query(`
          UPDATE PHF_RENGLON
          SET OC_N_ORDEN_CO=@oc, OC_TALONARIO=@tal, OC_N_RENGL_OC=@r, OC_PENDIENTE=@p, PDF_ORDEN=1
          WHERE ID=@id`)
      await insertarRenglonPdfPrueba(tx, id, 1, String(oc.COD_ARTICU), String(cantidad), String(precio), String(neto))

      const registro = await registrarComprobanteEn(tx, id)
      const f = await leerFactura(tx, registro.ncompInC)
      expect(Number(f.cpa04.IMPORTE_NE)).toBe(0)
      expect(Number(f.cpa04.IMPORTE_EX)).toBe(neto)
      expect(f.cpa63).toEqual([{ clas: 'C9', porc: 0, importe: neto }])
      expect(f.debe).toBeCloseTo(neto, 2)
      expect(f.haber).toBeCloseTo(neto, 2)

      const renglones = (await tx.request().input('n', sql.Float, registro.ncompInC).query(`
        SELECT IMP_NETO_P, IMPORTE_EXENTO, IMPORTE_GRAVADO FROM CPA46
        WHERE TCOMP_IN_C = 'FP' AND NCOMP_IN_C = @n`)).recordset
      expect(renglones).toHaveLength(1)
      expect(Number(renglones[0].IMPORTE_EXENTO)).toBe(neto)
      expect(Number(renglones[0].IMPORTE_GRAVADO)).toBe(0)
      expect(Number(renglones[0].IMP_NETO_P)).toBe(neto)
    })
  })
})
