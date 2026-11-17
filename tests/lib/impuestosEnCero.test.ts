import { describe, it, expect } from 'vitest'
import { descartarImpuestosEnCero } from '@/lib/impuestosEnCero'

const c = (valor: string | null) => ({ valor, confianza: 0.9 })
const vacio = () => ({ valor: null, confianza: 0 })

function camposBase(): Record<string, { valor: string | null; confianza: number }> {
  const out: Record<string, { valor: string | null; confianza: number }> = {}
  for (let i = 1; i <= 5; i++) { out[`porciva${i}`] = vacio(); out[`impiva${i}`] = vacio() }
  for (let i = 1; i <= 4; i++) { out[`percep${i}`] = vacio(); out[`imppercep${i}`] = vacio() }
  for (let i = 1; i <= 2; i++) { out[`varios${i}`] = vacio(); out[`impvarios${i}`] = vacio() }
  return out
}

describe('descartarImpuestosEnCero', () => {
  it('saca los impuestos varios en 0,00 (CrediCash)', () => {
    const campos = { ...camposBase(), varios1: c('REGIMEN DE RET.SIRTAC'), impvarios1: c('0.00'), varios2: c('IMPUESTO AL DEBITO'), impvarios2: c('0,00') }
    const r = descartarImpuestosEnCero(campos, vacio)
    expect(r.campos.varios1.valor).toBeNull()
    expect(r.campos.impvarios1.valor).toBeNull()
    expect(r.campos.varios2.valor).toBeNull()
    expect(r.descartados).toEqual(['REGIMEN DE RET.SIRTAC', 'IMPUESTO AL DEBITO'])
  })

  it('corre hacia arriba lo que queda, sin dejar huecos', () => {
    const campos = { ...camposBase(), porciva1: c('10,5'), impiva1: c('0.00'), porciva2: c('21'), impiva2: c('62,343.36') }
    const r = descartarImpuestosEnCero(campos, vacio)
    expect(r.campos.porciva1.valor).toBe('21')
    expect(r.campos.impiva1.valor).toBe('62,343.36')
    expect(r.campos.porciva2.valor).toBeNull()
  })

  it('un importe vacío no es cero: se deja', () => {
    const campos = { ...camposBase(), percep1: c('RET. IIBB'), imppercep1: c(null) }
    const r = descartarImpuestosEnCero(campos, vacio)
    expect(r.campos.percep1.valor).toBe('RET. IIBB')
    expect(r.descartados).toEqual([])
  })

  it('no toca los demás campos', () => {
    const campos = { ...camposBase(), neto: c('296873,15'), total: c('0') }
    expect(descartarImpuestosEnCero(campos, vacio).campos.total.valor).toBe('0')
  })
})
