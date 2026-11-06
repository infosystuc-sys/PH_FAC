import { describe, it, expect } from 'vitest'
import { cotejarConOc, describirCotejo, normalizarCodigo, type LineaOc } from '@/lib/cotejoOc'
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
      // El mapa viene con la clave ya normalizada (asi lo arma
      // articulosPorSinonimo): sin puntuacion.
      new Map([['ALM065', '103938']]),
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

describe('normalizarCodigo', () => {
  it('ignora mayusculas y los espacios de las puntas', () => {
    expect(normalizarCodigo('  abc1 ')).toBe('ABC1')
  })

  it('ignora los ceros de ADELANTE', () => {
    // TOPPER, 2026-09-30: la factura imprime "027633 001" y en Tango el
    // articulo es "27633  001 31". Medido antes de aplicarlo: 0 colisiones
    // en 9.587 codigos de STA11 y 0 en 377 sinonimos de CPA15.
    expect(normalizarCodigo('027633 001')).toBe('27633001')
    expect(normalizarCodigo('27633  001 31')).toBe('2763300131')
    expect(normalizarCodigo('0000123')).toBe('123')
  })

  it('un codigo de puros ceros no queda vacio', () => {
    // Se conserva siempre al menos un caracter: una clave vacia matchearia
    // contra cualquier cosa que tampoco tenga clave.
    expect(normalizarCodigo('000')).toBe('0')
    expect(normalizarCodigo('0')).toBe('0')
  })

  it('ignora tambien los espacios de ADENTRO', () => {
    // C C AGRO, 2026-09-16: la factura imprime "RO1274DW MT/1-12" y el
    // sinonimo en CPA15 es "RO1274DWMT/1-12". No es un caso aislado: 50 de
    // los 174 sinonimos de CPA15 y 1.642 codigos de STA11 tienen espacios
    // adentro (TOPPER: "21870  001 40"), y el modelo los transcribe como
    // puede. Medido ese dia: quitar los espacios no colisiona ningun par.
    expect(normalizarCodigo('RO1274DW MT 1 12')).toBe('RO1274DWMT112')
    expect(normalizarCodigo('21870  001 40')).toBe(normalizarCodigo('21870 001 40'))
  })

  it('con eso, cotejarConOc empareja un codigo impreso con espacio contra la OC', () => {
    const oc: LineaOc[] = [
      { nRenglOc: 1, codArticu: '106543', descripcion: 'LAVARROPAS CANDY', pendiente: 24 },
    ]
    const sinonimos = new Map([[normalizarCodigo('RO1274DWMT/1-12'), '106543']])
    const r = cotejarConOc([{ orden: 1, codigo: 'RO1274DW MT/1-12', cantidad: '24' }], oc, sinonimos)
    expect(r.problemas).toEqual([])
  })
})

describe('normalizarCodigo ignora la puntuacion', () => {
  it('guion, punto y barra no cuentan: NEWSAN factura con guion y Tango lo tiene sin', () => {
    // 2026-09-18. Medido sobre toda la base: espacio, punto, guion y barra
    // son los unicos no alfanumericos en los codigos, y quitarlos no
    // colisiona ningun par.
    expect(normalizarCodigo('AS-12UW4RLRCD02 N')).toBe('AS12UW4RLRCD02N')
    expect(normalizarCodigo('27383.001/27')).toBe('2738300127')
  })

  it('pero NO limpia lo que la IA pego de mas: eso lo arregla el prompt', () => {
    // La alicuota de IVA de la misma celda queda adentro de la clave y no
    // matchea: es correcto que no matchee, un codigo con basura no es el
    // codigo. El prompt v13 le pide a la IA que no la incluya.
    expect(normalizarCodigo('AS-12UW4RLRCD02 N ( 21.00) *')).not.toBe('AS12UW4RLRCD02N')
  })
})

describe('cotejarConOc con el mismo artículo en varios renglones de la OC', () => {
  // OC 0000100001703 de IMSA: la moto 105164 en cuatro renglones.
  const oc = [1, 4, 3, 3].map((pendiente, i) => ({
    nRenglOc: i + 1,
    codArticu: '105164',
    descripcion: 'MOTO MONDIAL TD 150',
    pendiente,
  }))
  const sinonimos = new Map([['MNTD150AZLLE2', '105164'], ['MNTD150NELLE2', '105164'], ['MNTD150BLLLE2', '105164']])

  it('coteja contra la suma de lo pendiente del artículo, no contra un solo renglón', () => {
    const r = cotejarConOc(
      [
        { orden: 1, codigo: 'MNTD-150NE-LLE2', cantidad: '1' },
        { orden: 2, codigo: 'MNTD-150AZ-LLE2', cantidad: '4' },
        { orden: 3, codigo: 'MNTD-150BL-LLE2', cantidad: '3' },
        { orden: 4, codigo: 'MNTD-150AZ-LLE2', cantidad: '3' },
      ],
      oc,
      sinonimos,
    )
    expect(r.problemas).toEqual([])
    expect(r.noFacturados).toEqual([])
  })

  it('señala cuando el total entregado del artículo supera lo pendiente', () => {
    const r = cotejarConOc([{ orden: 2, codigo: 'MNTD-150AZ-LLE2', cantidad: '12' }], oc, sinonimos)
    expect(r.problemas).toEqual([
      { tipo: 'excede-pendiente', orden: 2, codigo: 'MNTD-150AZ-LLE2', factura: 12, pendiente: 11 },
    ])
  })

  it('un renglón de la OC que traen dos líneas cuenta una sola vez', () => {
    const r = cotejarConOc(
      [{ orden: 1, codigo: '105164', cantidad: '4' }],
      [oc[2], { ...oc[2] }],
    )
    expect(r.problemas[0]).toMatchObject({ tipo: 'excede-pendiente', factura: 4, pendiente: 3 })
  })
})
