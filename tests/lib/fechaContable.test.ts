import { describe, it, expect } from 'vitest'
import {
  fechaContableDe,
  primerDiaDelMesSiguiente,
  seCorrioPorCierre,
} from '@/lib/fechaContable'

/** dd/mm/yyyy a Date local, como parsearFechaArg. */
const d = (dd: number, mm: number, yyyy: number) => new Date(yyyy, mm - 1, dd)
const iso = (x: Date) =>
  `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`

describe('fechaContableDe', () => {
  // El valor real de CPA10.CIERRE_CON al implementar esto.
  const CIERRE = d(31, 8, 2026)

  it('deja la fecha de emision cuando el cierre es anterior', () => {
    // El caso normal: factura de septiembre, cierre al 31 de agosto.
    expect(iso(fechaContableDe(d(3, 9, 2026), CIERRE))).toBe('03/09/2026')
  })

  it('corre al primer dia del mes siguiente al cierre si la factura cae en periodo cerrado', () => {
    expect(iso(fechaContableDe(d(15, 8, 2026), CIERRE))).toBe('01/09/2026')
    expect(iso(fechaContableDe(d(2, 7, 2026), CIERRE))).toBe('01/09/2026')
  })

  it('el dia del cierre cuenta como cerrado', () => {
    // CIERRE_CON se lee como "cerrado hasta aca inclusive": si no, una
    // factura del 31/08 con cierre al 31/08 se imputaria en un mes cerrado.
    expect(iso(fechaContableDe(d(31, 8, 2026), CIERRE))).toBe('01/09/2026')
  })

  it('sin cierre cargado no toca nada', () => {
    expect(iso(fechaContableDe(d(15, 8, 2026), null))).toBe('15/08/2026')
  })

  it('ignora la hora del cierre, que es datetime y la trae', () => {
    // CIERRE_CON es datetime; el "vacio" de Tango es 1800-01-01T03:53:48.
    const conHora = new Date(2026, 7, 31, 3, 53, 48)
    expect(iso(fechaContableDe(d(31, 8, 2026), conHora))).toBe('01/09/2026')
    expect(iso(fechaContableDe(d(1, 9, 2026), conHora))).toBe('01/09/2026')
  })

  it('un cierre en diciembre rueda a enero del año siguiente', () => {
    expect(iso(fechaContableDe(d(10, 12, 2026), d(31, 12, 2026)))).toBe('01/01/2027')
  })

  it('el cierre a fin de febrero de un año bisiesto', () => {
    expect(iso(fechaContableDe(d(15, 2, 2028), d(29, 2, 2028)))).toBe('01/03/2028')
  })
})

describe('primerDiaDelMesSiguiente', () => {
  it('funciona en cualquier mes, incluido diciembre', () => {
    expect(iso(primerDiaDelMesSiguiente(d(31, 8, 2026)))).toBe('01/09/2026')
    expect(iso(primerDiaDelMesSiguiente(d(1, 1, 2026)))).toBe('01/02/2026')
    expect(iso(primerDiaDelMesSiguiente(d(31, 12, 2026)))).toBe('01/01/2027')
  })
})

describe('seCorrioPorCierre', () => {
  it('dice si la fecha contable termino siendo otra', () => {
    expect(seCorrioPorCierre(d(3, 9, 2026), d(31, 8, 2026))).toBe(false)
    expect(seCorrioPorCierre(d(15, 8, 2026), d(31, 8, 2026))).toBe(true)
    expect(seCorrioPorCierre(d(15, 8, 2026), null)).toBe(false)
  })
})
