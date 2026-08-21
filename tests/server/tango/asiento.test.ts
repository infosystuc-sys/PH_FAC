import { describe, it, expect, afterAll } from 'vitest'
import { cargarModeloAsiento, cuentaDelConcepto, cuentasDeArticulos } from '@/server/tango/asiento'
import { cerrarPool } from '@/server/db/pool'

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
