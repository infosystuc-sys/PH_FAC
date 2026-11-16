import { describe, it, expect } from 'vitest'
import {
  proponerFacturas,
  validarFacturasRemito,
  claveRenglonFactura,
  type CandidatoFactura,
} from '@/lib/remitoFactura'

const HOY = new Date('2026-11-16T00:00:00')

function cand(
  ncompInC: number,
  nRenglC: number,
  codArticu: string,
  faltaRem: number,
  fecha = '2026-11-10',
): CandidatoFactura {
  return {
    tcompInC: 'FP',
    ncompInC,
    nRenglC,
    nComp: `A0000100${ncompInC}`,
    fechaEmision: new Date(`${fecha}T00:00:00`),
    codArticu,
    cantidad: faltaRem,
    faltaRem,
    oc: null,
  }
}

describe('proponerFacturas', () => {
  it('elige la factura que cubre más renglones del remito, aunque haya una más vieja', () => {
    const r = proponerFacturas(
      [
        { id: 1, codArticu: '105440', cantidad: 2 },
        { id: 2, codArticu: '107000', cantidad: 1 },
      ],
      [cand(100, 1, '105440', 5, '2026-11-01'), cand(200, 1, '105440', 2), cand(200, 2, '107000', 1)],
      HOY,
    )
    expect(r.get(1)?.ncompInC).toBe(200)
    expect(r.get(2)?.ncompInC).toBe(200)
  })

  it('entre facturas que cubren lo mismo, la más vieja', () => {
    const r = proponerFacturas(
      [{ id: 1, codArticu: '105440', cantidad: 1 }],
      [cand(300, 1, '105440', 1, '2026-11-12'), cand(250, 1, '105440', 1, '2026-11-02')],
      HOY,
    )
    expect(r.get(1)?.ncompInC).toBe(250)
  })

  it('no parte un renglón: si a la factura le falta recibir menos, no lo propone', () => {
    const r = proponerFacturas([{ id: 1, codArticu: '105440', cantidad: 3 }], [cand(100, 1, '105440', 2)], HOY)
    expect(r.size).toBe(0)
  })

  it('dos renglones del mismo artículo no toman más de lo que falta recibir', () => {
    const r = proponerFacturas(
      [
        { id: 1, codArticu: '105440', cantidad: 2 },
        { id: 2, codArticu: '105440', cantidad: 2 },
      ],
      [cand(100, 1, '105440', 3)],
      HOY,
    )
    expect(r.size).toBe(1)
  })

  it('descuenta lo que ya tomaron los renglones elegidos a mano', () => {
    const c = cand(100, 1, '105440', 3)
    const r = proponerFacturas(
      [{ id: 1, codArticu: '105440', cantidad: 2 }],
      [c],
      HOY,
      new Map([[claveRenglonFactura(c), 2]]),
    )
    expect(r.size).toBe(0)
  })

  it('no propone facturas de más de 180 días', () => {
    const r = proponerFacturas([{ id: 1, codArticu: '105440', cantidad: 1 }], [cand(100, 1, '105440', 1, '2026-03-01')], HOY)
    expect(r.size).toBe(0)
  })

  it('compara el artículo normalizado (espacios y ceros de adelante)', () => {
    const r = proponerFacturas([{ id: 1, codArticu: '27633 001', cantidad: 1 }], [cand(100, 1, '027633  001', 1)], HOY)
    expect(r.get(1)?.ncompInC).toBe(100)
  })
})

describe('validarFacturasRemito', () => {
  const fac = { nComp: 'A0000100100', faltaRem: 5 }

  it('todo contra factura: ok, y dice cuál', () => {
    const v = validarFacturasRemito([{ codArticu: '105440', cantidad: 2, factura: fac }], false)
    expect(v.estado).toBe('ok')
    expect(v.mensaje).toContain('A0000100100')
  })

  it('recibir más de lo que falta bloquea', () => {
    const v = validarFacturasRemito([{ codArticu: '105440', cantidad: 6, factura: fac }], true)
    expect(v.estado).toBe('error')
    expect(v.mensaje).toMatch(/le faltan recibir 5/)
  })

  it('sin factura bloquea hasta confirmar, después advierte', () => {
    const renglones = [{ codArticu: '105440', cantidad: 1, factura: null }]
    expect(validarFacturasRemito(renglones, false).estado).toBe('error')
    const v = validarFacturasRemito(renglones, true)
    expect(v.estado).toBe('advertencia')
    expect(v.mensaje).toMatch(/sin comprobante de referencia/)
  })

  it('mezcla: los que tienen factura se nombran y los otros se cuentan', () => {
    const v = validarFacturasRemito(
      [
        { codArticu: '105440', cantidad: 1, factura: fac },
        { codArticu: '107000', cantidad: 1, factura: null },
      ],
      true,
    )
    expect(v.estado).toBe('advertencia')
    expect(v.mensaje).toMatch(/1 renglón\(es\) contra la factura A0000100100; 1 se graban sin comprobante/)
  })
})
