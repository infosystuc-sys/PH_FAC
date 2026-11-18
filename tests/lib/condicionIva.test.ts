import { describe, it, expect } from 'vitest'
import {
  condicionSinIva,
  clasificacionSiapDelExento,
  importesSegunCondicionIva,
} from '@/lib/condicionIva'

describe('condicionIva (N3 y N4, 2026-11-18)', () => {
  it('monotributista, exento y consumidor final no discriminan IVA; RI e INR si', () => {
    for (const c of ['RS', 'RSS', 'EX', 'CF', ' rs ']) expect(condicionSinIva(c)).toBe(true)
    for (const c of ['RI', 'INR', '', null, undefined]) expect(condicionSinIva(c)).toBe(false)
  })

  it('clasifica la fila exenta de CPA63 como Tango: C9, C7 o SIN', () => {
    expect(clasificacionSiapDelExento('RS')).toBe('C9')
    expect(clasificacionSiapDelExento('RSS')).toBe('C9')
    expect(clasificacionSiapDelExento('EX')).toBe('C7')
    expect(clasificacionSiapDelExento('CF')).toBe('C7')
    expect(clasificacionSiapDelExento('RI')).toBe('SIN')
    expect(clasificacionSiapDelExento(null)).toBe('SIN')
  })

  it('el monotributista sin IVA pasa todo a exento', () => {
    expect(importesSegunCondicionIva('RS', 10000, 0, false)).toEqual({ neto: 0, exento: 10000, todoExento: true })
    expect(importesSegunCondicionIva('EX', 100.1, 0.2, false)).toEqual({ neto: 0, exento: 100.3, todoExento: true })
  })

  it('con IVA discriminado, o si es RI, no reclasifica', () => {
    expect(importesSegunCondicionIva('RS', 10000, 0, true)).toEqual({ neto: 10000, exento: 0, todoExento: false })
    expect(importesSegunCondicionIva('RI', 10000, 500, false)).toEqual({ neto: 10000, exento: 500, todoExento: false })
  })

  it('sin neto no hay nada que reclasificar', () => {
    expect(importesSegunCondicionIva('RS', 0, 800, false)).toEqual({ neto: 0, exento: 800, todoExento: false })
  })
})
