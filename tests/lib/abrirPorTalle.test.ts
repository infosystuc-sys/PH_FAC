import { describe, it, expect } from 'vitest'
import { abrirPorTalle, type LineaPdfResuelta } from '@/lib/matchOc'

// Los códigos de la OC 1674 de TOPPER, tal como están en CPA36.
const OC_1674 = [
  '167686 001 S', '167686 001 M', '167686 001 L', '167686 001 XL',
  '168621 001 S', '168621 001 M', '168621 001 L', '168621 001 XL',
  '168672 001 S', '168672 001 M', '168672 001 L', '168672 001 XL',
]

function linea(p: Partial<LineaPdfResuelta>): LineaPdfResuelta {
  return {
    orden: 1,
    codigo: '167686',
    descripcion: 'SHORT CORE RUN H negro 26-001-ICO4-178220-P L : 6 M : 4 S : 2 XL : 4',
    cantidad: '16',
    porDescripcion: false,
    sinOc: false,
    ...p,
  }
}

describe('abrirPorTalle', () => {
  it('abre la línea impresa en un renglón por talle, con el código de Tango', () => {
    const r = abrirPorTalle([linea({})], OC_1674)
    expect(r).toHaveLength(4)
    expect(r.map((x) => x.codigo)).toEqual([
      '167686 001 L', '167686 001 M', '167686 001 S', '167686 001 XL',
    ])
    expect(r.map((x) => x.cantidad)).toEqual(['6', '4', '2', '4'])
  })

  it('todos los talles conservan la línea del PDF de la que salieron', () => {
    // Es lo que después permite repartir entre ellos el subtotal impreso.
    const r = abrirPorTalle([linea({ orden: 3 })], OC_1674)
    expect(r.every((x) => x.orden === 3)).toBe(true)
    expect(r[0].cantidadesHermanas).toEqual([6, 4, 2, 4])
    expect(r.map((x) => x.indiceTalle)).toEqual([0, 1, 2, 3])
  })

  it('cada renglón queda distinguible por su descripción', () => {
    const r = abrirPorTalle([linea({})], OC_1674)
    expect(r[0].descripcion).toBe('SHORT CORE RUN H negro 26-001-ICO4-178220-P - L')
    expect(new Set(r.map((x) => x.descripcion)).size).toBe(4)
  })

  it('una línea sin desglose pasa tal cual', () => {
    const r = abrirPorTalle(
      [linea({ codigo: '106037', descripcion: 'HELADERA MIDEA 340LT INVER', cantidad: '2' })],
      ['106037'],
    )
    expect(r).toHaveLength(1)
    expect(r[0].talle).toBeNull()
    expect(r[0].codigo).toBe('106037')
  })

  it('no abre si los talles no suman la cantidad impresa', () => {
    // La cantidad impresa manda: si no cuadra, el desglose se leyó mal y
    // abrirlo grabaría cantidades inventadas.
    const r = abrirPorTalle([linea({ cantidad: '20' })], OC_1674)
    expect(r).toHaveLength(1)
    expect(r[0].talle).toBeNull()
  })

  it('no abre a medias si un talle no tiene artículo en la orden', () => {
    const soloDos = ['167686 001 S', '167686 001 M']
    const r = abrirPorTalle([linea({})], soloDos)
    expect(r).toHaveLength(1)
    expect(r[0].codigo).toBe('167686')
  })

  it('no toca los cargos del proveedor', () => {
    const r = abrirPorTalle(
      [linea({ sinOc: true, descripcion: 'GESTION DE COMPRA L : 2 M : 3' })],
      OC_1674,
    )
    expect(r).toHaveLength(1)
    expect(r[0].talle).toBeNull()
  })

  it('abre las tres líneas de la factura de TOPPER en los 12 renglones de la OC', () => {
    const r = abrirPorTalle(
      [
        linea({ orden: 1, codigo: '167686' }),
        linea({
          orden: 2,
          codigo: '168621',
          descripcion: 'SHORT CORE RUN H azul oceana 26-001-ICO4-178220-P L : 6 M : 4 S : 2 XL : 4',
        }),
        linea({
          orden: 3,
          codigo: '168672',
          descripcion: 'PANTALÓN POTRERO PUÑO FUTBOL H negro 26-001 L : 4 M : 4 S : 2 XL : 4',
          cantidad: '14',
        }),
      ],
      OC_1674,
    )
    expect(r).toHaveLength(12)
    expect(new Set(r.map((x) => x.codigo)).size).toBe(12)
  })
})
