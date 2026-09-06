import { describe, it, expect } from 'vitest'
import { cotejarConOc, describirCotejo, type LineaOc } from '@/lib/cotejoOc'
import { validarCotejoOc } from '@/lib/validaciones'

/** Una OC de dos renglones, con lo que le queda por facturar. */
const OC: LineaOc[] = [
  { nRenglOc: 1, codArticu: '103938', descripcion: 'ALMOHADA FIBRA SILIC.', pendiente: 40 },
  { nRenglOc: 2, codArticu: '100847', descripcion: 'BASE SOMMIER 190x140', pendiente: 13 },
]

describe('cotejarConOc', () => {
  it('sin problemas cuando la factura cobra lo que la OC tiene pendiente', () => {
    const r = cotejarConOc(
      [
        { orden: 1, codigo: '103938', cantidad: '40' },
        { orden: 2, codigo: '100847', cantidad: '13' },
      ],
      OC,
    )
    expect(r.problemas).toEqual([])
    expect(r.noFacturados).toEqual([])
  })

  it('facturar menos de lo pendiente no es un problema', () => {
    // Facturar parte de una OC es lo normal: se informa que quedan
    // renglones sin facturar, pero no bloquea.
    const r = cotejarConOc([{ orden: 1, codigo: '103938', cantidad: '10' }], OC)
    expect(r.problemas).toEqual([])
    expect(r.noFacturados.map((l) => l.codArticu)).toEqual(['100847'])
  })

  it('bloquea un articulo que no esta en la OC', () => {
    const r = cotejarConOc([{ orden: 1, codigo: '999999', cantidad: '1' }], OC)
    expect(r.problemas).toEqual([{ tipo: 'no-esta-en-la-oc', orden: 1, codigo: '999999' }])
  })

  it('bloquea una cantidad mayor a lo pendiente', () => {
    const r = cotejarConOc([{ orden: 1, codigo: '103938', cantidad: '41' }], OC)
    expect(r.problemas).toEqual([
      { tipo: 'excede-pendiente', orden: 1, codigo: '103938', factura: 41, pendiente: 40 },
    ])
  })

  it('bloquea un renglon sin codigo', () => {
    // Una linea que la factura cobra y no se puede identificar es
    // exactamente lo que no hay que dejar pasar a Tango.
    const r = cotejarConOc([{ orden: 1, codigo: null, cantidad: '5' }], OC)
    expect(r.problemas).toEqual([{ tipo: 'sin-codigo', orden: 1 }])
  })

  it('traduce el codigo del proveedor al nuestro', () => {
    // El proveedor imprime SU codigo; CPA15 guarda la equivalencia.
    const r = cotejarConOc(
      [{ orden: 1, codigo: 'ALM-065', cantidad: '40' }],
      OC,
      new Map([['ALM-065', '103938']]),
    )
    expect(r.problemas).toEqual([])
  })

  it('el codigo propio gana sobre un sinonimo que coincida', () => {
    // Si un proveedor usa como sinonimo un codigo que tambien es nuestro,
    // se toma el nuestro: es el que identifica el articulo sin ambiguedad.
    const r = cotejarConOc(
      [{ orden: 1, codigo: '103938', cantidad: '40' }],
      OC,
      new Map([['103938', '100847']]),
    )
    expect(r.problemas).toEqual([])
    // Se consumio el renglon 1, no el 2.
    expect(r.noFacturados.map((l) => l.codArticu)).toEqual(['100847'])
  })

  it('tolera el redondeo al comparar cantidades', () => {
    // Las cantidades de la factura salen de parsear texto de un PDF.
    const r = cotejarConOc([{ orden: 1, codigo: '103938', cantidad: '40,00001' }], OC)
    expect(r.problemas).toEqual([])
  })

  it('describirCotejo arma un mensaje legible con todos los problemas', () => {
    const r = cotejarConOc(
      [
        { orden: 1, codigo: '999999', cantidad: '1' },
        { orden: 2, codigo: '100847', cantidad: '20' },
      ],
      OC,
    )
    const texto = describirCotejo(r)
    expect(texto).toContain('999999')
    expect(texto).toContain('no está en la orden de compra')
    expect(texto).toContain('100847')
  })
})

describe('validarCotejoOc', () => {
  it('no aplica fuera de articulos', () => {
    expect(validarCotejoOc('conceptos', false, null).estado).toBe('ok')
    expect(validarCotejoOc('tarjeta', false, null).estado).toBe('ok')
  })

  it('bloquea una factura de articulos sin OC imputada', () => {
    // Toda factura de articulos se imputa a una OC: no tenerla no es un
    // caso valido sino un paso que falta.
    const r = validarCotejoOc('articulos', false, null)
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('Falta imputar')
  })

  it('ok con OC imputada y sin diferencias', () => {
    const cotejo = cotejarConOc([{ orden: 1, codigo: '103938', cantidad: '40' }], [OC[0]])
    expect(validarCotejoOc('articulos', true, cotejo).estado).toBe('ok')
  })

  it('avisa cuantos renglones de la OC quedan sin facturar', () => {
    const cotejo = cotejarConOc([{ orden: 1, codigo: '103938', cantidad: '10' }], OC)
    const r = validarCotejoOc('articulos', true, cotejo)
    expect(r.estado).toBe('ok')
    expect(r.mensaje).toContain('1 renglón(es) sin facturar')
  })

  it('bloquea con el detalle de la diferencia', () => {
    const cotejo = cotejarConOc([{ orden: 1, codigo: '103938', cantidad: '41' }], OC)
    const r = validarCotejoOc('articulos', true, cotejo)
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('41')
    expect(r.mensaje).toContain('40')
  })
})
