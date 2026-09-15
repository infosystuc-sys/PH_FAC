import { describe, it, expect } from 'vitest'
import { resolverDescuentoGlobal, describirDescuento } from '@/lib/descuentoGlobal'

// La factura real que motivó esto: ZOZZOLI S.A. (Maxiking), A-00059-00023095
// del 12/09/2026. P.Unit. de lista, subtotales ya netos, y un "Descuento
// General" al pie que ya está dentro de cada subtotal.
const ZOZZOLI = [
  { orden: 1, cantidad: '10.00', precioUnitario: '9,500.00', subtotal: '74,586.80' },
  { orden: 2, cantidad: '2.00', precioUnitario: '103,740.00', subtotal: '162,897.52' },
  { orden: 3, cantidad: '1.00', precioUnitario: '75,350.00', subtotal: '59,159.09' },
  { orden: 4, cantidad: '2.00', precioUnitario: '229,640.00', subtotal: '360,591.74' },
  { orden: 5, cantidad: '1.00', precioUnitario: '287,040.00', subtotal: '225,361.98' },
  { orden: 6, cantidad: '1.00', precioUnitario: '284,650.00', subtotal: '223,485.54' },
]

describe('resolverDescuentoGlobal', () => {
  it('ZOZZOLI: los subtotales ya son netos y el descuento del pie es informativo', () => {
    const r = resolverDescuentoGlobal(ZOZZOLI, '107,843.06', '1,106,082.67')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.caso).toBe('subtotales-netos')
    expect(r.sumaSubtotales).toBe(1106082.67)
    // El precio neto es subtotal ÷ cantidad, no el P.Unit. impreso.
    expect(r.renglones[0].precioNeto).toBe(7458.68)
    expect(r.renglones[0].precioImpreso).toBe(9500)
    expect(r.renglones[0].importeNeto).toBe(74586.8)
    // 21,49% efectivo: los dos descuentos encadenados (13,83% + 8,88%).
    expect(r.renglones[0].descuentoPorc).toBeCloseTo(21.4876, 3)
    // La suma de los importes netos ES el neto gravado.
    const suma = r.renglones.reduce((a, x) => a + x.importeNeto, 0)
    expect(suma).toBeCloseTo(1106082.67, 2)
  })

  it('subtotales brutos: el descuento del pie se prorratea y la suma cierra al centavo', () => {
    // Tres renglones a precio de lista, 10% de descuento global al pie.
    const renglones = [
      { orden: 1, cantidad: '3', precioUnitario: '1.000,00', subtotal: '3.000,00' },
      { orden: 2, cantidad: '1', precioUnitario: '333,33', subtotal: '333,33' },
      { orden: 3, cantidad: '2', precioUnitario: '50,00', subtotal: '100,00' },
    ]
    const r = resolverDescuentoGlobal(renglones, '343,33', '3.090,00')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.caso).toBe('subtotales-brutos')
    expect(r.renglones[0].importeNeto).toBe(2700)
    expect(r.renglones[0].precioNeto).toBe(900)
    expect(r.renglones[0].descuentoPorc).toBeCloseTo(10, 3)
    // El residuo de redondeo cae en el último renglón: la suma es EXACTA.
    const suma = r.renglones.reduce((a, x) => a + x.importeNeto, 0)
    expect(Math.round(suma * 100) / 100).toBe(3090)
  })

  it('sin descuento y con subtotales que suman el neto, es el caso simple', () => {
    const r = resolverDescuentoGlobal(
      [{ orden: 1, cantidad: '2', precioUnitario: '500,00', subtotal: '1.000,00' }],
      null,
      '1.000,00',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.caso).toBe('subtotales-netos')
    expect(r.renglones[0].precioNeto).toBe(500)
    expect(r.renglones[0].descuentoPorc).toBe(0)
  })

  it('no adivina: si no cierra de ninguna forma, lo dice con los numeros', () => {
    const r = resolverDescuentoGlobal(
      [{ orden: 1, cantidad: '2', precioUnitario: '500,00', subtotal: '1.000,00' }],
      '50,00',
      '900,00',
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('no-cierra')
    expect(describirDescuento(r)).toContain('1.000,00')
    expect(describirDescuento(r)).toContain('900,00')
  })

  it('un renglon sin precio o sin subtotal bloquea y pide reprocesar', () => {
    // Decision del usuario (2026-09-15): bloquear, no dejar cargar a mano.
    const r = resolverDescuentoGlobal(
      [
        { orden: 1, cantidad: '2', precioUnitario: '500,00', subtotal: '1.000,00' },
        { orden: 2, cantidad: '1', precioUnitario: null, subtotal: '200,00' },
        { orden: 3, cantidad: '1', precioUnitario: '200,00', subtotal: null },
      ],
      null,
      '1.400,00',
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('renglon-incompleto')
    if (r.motivo !== 'renglon-incompleto') return
    expect(r.ordenes).toEqual([2, 3])
    expect(describirDescuento(r)).toContain('Reprocesá')
  })

  it('sin neto gravado no verifica nada', () => {
    const r = resolverDescuentoGlobal(ZOZZOLI, null, '')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('sin-neto')
  })

  it('sin renglones no hay nada que resolver', () => {
    const r = resolverDescuentoGlobal([], null, '1.000,00')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('sin-renglones')
  })

  it('tolera un centavo por renglon de redondeo del proveedor', () => {
    const renglones = [
      { orden: 1, cantidad: '3', precioUnitario: '33,33', subtotal: '99,99' },
      { orden: 2, cantidad: '3', precioUnitario: '33,33', subtotal: '99,99' },
    ]
    // El proveedor imprimio 200,00 de neto (redondeo propio): cierra igual.
    expect(resolverDescuentoGlobal(renglones, null, '200,00').ok).toBe(true)
    // Pero 200,10 ya no es redondeo, es otra cosa.
    expect(resolverDescuentoGlobal(renglones, null, '200,10').ok).toBe(false)
  })
})
