import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { getPool } from '@/server/db/pool'
import { cerrarPool } from '@/server/db/pool'
import { conRollback } from '@/server/db/tx'
import { insertarComprobantePrueba, insertarRenglonPrueba } from '@/server/app/comprobantes'
import { guardarCampoEn } from '@/server/app/detalle'
import { buscarFacturaEnCpa04, mapearAlicuotaIva, registrarComprobanteEn } from '@/server/tango/comprobantes'
import { COD_CONCEPTO_TARJETA } from '@/server/tango/conceptos'

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
  it('resuelve un porcentaje sin ambiguedad (21%)', async () => {
    const r = await mapearAlicuotaIva(21)
    expect(r).not.toBeNull()
    expect(r!.codigo).toBe(1)
    expect(r!.porcentaje).toBe(21)
  })

  it('resuelve 10,5% sin ambiguedad', async () => {
    const r = await mapearAlicuotaIva(10.5)
    expect(r!.codigo).toBe(3)
  })

  it('al 3% (ambiguo entre 15 y 16), siempre resuelve al 15', async () => {
    const r = await mapearAlicuotaIva(3)
    expect(r!.codigo).toBe(15)
  })

  it('devuelve null si el porcentaje no matchea ningun codigo', async () => {
    const r = await mapearAlicuotaIva(99)
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

describe('registrarComprobanteEn con remito asignado', () => {
  it('copia el renglon del remito a CPA46 y actualiza STA20/STA14', async () => {
    await conRollback(async (tx) => {
      // Un remito pendiente real, descubierto en runtime.
      const remito = await tx.request().query(`
        SELECT TOP 1 h.NCOMP_IN_S, h.COD_PRO_CL, r.N_RENGL_S, r.COD_ARTICU, r.COD_DEPOSI,
               r.CANT_PEND, r.PRECIO_REM
        FROM STA14 h JOIN STA20 r ON r.TCOMP_IN_S=h.TCOMP_IN_S AND r.NCOMP_IN_S=h.NCOMP_IN_S
        WHERE h.TCOMP_IN_S='RP' AND h.ESTADO_MOV='P' AND r.CANT_PEND > 0`)
      const codProvee = String(remito.recordset[0].COD_PRO_CL).trim()
      const ncompInS = String(remito.recordset[0].NCOMP_IN_S).trim()
      const nRenglS = Number(remito.recordset[0].N_RENGL_S)
      const cantPendAntes = Number(remito.recordset[0].CANT_PEND)

      const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const condCompra = String(condicion.recordset[0].COD_CONDIC)

      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0088')
      await guardarCampoEn(tx, id, 'nro', '00054321')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'codprovee', codProvee)
      await guardarCampoEn(tx, id, 'condcompra', condCompra)
      await guardarCampoEn(tx, id, 'total', '1.000,00')
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: '', descripcion: '', cantidad: '1', precioUnitario: '1000', importe: '1000',
      })
      // asignarRemitoEn llega en la Task 9 (server/app/acciones.ts, escribe una tabla
      // propia). Para no crear una dependencia entre tasks, este test escribe el link
      // directo -- lo unico que valida esta task es que registrarComprobanteEn lo lea
      // y lo procese bien, no como se escribio.
      await tx.request()
        .input('id', sql.Int, renglonId).input('n', sql.VarChar(8), ncompInS).input('r', sql.Int, nRenglS)
        .query(`UPDATE PHF_RENGLON SET REMITO_NCOMP_IN_S=@n, REMITO_N_RENGL_S=@r WHERE ID=@id`)

      const registro = await registrarComprobanteEn(tx, id)

      const cpa46 = await tx.request()
        .input('t', sql.VarChar(2), 'FP').input('n', sql.Float, registro.ncompInC)
        .query(`SELECT * FROM CPA46 WHERE TCOMP_IN_C=@t AND NCOMP_IN_C=@n`)
      expect(cpa46.recordset).toHaveLength(1)
      expect(cpa46.recordset[0].COD_ARTICU.trim()).toBe(String(remito.recordset[0].COD_ARTICU).trim())

      const cpa48 = await tx.request()
        .input('t', sql.VarChar(2), 'FP').input('n', sql.Float, registro.ncompInC)
        .query(`SELECT * FROM CPA48 WHERE TCOMP_IN_C=@t AND LTRIM(RTRIM(NCOMP_IN_C))=CAST(@n AS VARCHAR)`)
      expect(cpa48.recordset).toHaveLength(1)

      const sta20 = await tx.request()
        .input('n', sql.VarChar(8), ncompInS).input('r', sql.Int, nRenglS)
        .query(`SELECT CANT_FACTU, CANT_PEND FROM STA20 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n AND N_RENGL_S=@r`)
      expect(Number(sta20.recordset[0].CANT_PEND)).toBe(cantPendAntes - 1)
    })
  }, 90000)
})

describe('registrarComprobanteEn con tipoFactura=conceptos', () => {
  it('inserta un renglon en CPA47 con el concepto del proveedor', async () => {
    await conRollback(async (tx) => {
      // 010151 (AMX/Claro) es el unico proveedor con concepto configurado
      // hoy en CPA_CONCEPTOS_PROVEEDOR (concepto 712, "TELEFONOS LOCALES").
      const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const condCompra = String(condicion.recordset[0].COD_CONDIC)

      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0077')
      await guardarCampoEn(tx, id, 'nro', '00011111')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'codprovee', '010151')
      await guardarCampoEn(tx, id, 'condcompra', condCompra)
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'neto', '10.000,00')
      await guardarCampoEn(tx, id, 'exento', '500,00')
      await guardarCampoEn(tx, id, 'total', '10.500,00')

      const registro = await registrarComprobanteEn(tx, id)

      const cpa47 = await tx.request()
        .input('t', sql.VarChar(2), 'FP').input('n', sql.Float, registro.ncompInC)
        .query(`SELECT * FROM CPA47 WHERE TCOMP_IN_C=@t AND NCOMP_IN_C=@n`)
      expect(cpa47.recordset).toHaveLength(1)
      expect(cpa47.recordset[0].COD_CONCEP.trim()).toBe('712')
      expect(Number(cpa47.recordset[0].N_RENGL_C)).toBe(1)
      expect(Number(cpa47.recordset[0].IMPORTE_GRAVADO)).toBe(10000)
      expect(Number(cpa47.recordset[0].IMPORTE_EXENTO)).toBe(500)
      expect(Number(cpa47.recordset[0].IMPORTE_NE)).toBe(10500)
      expect(Number(cpa47.recordset[0].IMPORT_PAN)).toBe(10500)
      expect(Number(cpa47.recordset[0].IMP_NETO_P)).toBe(10500)
    })
  }, 90000)

  it('bloquea el registro si el proveedor no tiene concepto configurado', async () => {
    await conRollback(async (tx) => {
      const prov = await tx.request().query(`
        SELECT TOP 1 p.COD_PROVEE FROM CPA01 p
        WHERE p.COD_PROVEE NOT IN (SELECT COD_PROVEE FROM CPA_CONCEPTOS_PROVEEDOR)
        ORDER BY p.COD_PROVEE`)
      const codProvee = String(prov.recordset[0].COD_PROVEE).trim()

      const condicion = await tx.request().query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const condCompra = String(condicion.recordset[0].COD_CONDIC)

      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0077')
      await guardarCampoEn(tx, id, 'nro', '00022222')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'codprovee', codProvee)
      await guardarCampoEn(tx, id, 'condcompra', condCompra)
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'total', '100,00')

      await expect(registrarComprobanteEn(tx, id)).rejects.toThrow(/no tiene un concepto configurado/i)

      // Falla temprano, antes del INSERT de CPA04: no debe haber quedado
      // nada escrito ni el comprobante marcado como registrado.
      const comp = await tx.request().input('id', sql.Int, id)
        .query(`SELECT ESTADO, TANGO_NCOMP_IN_C FROM PHF_COMPROBANTE WHERE ID=@id`)
      expect(comp.recordset[0].ESTADO).toBe('confirmado')
      expect(comp.recordset[0].TANGO_NCOMP_IN_C).toBeNull()
    })
  }, 30000)
})

describe('registrarComprobanteEn con liquidacion de tarjeta', () => {
  it('imputa el comprobante entero al concepto fijo de comisiones en CPA47', async () => {
    await conRollback(async (tx) => {
      const prov = await tx.request().query(`
        SELECT TOP 1 COD_PROVEE, N_CUIT FROM CPA01
        WHERE N_CUIT IS NOT NULL AND LEN(REPLACE(REPLACE(N_CUIT,'-',''),' ','')) = 11
        ORDER BY COD_PROVEE`)
      const codProvee = String(prov.recordset[0].COD_PROVEE).trim()
      const cuit = String(prov.recordset[0].N_CUIT)

      const condicion = await tx.request()
        .query(`SELECT TOP 1 COD_CONDIC FROM CONDICION_COMPRA ORDER BY COD_CONDIC`)
      const condCompra = String(condicion.recordset[0].COD_CONDIC)

      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'tarjeta')
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0088')
      await guardarCampoEn(tx, id, 'nro', '00054321')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'cuit', cuit)
      await guardarCampoEn(tx, id, 'codprovee', codProvee)
      await guardarCampoEn(tx, id, 'condcompra', condCompra)
      await guardarCampoEn(tx, id, 'neto', '10.000,00')
      await guardarCampoEn(tx, id, 'porciva1', '21')
      await guardarCampoEn(tx, id, 'impiva1', '2.100,00')
      await guardarCampoEn(tx, id, 'total', '12.100,00')

      const registro = await registrarComprobanteEn(tx, id)

      // El renglon de concepto es lo que distingue esta ruta: la liquidacion
      // no tiene detalle de cupones, se imputa entera contra una cuenta.
      const cpa47 = await tx.request()
        .input('n', sql.Float, registro.ncompInC)
        .query(`SELECT * FROM CPA47 WHERE TCOMP_IN_C='FP' AND NCOMP_IN_C=@n`)

      expect(cpa47.recordset).toHaveLength(1)
      // Fijo, no el de la ficha del proveedor: el proveedor de una
      // liquidacion es la tarjeta o el banco, y lo que se imputa es la
      // comision sin importar quien la cobre.
      expect(String(cpa47.recordset[0].COD_CONCEP).trim()).toBe(COD_CONCEPTO_TARJETA)
      expect(Number(cpa47.recordset[0].IMPORTE_GRAVADO)).toBe(10000)
    })
  }, 120_000)
})
