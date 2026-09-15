import { describe, it, expect } from 'vitest'
import { resolverDescuentoGlobal, describirDescuento, netoCorregido } from '@/lib/descuentoGlobal'

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
  it('ZOZZOLI: el IVA revela que el "neto gravado" impreso es el de ANTES del descuento', () => {
    // Imprime "Importe Neto Gravado 1.106.082,67" (la suma de los subtotales)
    // y "Descuento General 107.843,06". Leido por el rotulo pareceria que
    // los subtotales ya son netos. Pero el IVA impreso es 209.630,32 = 21%
    // de 998.239,61 = 1.106.082,67 - 107.843,06: los subtotales son BRUTOS
    // respecto del descuento general, y la base real es 998.239,61. La
    // primera version de esta funcion decidia por el rotulo y se equivoco
    // justo con esta factura -- el usuario lo vio en el total imputado.
    const baseSegunIva = 209630.32 / 0.21
    const r = resolverDescuentoGlobal(ZOZZOLI, '107,843.06', '1,106,082.67', baseSegunIva)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.caso).toBe('subtotales-brutos')
    expect(r.evidencia).toBe('iva')
    expect(r.sumaSubtotales).toBe(1106082.67)
    expect(r.netoGravado).toBe(998239.61)
    // El precio neto lleva el descuento general prorrateado: 74.586,80 x
    // (998.239,61 / 1.106.082,67) = 67.314,59 por 10 unidades.
    expect(r.renglones[0].importeNeto).toBe(67314.59)
    expect(r.renglones[0].precioNeto).toBe(6731.459)
    expect(r.renglones[0].precioImpreso).toBe(9500)
    // La suma de los importes netos ES la base real, al centavo.
    const suma = r.renglones.reduce((a, x) => a + x.importeNeto, 0)
    expect(Math.round(suma * 100) / 100).toBe(998239.61)
    // Y el campo de la revision quedo con el numero impreso: hay que corregirlo.
    expect(r.netoDesactualizado).toBe(true)
    expect(netoCorregido(r)).toBe('998239,61')
    expect(describirDescuento(r)).toContain('corregilo a $ 998.239,61')
  })

  it('sin IVA que lo confirme, se cae al neto de la revision y no corrige nada', () => {
    // Sin evidencia independiente, lo unico que queda es el rotulo. Con el
    // neto impreso igual a la suma de los subtotales, lee "netos" -- y no
    // pisa el campo, porque no tiene con que confirmarlo.
    const r = resolverDescuentoGlobal(ZOZZOLI, '107,843.06', '1,106,082.67', null)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.caso).toBe('subtotales-netos')
    expect(r.evidencia).toBe('neto-revision')
    expect(r.netoDesactualizado).toBe(false)
    expect(netoCorregido(r)).toBeNull()
  })

  it('con IVA y el neto ya corregido, no marca nada para corregir', () => {
    const r = resolverDescuentoGlobal(ZOZZOLI, '107,843.06', '998,239.61', 209630.32 / 0.21)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.netoDesactualizado).toBe(false)
    expect(netoCorregido(r)).toBeNull()
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
