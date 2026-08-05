import { describe, it, expect } from 'vitest'
import { nivelConfianza } from '@/lib/confianza'

describe('nivelConfianza', () => {
  it('valores bajos son rojo', () => {
    expect(nivelConfianza(0.1)).toEqual({ fondo: '#fae7e3', texto: '#a03526' })
    expect(nivelConfianza(0.5)).toEqual({ fondo: '#fae7e3', texto: '#a03526' })
    expect(nivelConfianza(0.79)).toEqual({ fondo: '#fae7e3', texto: '#a03526' })
  })

  it('0.80 exacto ya es ambar (borde inferior estricto)', () => {
    expect(nivelConfianza(0.8)).toEqual({ fondo: '#fbf0dc', texto: '#8a5a00' })
  })

  it('valores medios son ambar', () => {
    expect(nivelConfianza(0.85)).toEqual({ fondo: '#fbf0dc', texto: '#8a5a00' })
  })

  it('0.93 exacto sigue siendo ambar (borde superior inclusive)', () => {
    expect(nivelConfianza(0.93)).toEqual({ fondo: '#fbf0dc', texto: '#8a5a00' })
  })

  it('0.9301 ya es gris (borde superior estricto apenas superado)', () => {
    expect(nivelConfianza(0.9301)).toEqual({ fondo: '#eef0f2', texto: '#6b7078' })
  })

  it('valores altos son gris', () => {
    expect(nivelConfianza(0.95)).toEqual({ fondo: '#eef0f2', texto: '#6b7078' })
    expect(nivelConfianza(0.999)).toEqual({ fondo: '#eef0f2', texto: '#6b7078' })
  })
})
