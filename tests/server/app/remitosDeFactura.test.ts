import { describe, it, expect } from 'vitest'
import { validarRemitosAVincular, type RemitoAVincular } from '@/server/app/remitosDeFactura'

const v = (p: Partial<RemitoAVincular>): RemitoAVincular => ({
  nOrdenCo: ' 0000100001708',
  nRenglOc: 1,
  codArticu: '105440AZ',
  cantidadFactura: 2,
  pendienteOc: 2,
  pendienteRemito: 2,
  remitos: ['R0001100025490'],
  ...p,
})

describe('validarRemitosAVincular (2026-11-18)', () => {
  it('sin remito en la OC no hay nada que decir: la factura sigue como siempre', () => {
    expect(validarRemitosAVincular([])).toBeNull()
  })

  it('con las cantidades iguales avisa a que remito se vincula, sin bloquear', () => {
    const r = validarRemitosAVincular([v({}), v({ nRenglOc: 2, codArticu: '105440RO', cantidadFactura: 3, pendienteRemito: 3 })])
    expect(r?.estado).toBe('advertencia')
    expect(r?.mensaje).toContain('R0001100025490')
    expect(r?.mensaje).toContain('2 renglón(es)')
  })

  it('si la factura cobra distinto de lo que el remito tiene sin facturar, bloquea con el detalle', () => {
    const r = validarRemitosAVincular([v({ cantidadFactura: 3, pendienteRemito: 2, pendienteOc: 3 })])
    expect(r?.estado).toBe('error')
    expect(r?.mensaje).toMatch(/105440AZ factura 3, remito 2 sin facturar, orden 3 pendiente/)
  })
})
