import { describe, it, expect } from 'vitest'
import { normalizarSerie, problemaSeries } from '@/lib/series'

const s = (nSerie: string) => normalizarSerie({ nSerie, desc1: 'MOTOR', desc2: 'AZUL' })

describe('problemaSeries', () => {
  it('una serie por unidad, sin repetir, está completo', () => {
    expect(problemaSeries('100063', 2, [s('S1111'), s('S2222')])).toBeNull()
  })

  it('pide tantas series como unidades', () => {
    expect(problemaSeries('100063', 2, [s('S1111')])).toMatch(/1 de 2/)
    expect(problemaSeries('100063', 1, [s('S1111'), s('S2222')])).toMatch(/2 de 1/)
  })

  it('una fila sin número de serie no cuenta', () => {
    expect(problemaSeries('100063', 2, [s('S1111'), s('')])).toMatch(/1 de 2/)
  })

  it('no deja repetir una serie', () => {
    expect(problemaSeries('100063', 2, [s('S1111'), s('s1111 ')])).toMatch(/repetida/)
  })

  it('no admite cantidades fraccionarias', () => {
    expect(problemaSeries('100063', 1.5, [s('S1111')])).toMatch(/entera/)
  })

  it('respeta el largo de STA06.N_SERIE', () => {
    expect(problemaSeries('100063', 1, [s('X'.repeat(31))])).toMatch(/30 caracteres/)
  })
})

describe('normalizarSerie', () => {
  it('recorta y pasa la serie a mayúsculas', () => {
    expect(normalizarSerie({ nSerie: ' ab12 ', desc1: ' m ' })).toEqual({
      nSerie: 'AB12',
      desc1: 'm',
      desc2: '',
      comentario: '',
    })
  })
})
