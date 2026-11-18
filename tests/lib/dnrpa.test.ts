import { describe, it, expect } from 'vitest'
import {
  clasificarDnrpa,
  deduplicarDnrpa,
  esSinDnrpa,
  normalizarChasis,
  normalizarDnrpa,
  type FilaSerie,
} from '@/lib/dnrpa'

const CHASIS = '8CMML11A5TA195590'
const DNRPA = 'M-0000903599/2026'
const fila = (tabla: 'STA06' | 'STA07', comentario: string, codArticu = '107093PL'): FilaSerie => ({
  tabla,
  codArticu,
  comentario,
})

describe('normalizar', () => {
  it('el chasis va sin espacios y en mayusculas, como la serie en Tango', () => {
    expect(normalizarChasis(' 8cmml11a5ta 195590 ')).toBe(CHASIS)
    expect(normalizarDnrpa(' m-0000903599/2026 ')).toBe(DNRPA)
  })

  it('sin DNRPA es vacio o la propia serie (lo que deja el remito sin DNRPA)', () => {
    expect(esSinDnrpa('', CHASIS)).toBe(true)
    expect(esSinDnrpa(`${CHASIS}  `, CHASIS)).toBe(true)
    expect(esSinDnrpa('1234', CHASIS)).toBe(false)
  })
})

describe('clasificarDnrpa (2026-11-18)', () => {
  it('se carga en las filas sin DNRPA de STA06 y STA07', () => {
    const c = clasificarDnrpa(CHASIS, DNRPA, [fila('STA06', CHASIS), fila('STA07', CHASIS), fila('STA07', '')])
    expect(c).toEqual({ estado: 'cargar', codArticu: '107093PL', comentarioActual: null, filas: 3 })
  })

  it('si ya tiene ese DNRPA no hay nada que hacer; si lo tiene solo en una fila, completa las otras', () => {
    expect(clasificarDnrpa(CHASIS, DNRPA, [fila('STA06', DNRPA), fila('STA07', DNRPA)]).estado).toBe('igual')
    const c = clasificarDnrpa(CHASIS, DNRPA, [fila('STA06', DNRPA), fila('STA07', CHASIS)])
    expect(c.estado).toBe('cargar')
    expect(c.filas).toBe(1)
  })

  it('otro comentario no se toca: se muestra', () => {
    const c = clasificarDnrpa(CHASIS, DNRPA, [fila('STA06', 'M-0000000001/2026'), fila('STA07', CHASIS)])
    expect(c.estado).toBe('otro')
    expect(c.comentarioActual).toBe('M-0000000001/2026')
  })

  it('no encontrada, en mas de un articulo o con datos incompletos no se graba', () => {
    expect(clasificarDnrpa(CHASIS, DNRPA, []).estado).toBe('no-encontrada')
    expect(clasificarDnrpa(CHASIS, DNRPA, [fila('STA06', ''), fila('STA07', '', 'OTRO')]).estado).toBe('varios-articulos')
    expect(clasificarDnrpa('', DNRPA, []).estado).toBe('invalida')
    expect(clasificarDnrpa(CHASIS, 'X'.repeat(26), [fila('STA06', '')]).estado).toBe('invalida')
  })
})

describe('deduplicarDnrpa', () => {
  it('el mismo chasis con el mismo DNRPA cuenta una vez; con dos distintos queda marcado', () => {
    const r = deduplicarDnrpa([
      { chasis: 'A', dnrpa: '1' },
      { chasis: 'A', dnrpa: '1' },
      { chasis: 'B', dnrpa: '2' },
      { chasis: 'B', dnrpa: '3' },
    ])
    expect(r).toEqual([
      { fila: { chasis: 'A', dnrpa: '1' }, repetidaConOtro: false },
      { fila: { chasis: 'B', dnrpa: '2' }, repetidaConOtro: true },
    ])
  })
})
