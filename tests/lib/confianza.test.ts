import { describe, it, expect } from 'vitest'
import { nivelConfianza } from '@/lib/confianza'

describe('nivelConfianza', () => {
  it('valores bajos son rojo', () => {
    expect(nivelConfianza(0.1)).toEqual({ fondo: 'var(--danger-soft)', texto: 'var(--danger)' })
    expect(nivelConfianza(0.5)).toEqual({ fondo: 'var(--danger-soft)', texto: 'var(--danger)' })
    expect(nivelConfianza(0.79)).toEqual({ fondo: 'var(--danger-soft)', texto: 'var(--danger)' })
  })

  it('0.80 exacto ya es ambar (borde inferior estricto)', () => {
    expect(nivelConfianza(0.8)).toEqual({ fondo: 'var(--warning-soft)', texto: 'var(--warning)' })
  })

  it('valores medios son ambar', () => {
    expect(nivelConfianza(0.85)).toEqual({ fondo: 'var(--warning-soft)', texto: 'var(--warning)' })
  })

  it('0.93 exacto sigue siendo ambar (borde superior inclusive)', () => {
    expect(nivelConfianza(0.93)).toEqual({ fondo: 'var(--warning-soft)', texto: 'var(--warning)' })
  })

  it('0.9301 ya es gris (borde superior estricto apenas superado)', () => {
    expect(nivelConfianza(0.9301)).toEqual({ fondo: 'var(--bg-sunken)', texto: 'var(--text-muted)' })
  })

  it('valores altos son gris', () => {
    expect(nivelConfianza(0.95)).toEqual({ fondo: 'var(--bg-sunken)', texto: 'var(--text-muted)' })
    expect(nivelConfianza(0.999)).toEqual({ fondo: 'var(--bg-sunken)', texto: 'var(--text-muted)' })
  })
})
