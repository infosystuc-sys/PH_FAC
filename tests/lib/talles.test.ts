import { describe, it, expect } from 'vitest'
import {
  parsearDesgloseTalles,
  totalDesglosado,
  describirTalle,
  articulosPorTalle,
  prorratear,
  repartirNetoEntreHermanos,
  equivalenciasPorTalle,
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

  it('empareja aunque la factura escriba el talle en décimos', () => {
    // TOPPER factura A 00536440 (2026-09-30): imprime "027633 001" con los
    // talles 310..370, y en Tango la OC 1681 tiene "27633  001 31" .. "37".
    // Dos diferencias de notación a la vez: el cero de adelante del código
    // --que resuelve normalizarCodigo-- y el talle en décimos.
    const oc1681 = [
      '27633  001 31', '27633  001 32', '27633  001 33', '27633  001 34',
      '27633  001 35', '27633  001 36', '27633  001 37',
    ]
    const talles = parsearDesgloseTalles(
      'TANGO KIDS MARINO NAVAL/AZUL OCEANA 310: 2 320: 2 330: 4 340: 4 350: 4 360: 4 370: 4',
    )
    expect(totalDesglosado(talles)).toBe(24)

    const m = articulosPorTalle('027633 001', talles, oc1681)
    expect(m).not.toBeNull()
    expect(m!.get('310')).toBe('27633  001 31')
    expect(m!.get('370')).toBe('27633  001 37')
    expect(new Set(m!.values()).size).toBe(7)
  })

  it('el factor tiene que explicar el renglón entero, no algunos talles', () => {
    // Si un solo talle no encaja con el mismo factor, no se abre nada: una
    // correspondencia a medias manda mercadería al artículo equivocado.
    const m = articulosPorTalle(
      '27633 001',
      [
        { talle: '310', cantidad: 2 },
        { talle: '999', cantidad: 2 },
      ],
      ['27633  001 31', '27633  001 32'],
    )
    expect(m).toBeNull()
  })

  it('no mezcla escalas: dos talles no pueden caer en el mismo artículo', () => {
    const m = articulosPorTalle(
      '27633 001',
      [
        { talle: '310', cantidad: 2 },
        { talle: '3100', cantidad: 2 },
      ],
      ['27633  001 31', '27633  001 32'],
    )
    expect(m).toBeNull()
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

describe('equivalenciasPorTalle', () => {
  // TOPPER A 00535956 (comprobante 24306, 2026-10-05). Las variantes salen
  // del MAESTRO, no de una orden: el caso existe justamente porque ninguna
  // orden del proveedor tiene estos articulos pendientes.
  const SAN_CIRO = [
    '26459  001 35', '26459  001 36', '26459  001 37', '26459  001 38',
    '26459  001 39', '26459  001 40', '26459  001 41', '26459  001 42',
    '26459  001 43', '26459  001 44',
  ]
  const KAISER = [
    '27409  001 35', '27409  001 36', '27409  001 37', '27409  001 38',
    '27409  001 39', '27409  001 40', '27409  001 41', '27409  001 42',
    '27409  001 43', '27409  001 44', '27409  001 45',
  ]
  const SEGOVIA = ['27620  001 25', '27620  001 26', '27620  001 27']

  it('lleva cada talle impreso a su artículo del maestro', () => {
    const r = equivalenciasPorTalle(
      '027409 001',
      'KAISER 4 FG GRIS LUNAR/GRIS STEEL/CORAL 360: 2 370: 2 400: 4',
      8,
      KAISER,
      true,
    )
    expect(r).toEqual([
      { codigoFactura: '027409 001 360', talle: '360', cantidad: 2, codArticu: '27409  001 36' },
      { codigoFactura: '027409 001 370', talle: '370', cantidad: 2, codArticu: '27409  001 37' },
      { codigoFactura: '027409 001 400', talle: '400', cantidad: 4, codArticu: '27409  001 40' },
    ])
  })

  it('resuelve un renglón de UN SOLO talle cuando el proveedor desglosa', () => {
    // "350: 2" es un par suelto: solo se toma por desglose si el proveedor
    // ya está marcado como 'desglose-talle'.
    const r = equivalenciasPorTalle(
      '026459 001',
      'SAN CIRO V TF BLANCO / NEGRO 350: 2',
      2,
      SAN_CIRO,
      true,
    )
    expect(r).toHaveLength(1)
    expect(r[0].codArticu).toBe('26459  001 35')
    expect(r[0].codigoFactura).toBe('026459 001 350')
  })

  it('con un solo talle y sin el antecedente del proveedor, no muestra nada', () => {
    const r = equivalenciasPorTalle(
      '026459 001',
      'SAN CIRO V TF BLANCO / NEGRO 350: 2',
      2,
      SAN_CIRO,
      false,
    )
    expect(r).toEqual([])
  })

  it('con un solo talle exige además que la cantidad impresa coincida', () => {
    // Sin cantidad no hay con qué confirmar que ese par es un talle.
    expect(
      equivalenciasPorTalle('026459 001', 'SAN CIRO 350: 2', 0, SAN_CIRO, true),
    ).toEqual([])
    expect(
      equivalenciasPorTalle('026459 001', 'SAN CIRO 350: 2', 9, SAN_CIRO, true),
    ).toEqual([])
  })

  it('no muestra nada si los talles no suman la cantidad impresa', () => {
    expect(
      equivalenciasPorTalle('027620 001', 'SEGOVIA 250: 2 260: 2 270: 2', 99, SEGOVIA, true),
    ).toEqual([])
  })

  it('no muestra una equivalencia a medias: o están todos los talles o ninguno', () => {
    // El 450 no existe en el maestro. Mostrar solo dos de tres le haria
    // creer al operador que el tercero no se factura.
    const r = equivalenciasPorTalle(
      '027620 001',
      'SEGOVIA 250: 2 260: 2 450: 2',
      6,
      SEGOVIA,
      true,
    )
    expect(r).toEqual([])
  })

  it('sin código impreso o sin candidatos no devuelve nada', () => {
    expect(equivalenciasPorTalle(null, 'SEGOVIA 250: 2 260: 2', 4, SEGOVIA, true)).toEqual([])
    expect(equivalenciasPorTalle('027620 001', 'SEGOVIA 250: 2 260: 2', 4, [], true)).toEqual([])
  })

  it('un renglón sin desglose no genera equivalencias', () => {
    expect(
      equivalenciasPorTalle('106037', 'HELADERA MIDEA 340LT INVER', 2, ['106037 01'], true),
    ).toEqual([])
  })
})

describe('parsearDesgloseTalles con minimoPares', () => {
  it('el default sigue exigiendo dos pares', () => {
    expect(parsearDesgloseTalles('SAN CIRO 350: 2')).toEqual([])
  })

  it('bajándolo a uno lee el par suelto', () => {
    expect(parsearDesgloseTalles('SAN CIRO 350: 2', 1)).toEqual([{ talle: '350', cantidad: 2 }])
  })

  it('aun con mínimo uno, una descripción sin pares no inventa talles', () => {
    expect(parsearDesgloseTalles('HELADERA MIDEA 340LT INVER', 1)).toEqual([])
  })
})

describe('talles con decimales (TOPPER, 2026-10-13)', () => {
  // Tango guarda los talles de calzado con decimales y la factura los
  // imprime en décimos. Normalizados, "41.5" queda "415" --idéntico al
  // impreso-- mientras "38" queda "38" contra "380": no hay UN factor que
  // explique los dos si se mira la clave normalizada. Hay que mirar el
  // sufijo crudo, con su punto.
  const OC_1696 = [
    '52701  001 36.5',
    '52701  001 38',
    '52701  001 39',
    '52701  001 40',
    '52701  001 41.5',
    '52701  001 43',
    '52701  001 44',
  ]

  it('empareja los siete talles de la factura real', () => {
    const talles = parsearDesgloseTalles(
      'WAVE Negro Monocromo 26 001 IC04 189424 A 365: 2 380: 4 390: 6 400: 12 415: 12 430: 8 440: 2',
    )
    expect(totalDesglosado(talles)).toBe(46)

    const m = articulosPorTalle('052701 001', talles, OC_1696)
    expect(m).not.toBeNull()
    // Los dos con decimales y dos enteros, que son los que no cerraban con
    // un unico factor mirando la clave normalizada.
    expect(m!.get('365')).toBe('52701  001 36.5')
    expect(m!.get('415')).toBe('52701  001 41.5')
    expect(m!.get('380')).toBe('52701  001 38')
    expect(m!.get('440')).toBe('52701  001 44')
    expect(new Set(m!.values()).size).toBe(7)
  })

  it('el renglón que mezcla enteros y decimales resuelve entero', () => {
    // Es el que se quedaba sin resolver: 415 -> 41.5 fallaba porque la
    // clave normalizada del artículo decia "415".
    const talles = parsearDesgloseTalles('WAVE 380: 4  390: 6  400: 12  415: 12  430: 8')
    const m = articulosPorTalle('052701 001', talles, OC_1696)
    expect(m).not.toBeNull()
    expect(m!.size).toBe(5)
    expect(m!.get('415')).toBe('52701  001 41.5')
  })

  it('el código impreso con cero adelante empareja con el de Tango sin él', () => {
    const m = articulosPorTalle('052701 001', [{ talle: '365', cantidad: 2 }], OC_1696)
    expect(m!.get('365')).toBe('52701  001 36.5')
  })

  it('sigue sin resolver a medias si un talle no existe', () => {
    const m = articulosPorTalle(
      '052701 001',
      [
        { talle: '380', cantidad: 4 },
        { talle: '999', cantidad: 1 },
      ],
      OC_1696,
    )
    expect(m).toBeNull()
  })
})
