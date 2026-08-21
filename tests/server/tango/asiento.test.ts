import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { cargarModeloAsiento, cuentaDelConcepto, cuentasDeArticulos, previsualizarAsientoEn } from '@/server/tango/asiento'
import { cerrarPool } from '@/server/db/pool'
import { conRollback } from '@/server/db/tx'
import { insertarComprobantePrueba, insertarRenglonPrueba } from '@/server/app/comprobantes'
import { guardarCampoEn } from '@/server/app/detalle'

afterAll(async () => {
  await cerrarPool()
})

describe('cargarModeloAsiento', () => {
  it('trae el modelo 1 con las cuentas reales verificadas contra la base', async () => {
    const modelo = await cargarModeloAsiento()

    expect(modelo.get('SB')).toMatchObject({
      codCuenta: '14003',
      descCuenta: 'COMPRAS - MERCADERIA',
      dh: 'D',
      reemplazaCuenta: true,
    })
    expect(modelo.get('EX')).toMatchObject({
      codCuenta: '14003',
      dh: 'D',
      reemplazaCuenta: true,
    })
    // Los codigos de IVA del modelo son los mismos codigos de CPA14 que ya
    // usa el formulario en porciva1..5 -- es el hallazgo central del spec.
    expect(modelo.get('1')).toMatchObject({ codCuenta: '13405', descCuenta: 'DGI - IVA CREDITO FISCAL', dh: 'D' })
    expect(modelo.get('4')).toMatchObject({ codCuenta: '13405', dh: 'D' })
    // Percepcion IIBB Tucuman, mismo codigo que codpercibb.
    expect(modelo.get('60')).toMatchObject({ codCuenta: '13411', descCuenta: 'PERCEPCIONES SUFRIDAS IIBB', dh: 'D' })
    // Total del comprobante: Haber, cuenta de proveedores, reemplazable
    // (el reemplazo en si no esta implementado -- ver el spec).
    expect(modelo.get('TO')).toMatchObject({
      codCuenta: '20002',
      descCuenta: 'PROVEEDORES',
      dh: 'H',
      reemplazaCuenta: true,
    })
  })

  it('no trae nada fuera del modulo CP', async () => {
    const modelo = await cargarModeloAsiento()
    // Sanity check: el modelo 1 tiene 27 renglones reales verificados el
    // 2026-08-21. Un numero muy distinto significa que cambio la
    // configuracion de Tango o el filtro de la query esta mal.
    expect(modelo.size).toBe(27)
  })
})

describe('cuentaDelConcepto', () => {
  it('resuelve la cuenta real del concepto 712 (TELEFONOS LOCALES)', async () => {
    const cuenta = await cuentaDelConcepto('712')
    expect(cuenta).toEqual({ codCuenta: '51460', descCuenta: 'TELEFONOS LOCALES' })
  })

  it('devuelve null para un concepto que no existe', async () => {
    const cuenta = await cuentaDelConcepto('999')
    expect(cuenta).toBeNull()
  })
})

describe('cuentasDeArticulos', () => {
  it('resuelve la cuenta de compras real de un articulo conocido', async () => {
    const cuentas = await cuentasDeArticulos(['106817'])
    expect(cuentas.get('106817')).toEqual({ codCuenta: '14003', descCuenta: 'COMPRAS - MERCADERIA' })
  })

  it('no incluye un codigo que no tiene ARTICULO_CUENTA', async () => {
    const cuentas = await cuentasDeArticulos(['no-existe-123'])
    expect(cuentas.has('no-existe-123')).toBe(false)
  })

  it('devuelve un mapa vacio para una lista vacia', async () => {
    const cuentas = await cuentasDeArticulos([])
    expect(cuentas.size).toBe(0)
  })
})

describe('previsualizarAsientoEn', () => {
  it('factura de conceptos: Subtotal gravado va a la cuenta del concepto', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'codprovee', '010151')
      await guardarCampoEn(tx, id, 'neto', '10000,00')
      await guardarCampoEn(tx, id, 'total', '12100,00')
      await guardarCampoEn(tx, id, 'porciva1', '21')
      await guardarCampoEn(tx, id, 'impiva1', '2100,00')

      const asiento = await previsualizarAsientoEn(tx, id)

      const sb = asiento.lineas.find((l) => l.descCuenta === 'TELEFONOS LOCALES')
      expect(sb).toMatchObject({ codCuenta: '51460', debe: 10000, haber: 0 })

      const iva = asiento.lineas.find((l) => l.codCuenta === '13405')
      expect(iva).toMatchObject({ debe: 2100, haber: 0 })

      const total = asiento.lineas.find((l) => l.codCuenta === '20002')
      expect(total).toMatchObject({ debe: 0, haber: 12100 })

      expect(asiento.totalDebe).toBe(12100)
      expect(asiento.totalHaber).toBe(12100)
      expect(asiento.balanceado).toBe(true)
    })
  })

  it('factura de articulos: Subtotal gravado va a la cuenta del articulo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')
      await guardarCampoEn(tx, id, 'neto', '80745,57')
      await guardarCampoEn(tx, id, 'total', '80745,57')
      await insertarRenglonPrueba(tx, id, {
        codigo: '106817', descripcion: 'Microondas', cantidad: '1',
        // PRECIO_UNITARIO_IA es DECIMAL(19,4) en PHF_RENGLON (scripts/migrate.ts) --
        // el brief traia '80745,57' (coma) aca, que no convierte implicitamente a
        // numeric. El resto del codebase pasa este campo con punto decimal
        // (ver tests/server/app/acciones.test.ts, tests/server/tango/comprobantes.test.ts).
        precioUnitario: '80745.57', importe: '80745.57',
      })

      const asiento = await previsualizarAsientoEn(tx, id)

      const sb = asiento.lineas.find((l) => l.descCuenta === 'COMPRAS - MERCADERIA')
      expect(sb).toMatchObject({ codCuenta: '14003', debe: 80745.57, haber: 0 })
    })
  })

  it('percepcion IIBB Tucuman va a la cuenta del modelo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'neto', '1000,00')
      await guardarCampoEn(tx, id, 'total', '1025,00')
      await guardarCampoEn(tx, id, 'percep1', 'Tucumán')
      await guardarCampoEn(tx, id, 'codpercep1', '60')
      await guardarCampoEn(tx, id, 'imppercep1', '25,00')

      const asiento = await previsualizarAsientoEn(tx, id)

      const percep = asiento.lineas.find((l) => l.codCuenta === '13411')
      expect(percep).toMatchObject({ debe: 25, haber: 0 })
    })
  })

  it('un comprobante sin campos no rompe: devuelve un asiento vacio', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      const asiento = await previsualizarAsientoEn(tx, id)
      expect(asiento.lineas).toEqual([])
      expect(asiento.totalDebe).toBe(0)
      expect(asiento.totalHaber).toBe(0)
      expect(asiento.balanceado).toBe(true)
    })
  })
})
