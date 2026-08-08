import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { getPool } from '@/server/db/pool'
import { cerrarPool } from '@/server/db/pool'
import { conRollback } from '@/server/db/tx'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { guardarCampoEn } from '@/server/app/detalle'
import { buscarFacturaEnCpa04, mapearAlicuotaIva, registrarComprobanteEn } from '@/server/tango/comprobantes'

afterAll(async () => {
  await cerrarPool()
})

describe('buscarFacturaEnCpa04', () => {
  it('encuentra una factura real por proveedor + N_COMP', async () => {
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT TOP 1 COD_PROVEE, N_COMP FROM CPA04 WHERE T_COMP = 'FAC' ORDER BY NCOMP_IN_C DESC
    `)
    const fila = r.recordset[0]
    const encontrado = await buscarFacturaEnCpa04(fila.COD_PROVEE, fila.N_COMP)
    expect(encontrado).not.toBeNull()
    expect(encontrado!.nComp).toBe(fila.N_COMP.trim())
  })

  it('devuelve null si no hay ninguna factura con ese N_COMP', async () => {
    const r = await buscarFacturaEnCpa04('999999', 'Z9999999999999')
    expect(r).toBeNull()
  })
})

describe('mapearAlicuotaIva', () => {
  it('resuelve un porcentaje sin ambiguedad (21%) sin necesitar codigo elegido', async () => {
    const r = await mapearAlicuotaIva(21, null)
    expect(r).not.toBeNull()
    expect(r!.codigo).toBe(1)
    expect(r!.porcentaje).toBe(21)
  })

  it('resuelve 10,5% sin ambiguedad', async () => {
    const r = await mapearAlicuotaIva(10.5, null)
    expect(r!.codigo).toBe(3)
  })

  it('al 3% (ambiguo), usa el codigo elegido por el operador', async () => {
    const r16 = await mapearAlicuotaIva(3, '16')
    expect(r16!.codigo).toBe(16)

    const r15 = await mapearAlicuotaIva(3, '15')
    expect(r15!.codigo).toBe(15)
  })

  it('al 3% sin codigo elegido, devuelve null (el llamador debe haber bloqueado esto antes)', async () => {
    const r = await mapearAlicuotaIva(3, null)
    expect(r).toBeNull()
  })

  it('devuelve null si el porcentaje no matchea ningun codigo', async () => {
    const r = await mapearAlicuotaIva(99, null)
    expect(r).toBeNull()
  })
})

describe('registrarComprobanteEn', () => {
  // Timeout mayor al default (20s) del proyecto: el INSERT contra CPA04 tarda
  // ~20s en esta base real (verificado con diagnostico de tiempos por pasos,
  // no es un cuelgue de la funcion -- corre completo en ~53s con margen).
  it('registra un comprobante sin renglones: cabecera, percepciones, IVA y vencimiento', async () => {
    await conRollback(async (tx) => {
      // Proveedor real sin CUIT duplicado, descubierto en runtime (mismo patron que
      // el resto de la suite -- no hardcodear un codigo que puede cambiar).
      const prov = await tx.request().query(`
        SELECT TOP 1 COD_PROVEE, N_CUIT FROM CPA01
        WHERE N_CUIT IS NOT NULL AND LEN(REPLACE(REPLACE(N_CUIT,'-',''),' ','')) = 11
        ORDER BY COD_PROVEE`)
      const codProvee = String(prov.recordset[0].COD_PROVEE).trim()
      const cuit = String(prov.recordset[0].N_CUIT)

      const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const condCompra = String(condicion.recordset[0].COD_CONDIC)

      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0099')
      await guardarCampoEn(tx, id, 'nro', '00012345')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'cuit', cuit)
      await guardarCampoEn(tx, id, 'codprovee', codProvee)
      await guardarCampoEn(tx, id, 'condcompra', condCompra)
      await guardarCampoEn(tx, id, 'moneda', 'ARS')
      await guardarCampoEn(tx, id, 'cotizacion', '1')
      await guardarCampoEn(tx, id, 'neto', '10.000,00')
      await guardarCampoEn(tx, id, 'porciva1', '21')
      await guardarCampoEn(tx, id, 'impiva1', '2.100,00')
      await guardarCampoEn(tx, id, 'total', '12.100,00')

      const registro = await registrarComprobanteEn(tx, id)

      expect(registro.tComp).toBe('FAC')
      expect(registro.nComp).toBe('A0009900012345')
      expect(registro.ncompInC).toBeGreaterThan(0)

      const cpa04 = await tx.request()
        .input('n', sql.Float, registro.ncompInC)
        .query(`SELECT * FROM CPA04 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)
      expect(cpa04.recordset).toHaveLength(1)
      expect(cpa04.recordset[0].COD_PROVEE.trim()).toBe(codProvee)
      expect(Number(cpa04.recordset[0].IMPORTE_NE)).toBe(10000)
      expect(Number(cpa04.recordset[0].IMPORTE_TO)).toBe(12100)
      expect(Number(cpa04.recordset[0].COD_IVA1)).toBe(1) // 21% -> COD_IVA 1

      const cta05 = await tx.request()
        .input('n', sql.Float, registro.ncompInC)
        .query(`SELECT * FROM CTA05 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)
      expect(cta05.recordset).toHaveLength(1)

      const cpa54 = await tx.request()
        .input('t', sql.VarChar(10), registro.tComp)
        .input('n', sql.VarChar(20), registro.nComp)
        .query(`SELECT * FROM CPA54 WHERE T_COMP=@t AND N_COMP=@n`)
      expect(cpa54.recordset.length).toBeGreaterThan(0)

      const auditoria = await tx.request()
        .input('id', sql.Int, id)
        .query(`SELECT ESTADO, TANGO_NCOMP_IN_C FROM PHF_COMPROBANTE WHERE ID=@id`)
      expect(auditoria.recordset[0].ESTADO).toBe('registrado')
      expect(Number(auditoria.recordset[0].TANGO_NCOMP_IN_C)).toBe(registro.ncompInC)
    })
  }, 90000)

  // Llama a la funcion completa dos veces seguidas -- casi el doble de tiempo
  // que el test de arriba.
  it('es idempotente: llamarla dos veces devuelve el mismo registro sin duplicar', async () => {
    await conRollback(async (tx) => {
      const prov = await tx.request().query(`
        SELECT TOP 1 COD_PROVEE, N_CUIT FROM CPA01
        WHERE N_CUIT IS NOT NULL AND LEN(REPLACE(REPLACE(N_CUIT,'-',''),' ','')) = 11
        ORDER BY COD_PROVEE`)
      const codProvee = String(prov.recordset[0].COD_PROVEE).trim()

      const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const condCompra = String(condicion.recordset[0].COD_CONDIC)

      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0099')
      await guardarCampoEn(tx, id, 'nro', '00099999')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'codprovee', codProvee)
      await guardarCampoEn(tx, id, 'condcompra', condCompra)
      await guardarCampoEn(tx, id, 'total', '1.000,00')

      const r1 = await registrarComprobanteEn(tx, id)
      const r2 = await registrarComprobanteEn(tx, id)
      expect(r2.ncompInC).toBe(r1.ncompInC)

      const cpa04 = await tx.request()
        .input('n', sql.Float, r1.ncompInC)
        .query(`SELECT COUNT(*) AS c FROM CPA04 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)
      expect(Number(cpa04.recordset[0].c)).toBe(1)
    })
  }, 150000)
})
