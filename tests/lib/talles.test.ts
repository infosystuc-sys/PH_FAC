import { describe, it, expect } from 'vitest'
import {
  parsearDesgloseTalles,
  totalDesglosado,
  describirTalle,
  articulosPorTalle,
  prorratear,
  repartirNetoEntreHermanos,
} from '@/lib/talles'

// Las tres descripciones son las que la app leyó del PDF de TOPPER
// (comprobante 23843, factura A 00184804), copiadas de PHF_RENGLON_PDF.
const TOPPER_1 = 'SHORT CORE RUN H negro 26-001-ICO4-178220-P L : 6 M : 4 S : 2 XL : 4'
const TOPPER_3 =
  'PANTALÓN POTRERO PUÑO FUTBOL H negro 26-001-ICO4-178213-R L : 4 M : 4 S : 2 XL : 4'

// Los códigos de la OC 1674, tal como están en CPA36.
const OC_1674 = [
  '167686 001 S', '167686 001 M', '167686 001 L', '167686 001 XL',
  '168621 001 S', '168621 001 M', '168621 001 L', '168621 001 XL',
  '168672 001 S', '168672 001 M', '168672 001 L', '168672 001 XL',
]

describe('parsearDesgloseTalles', () => {
  it('lee el desglose de una descripción real de TOPPER', () => {
    expect(parsearDesgloseTalles(TOPPER_1)).toEqual([
      { talle: 'L', cantidad: 6 },
      { talle: 'M', cantidad: 4 },
      { talle: 'S', cantidad: 2 },
      { talle: 'XL', cantidad: 4 },
    ])
  })

  it('la suma de los talles da la cantidad impresa de la línea', () => {
    expect(totalDesglosado(parsearDesgloseTalles(TOPPER_1))).toBe(16)
    expect(totalDesglosado(parsearDesgloseTalles(TOPPER_3))).toBe(14)
  })

  it('lee talles numéricos de calzado, con y sin espacio en los dos puntos', () => {
    expect(parsearDesgloseTalles('POLARIS KIDS 270: 4  310: 6  320: 6')).toEqual([
      { talle: '270', cantidad: 4 },
      { talle: '310', cantidad: 6 },
      { talle: '320', cantidad: 6 },
    ])
    expect(parsearDesgloseTalles('ZAPATILLA 38 : 2 39 : 3 40 : 1')).toEqual([
      { talle: '38', cantidad: 2 },
      { talle: '39', cantidad: 3 },
      { talle: '40', cantidad: 1 },
    ])
  })

  it('no ve desglose donde no lo hay', () => {
    expect(parsearDesgloseTalles('HELADERA MIDEA 340LT INVER')).toEqual([])
    expect(parsearDesgloseTalles(null)).toEqual([])
    expect(parsearDesgloseTalles('')).toEqual([])
  })

  it('no confunde un importe ni un código con un desglose', () => {
    // Un solo par no alcanza, y los decimales no son cantidades de talle.
    expect(parsearDesgloseTalles('SERVICIO MENSUAL Lote : 3')).toEqual([])
    expect(parsearDesgloseTalles('ARTICULO precio: 20.799,47 unitario: 1.234,50')).toEqual([])
  })

  it('no confunde con un desglose las palabras con dos puntos de una descripción', () => {
    // La descripcion real de DASS (comprobante 24303). Tiene "Despacho:26042..."
    // y "Fec:13/03/2026": dos pares "etiqueta:numero" que NO son un desglose.
    // Sin exigir que los pares vayan pegados, la app leia dos talles y
    // aprendia la regla equivocada para el proveedor (2026-09-30).
    const dass =
      'F23L00392-CAP UNISEX FILA F-BOX MARINO Despacho:26042IC05005688F ' +
      'Fec:13/03/2026 Ad.:B.S.A.S Orig:1058 U 35'
    expect(parsearDesgloseTalles(dass)).toEqual([])
  })

  it('un desglose real sigue leyéndose aunque la descripción traiga otros dos puntos', () => {
    const mezcla = 'CAP UNISEX Despacho:26042IC Fec:13/03/2026 L : 6 M : 4 S : 2 XL : 4'
    expect(parsearDesgloseTalles(mezcla)).toEqual([
      { talle: 'L', cantidad: 6 },
      { talle: 'M', cantidad: 4 },
      { talle: 'S', cantidad: 2 },
      { talle: 'XL', cantidad: 4 },
    ])
  })

  it('descarta el desglose entero si un talle viene repetido', () => {
    // No hay forma de saber cuál de las dos cantidades vale.
    expect(parsearDesgloseTalles('REMERA L : 4 M : 6 L : 2')).toEqual([])
  })
})

describe('describirTalle', () => {
  it('saca el desglose y deja el talle de este renglón', () => {
    expect(describirTalle(TOPPER_1, 'L')).toBe(
      'SHORT CORE RUN H negro 26-001-ICO4-178220-P - L',
    )
  })
})

describe('articulosPorTalle', () => {
  it('lleva cada talle al artículo de la OC, con el color en el medio', () => {
    const m = articulosPorTalle('167686', parsearDesgloseTalles(TOPPER_1), OC_1674)
    expect(m).not.toBeNull()
    expect(m!.get('S')).toBe('167686 001 S')
    expect(m!.get('M')).toBe('167686 001 M')
    expect(m!.get('L')).toBe('167686 001 L')
    expect(m!.get('XL')).toBe('167686 001 XL')
  })

  it('L no se queda con el renglón de XL', () => {
    // Es el caso que rompe la forma obvia de resolverlo: "167686 001 XL"
    // también termina en "L". El talle más largo elige primero.
    const m = articulosPorTalle('167686', [
      { talle: 'L', cantidad: 6 },
      { talle: 'XL', cantidad: 4 },
    ], OC_1674)
    expect(m!.get('L')).toBe('167686 001 L')
    expect(m!.get('XL')).toBe('167686 001 XL')
  })

  it('no se confunde entre artículos distintos que comparten talles', () => {
    const m = articulosPorTalle('168672', parsearDesgloseTalles(TOPPER_3), OC_1674)
    expect([...m!.values()].every((c) => c.startsWith('168672'))).toBe(true)
  })

  it('ignora el artículo padre: el código pelado no es de ningún talle', () => {
    const m = articulosPorTalle('167686', [
      { talle: 'S', cantidad: 2 },
      { talle: 'M', cantidad: 4 },
    ], ['167686', '167686 001 S', '167686 001 M'])
    expect(m!.get('S')).toBe('167686 001 S')
    expect(m!.get('M')).toBe('167686 001 M')
  })

  it('aguanta el relleno de espacios de otros proveedores', () => {
    // Medidos en la base: "80020  001 L" (dos espacios), "10801  1113M" (sin
    // espacio antes del talle).
    const m = articulosPorTalle('10801', [
      { talle: 'M', cantidad: 3 },
      { talle: 'XL', cantidad: 2 },
    ], ['10801  1113M', '10801  1113XL'])
    expect(m!.get('M')).toBe('10801  1113M')
    expect(m!.get('XL')).toBe('10801  1113XL')
  })

  it('devuelve null si un talle no tiene artículo: no resuelve a medias', () => {
    const m = articulosPorTalle('167686', [
      { talle: 'S', cantidad: 2 },
      { talle: 'XXL', cantidad: 1 },
    ], OC_1674)
    expect(m).toBeNull()
  })

  it('devuelve null si el código impreso no está en los candidatos', () => {
    expect(articulosPorTalle('999999', parsearDesgloseTalles(TOPPER_1), OC_1674)).toBeNull()
    expect(articulosPorTalle('', parsearDesgloseTalles(TOPPER_1), OC_1674)).toBeNull()
  })
})

describe('prorratear', () => {
  it('reparte el subtotal impreso y la suma da exacto', () => {
    // El renglón 1 de TOPPER: 309.496,11 entre L:6 M:4 S:2 XL:4 = 16.
    const partes = prorratear(309496.11, [6, 4, 2, 4])
    expect(partes.reduce((a, b) => a + b, 0)).toBeCloseTo(309496.11, 2)
    // Cada parte es la proporción de su cantidad.
    expect(partes[0]).toBeCloseTo(116061.04, 2)
    expect(partes[2]).toBeCloseTo(38687.01, 2)
  })

  it('el resto de redondeo no se pierde ni se duplica', () => {
    // 100 entre 3 no da un reparto exacto en centavos.
    const partes = prorratear(100, [1, 1, 1])
    expect(partes.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 2)
  })

  it('el precio unitario neto que sale del prorrateo es el de la OC', () => {
    // Es la verificación que importa: 309.496,11 / 16 = 19.343,51, que es
    // exactamente el precio del renglón de la OC 1674.
    const partes = prorratear(309496.11, [6, 4, 2, 4])
    expect(partes[0] / 6).toBeCloseTo(19343.51, 2)
    expect(partes[1] / 4).toBeCloseTo(19343.51, 2)
  })

  it('no divide por cero si no hay cantidades', () => {
    expect(prorratear(1000, [0, 0])).toEqual([0, 0])
  })
})

describe('repartirNetoEntreHermanos', () => {
  const neto = new Map([[1, { importeNeto: 309496.11, precioNeto: 19343.5069 }]])

  it('reparte el importe de la línea entre los talles y la suma da exacta', () => {
    const r = repartirNetoEntreHermanos(
      [
        { id: 10, pdfOrden: 1, cantidad: 6 },
        { id: 11, pdfOrden: 1, cantidad: 4 },
        { id: 12, pdfOrden: 1, cantidad: 2 },
        { id: 13, pdfOrden: 1, cantidad: 4 },
      ],
      neto,
    )
    const suma = [10, 11, 12, 13].reduce((a, id) => a + r.get(id)!.importeNeto, 0)
    expect(suma).toBeCloseTo(309496.11, 2)
  })

  it('todos los talles quedan al mismo precio unitario, el de la OC', () => {
    const r = repartirNetoEntreHermanos(
      [
        { id: 10, pdfOrden: 1, cantidad: 6 },
        { id: 11, pdfOrden: 1, cantidad: 4 },
      ],
      neto,
    )
    expect(r.get(10)!.precioNeto).toBe(19343.5069)
    expect(r.get(11)!.precioNeto).toBe(19343.5069)
  })

  it('una línea que dio un solo renglón se graba tal cual', () => {
    const r = repartirNetoEntreHermanos([{ id: 10, pdfOrden: 1, cantidad: 16 }], neto)
    expect(r.get(10)).toEqual({ importeNeto: 309496.11, precioNeto: 19343.5069 })
  })

  it('un renglón sin línea del PDF no recibe importe', () => {
    const r = repartirNetoEntreHermanos([{ id: 10, pdfOrden: null, cantidad: 3 }], neto)
    expect(r.get(10)).toBeUndefined()
  })
})
