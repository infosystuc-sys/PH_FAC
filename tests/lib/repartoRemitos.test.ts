import { describe, it, expect } from 'vitest'
import { repartirEntreRemitos } from '@/lib/repartoRemitos'

const s = (ncompInS: string, nRenglS: number, pendiente: number) => ({ ncompInS, nRenglS, pendiente })

describe('repartirEntreRemitos', () => {
  it('un remito que alcanza lo cubre entero', () => {
    expect(repartirEntreRemitos(2, [s('00000001', 1, 5)])).toEqual({
      partes: [{ ncompInS: '00000001', nRenglS: 1, cantidad: 2 }],
      faltaRem: 0,
    })
  })

  it('consume primero el remito más viejo y sigue con el siguiente', () => {
    const r = repartirEntreRemitos(5, [s('00000001', 1, 3), s('00000002', 1, 4)])
    expect(r.partes).toEqual([
      { ncompInS: '00000001', nRenglS: 1, cantidad: 3 },
      { ncompInS: '00000002', nRenglS: 1, cantidad: 2 },
    ])
    expect(r.faltaRem).toBe(0)
  })

  it('lo que ningún remito cubre queda en faltaRem', () => {
    const r = repartirEntreRemitos(2, [s('00000001', 1, 1)])
    expect(r.partes).toEqual([{ ncompInS: '00000001', nRenglS: 1, cantidad: 1 }])
    expect(r.faltaRem).toBe(1)
  })

  it('sin remitos no reparte nada y falta todo', () => {
    expect(repartirEntreRemitos(3, [])).toEqual({ partes: [], faltaRem: 3 })
  })

  it('no arrastra el error de coma flotante', () => {
    const r = repartirEntreRemitos(0.3, [s('00000001', 1, 0.1), s('00000002', 1, 0.2)])
    expect(r.faltaRem).toBe(0)
    expect(r.partes.map((p) => p.cantidad)).toEqual([0.1, 0.2])
  })

  it('ignora un saldo en cero', () => {
    const r = repartirEntreRemitos(1, [s('00000001', 1, 0), s('00000002', 1, 1)])
    expect(r.partes).toEqual([{ ncompInS: '00000002', nRenglS: 1, cantidad: 1 }])
  })
})
