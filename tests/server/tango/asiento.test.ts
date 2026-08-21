import { describe, it, expect, afterAll } from 'vitest'
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

  it('factura de articulos con dos cuentas distintas: Subtotal gravado se prorratea, no se suma crudo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')
      await guardarCampoEn(tx, id, 'neto', '100000,00')
      await guardarCampoEn(tx, id, 'total', '100000,00')
      await insertarRenglonPrueba(tx, id, {
        codigo: '106817', descripcion: 'Microondas', cantidad: '1',
        precioUnitario: '59999.99', importe: '59999.99',
      })
      await insertarRenglonPrueba(tx, id, {
        codigo: '474575', descripcion: 'Articulo deportivo', cantidad: '1',
        precioUnitario: '40000.02', importe: '40000.02',
      })

      const asiento = await previsualizarAsientoEn(tx, id)

      const lineasSb = asiento.lineas.filter((l) => l.codCuenta === '14003' || l.codCuenta === '14007')
      expect(lineasSb).toHaveLength(2)
      // Las lineas de Subtotal gravado tienen que sumar EXACTO el neto de
      // cabecera (100000), no la suma cruda de renglones (100000.01) --
      // es justo lo que corrige el prorrateo.
      const sumaSb = lineasSb.reduce((acc, l) => acc + l.debe, 0)
      expect(Math.round(sumaSb * 100) / 100).toBe(100000)
      expect(asiento.balanceado).toBe(true)
    })
  })

  it('un articulo sin ARTICULO_CUENTA cae a la cuenta de Subtotal gravado del modelo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')
      await guardarCampoEn(tx, id, 'neto', '5000,00')
      await guardarCampoEn(tx, id, 'total', '5000,00')
      await insertarRenglonPrueba(tx, id, {
        codigo: 'no-existe-456', descripcion: 'Articulo sin cuenta configurada', cantidad: '1',
        precioUnitario: '5000.00', importe: '5000.00',
      })

      const asiento = await previsualizarAsientoEn(tx, id)

      const sb = asiento.lineas.find((l) => l.debe === 5000)
      // 14003 es la cuenta del modelo para SB (ver el test de cargarModeloAsiento).
      expect(sb).toMatchObject({ codCuenta: '14003', debe: 5000 })
    })
  })

  it('Subtotal exento va a la misma cuenta que Subtotal gravado en conceptos', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'codprovee', '010151')
      await guardarCampoEn(tx, id, 'neto', '8000,00')
      await guardarCampoEn(tx, id, 'exento', '2000,00')
      await guardarCampoEn(tx, id, 'total', '10000,00')

      const asiento = await previsualizarAsientoEn(tx, id)

      const lineasCuenta51460 = asiento.lineas.filter((l) => l.codCuenta === '51460')
      expect(lineasCuenta51460).toHaveLength(2)
      expect(lineasCuenta51460.map((l) => l.debe).sort((a, b) => a - b)).toEqual([2000, 8000])
    })
  })

  it('cuenta las lineas omitidas por falta de codigo, sin bloquear', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'neto', '1000,00')
      await guardarCampoEn(tx, id, 'total', '1050,00')
      // Jurisdiccion que no matchea ninguna de JURISDICCIONES_IIBB: sin-codigo.
      await guardarCampoEn(tx, id, 'percep1', 'Jurisdiccion inventada que no existe')
      await guardarCampoEn(tx, id, 'imppercep1', '50,00')

      const asiento = await previsualizarAsientoEn(tx, id)

      expect(asiento.lineasOmitidas).toBe(1)
      expect(asiento.balanceado).toBe(false)
    })
  })
})
