import { describe, it, expect } from 'vitest'
import { clavesDeImpuestosVacios, PARES_IMPUESTO } from '@/lib/campos'

describe('clavesDeImpuestosVacios', () => {
  it('esconde los casilleros enteramente vacíos', () => {
    const r = clavesDeImpuestosVacios({ porciva1: '21', impiva1: '1.000,00' })
    // El casillero 1 tiene datos: queda.
    expect(r.has('porciva1')).toBe(false)
    expect(r.has('impiva1')).toBe(false)
    // Los demás están vacíos.
    expect(r.has('porciva2')).toBe(true)
    expect(r.has('impiva2')).toBe(true)
    expect(r.has('percep1')).toBe(true)
    expect(r.has('imppercep1')).toBe(true)
  })

  it('un casillero a medias NO se esconde: es justo el que hay que ver', () => {
    // Un importe sin su alícuota no se puede imputar. Taparlo seria
    // esconder el problema.
    const soloImporte = clavesDeImpuestosVacios({ impiva2: '500,00' })
    expect(soloImporte.has('porciva2')).toBe(false)
    expect(soloImporte.has('impiva2')).toBe(false)

    const soloRotulo = clavesDeImpuestosVacios({ percep1: 'Percepción IIBB' })
    expect(soloRotulo.has('percep1')).toBe(false)
    expect(soloRotulo.has('imppercep1')).toBe(false)
  })

  it('los espacios en blanco cuentan como vacío', () => {
    const r = clavesDeImpuestosVacios({ porciva3: '   ', impiva3: '' })
    expect(r.has('porciva3')).toBe(true)
    expect(r.has('impiva3')).toBe(true)
  })

  it('sin ningún valor esconde los once casilleros', () => {
    const r = clavesDeImpuestosVacios({})
    expect(r.size).toBe(PARES_IMPUESTO.length * 2)
  })

  it('no toca los campos que no son casilleros de impuesto', () => {
    const r = clavesDeImpuestosVacios({})
    for (const c of ['neto', 'exento', 'total', 'imputado', 'descuentogeneral']) {
      expect(r.has(c)).toBe(false)
    }
  })
})
