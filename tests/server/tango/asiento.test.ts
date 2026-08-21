import { describe, it, expect, afterAll } from 'vitest'
import { cargarModeloAsiento } from '@/server/tango/asiento'
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
