import { describe, it, expect } from 'vitest'
import { emparejarOcs, resolverLineasPdf, lineasAVincular, normalizarDescripcionArticulo, lineasContraOc, lineasCargo, emparejarRenglones } from '@/lib/matchOc'

/**
 * Las dos OC pendientes reales de CARRIER (010246) al implementar esto, y
 * la factura 8460, que cobra 30 de "MDRT489MTE46ADW" -- el sinonimo que
 * CPA15 traduce a nuestro 106037, renglon 6 de la 1632.
 */
const OC_1632 = {
  nOrdenCo: ' 0000100001632',
  renglones: [
    { codArticu: '106036' },
    { codArticu: '106141' },
    { codArticu: '106041' },
    { codArticu: '106037' },
    { codArticu: '105585' },
  ],
}
const OC_1595 = { nOrdenCo: ' 0000100001595', renglones: [{ codArticu: '106893' }] }
const OCS = [OC_1632, OC_1595]

const SINONIMOS = new Map([['MDRT489MTE46ADW', '106037']])

describe('emparejarOcs', () => {
  it('deja solo la OC que tiene el articulo que la factura cobra', () => {
    const r = emparejarOcs(['MDRT489MTE46ADW'], OCS, SINONIMOS)
    expect(r.coinciden.map((c) => c.oc.nOrdenCo)).toEqual([OC_1632.nOrdenCo])
    expect(r.coinciden[0].articulos).toEqual(['106037'])
    expect(r.sinResolver).toEqual([])
  })

  it('acepta el codigo nuestro impreso tal cual, sin sinonimo', () => {
    // Hay proveedores que facturan con nuestro propio codigo.
    const r = emparejarOcs(['106893'], OCS, new Map())
    expect(r.coinciden.map((c) => c.oc.nOrdenCo)).toEqual([OC_1595.nOrdenCo])
  })

  it('el codigo nuestro gana sobre el sinonimo, mismo criterio que el cotejo', () => {
    // Un proveedor que usa como sinonimo un codigo que tambien es nuestro.
    const sinonimos = new Map([['106893', '106037']])
    const r = emparejarOcs(['106893'], OCS, sinonimos)
    expect(r.coinciden.map((c) => c.oc.nOrdenCo)).toEqual([OC_1595.nOrdenCo])
  })

  it('empareja sin importar mayusculas ni espacios', () => {
    // El codigo sale de un PDF transcripto por el modelo; CPA15 y CPA36
    // estan en Latin1_General_BIN, que distingue mayusculas.
    const r = emparejarOcs(['  mdrt489mte46adw '], OCS, SINONIMOS)
    expect(r.coinciden.map((c) => c.oc.nOrdenCo)).toEqual([OC_1632.nOrdenCo])
  })

  it('alcanza con UN articulo en comun: una factura puede partirse entre dos OC', () => {
    const r = emparejarOcs(['106037', '106893'], OCS, new Map())
    expect(r.coinciden).toHaveLength(2)
  })

  it('ordena por cantidad de articulos en comun, la que mas primero', () => {
    // La 1595 viene primera en la entrada y aun asi queda segunda: la 1632
    // cubre dos de los articulos facturados y ella uno solo.
    const r = emparejarOcs(['106893', '106037', '106141'], [OC_1595, OC_1632], new Map())
    expect(r.coinciden.map((c) => c.oc.nOrdenCo)).toEqual([OC_1632.nOrdenCo, OC_1595.nOrdenCo])
    expect(r.coinciden[0].articulos).toEqual(['106141', '106037'])
  })

  it('no coincide con ninguna cuando el codigo no esta en ninguna OC', () => {
    // El caso de la factura 8459, con dos codigos que CPA15 todavia no tiene.
    const r = emparejarOcs(['MDRT645MTE46ADW', 'MW-DG125BAR1'], OCS, new Map())
    expect(r.coinciden).toEqual([])
    expect(r.sinResolver).toEqual(['MDRT645MTE46ADW', 'MW-DG125BAR1'])
  })

  it('informa como sin resolver solo los que no emparejaron', () => {
    const r = emparejarOcs(['MDRT489MTE46ADW', 'NO-EXISTE'], OCS, SINONIMOS)
    expect(r.coinciden.map((c) => c.oc.nOrdenCo)).toEqual([OC_1632.nOrdenCo])
    expect(r.sinResolver).toEqual(['NO-EXISTE'])
  })

  it('separa el codigo reconocido sin saldo del que no se reconoce', () => {
    // ZOZZOLI, 2026-09-15: 12100 tiene sinonimo en CPA15 (101406) pero ese
    // articulo no tiene pendiente en ninguna orden. Hasta ese dia iba a
    // sinResolver, la pantalla decia "no se reconoce" y ofrecia enseñar un
    // sinonimo que ya existia. Enseñar no lo arregla: falta una orden con
    // saldo. Es otra cosa y se informa aparte.
    const sinonimos = new Map([...SINONIMOS, ['12100', '101406']])
    const r = emparejarOcs(['12100', 'NO-EXISTE'], OCS, sinonimos)
    expect(r.coinciden).toEqual([])
    expect(r.reconocidosSinPendiente).toEqual([{ codigo: '12100', codArticu: '101406' }])
    expect(r.sinResolver).toEqual(['NO-EXISTE'])
  })

  it('no repite un codigo sin resolver que la factura trae dos veces', () => {
    const r = emparejarOcs(['NO-EXISTE', 'no-existe'], OCS, new Map())
    // Se informa tal como esta impreso la primera vez, no la clave.
    expect(r.sinResolver).toEqual(['NO-EXISTE'])
  })

  it('sin renglones leidos del PDF no filtra nada', () => {
    // La IA no pudo leer el detalle: no hay con que emparejar, y devolver
    // "ninguna coincide" haria que la pantalla ofrezca todas, que es lo
    // correcto -- no que no ofrezca ninguna.
    expect(emparejarOcs([], OCS, SINONIMOS).coinciden).toEqual([])
    expect(emparejarOcs([null, '', '  '], OCS, SINONIMOS).sinResolver).toEqual([])
  })

  it('no cuenta dos veces un articulo que la OC repite en dos renglones', () => {
    const oc = {
      nOrdenCo: 'X',
      renglones: [{ codArticu: '106037' }, { codArticu: '106037' }],
    }
    const r = emparejarOcs(['106037'], [oc], new Map())
    expect(r.coinciden[0].articulos).toEqual(['106037'])
  })
})

describe('resolverLineasPdf', () => {
  // Hay proveedores que no imprimen codigo de articulo (RED DEL INTERIOR,
  // 2026-09-17): lo unico estable es la descripcion, y el operador la
  // vincula una vez a un articulo nuestro.
  const aprendidas = {
    [normalizarDescripcionArticulo('40PFD6920/77 SMART TV 40" FHD PHILIPS')]: {
      codArticu: '107001',
      sinOc: false,
    },
  }

  it('un renglon sin codigo toma el articulo aprendido para su descripcion', () => {
    const r = resolverLineasPdf(
      [{ orden: 1, codigo: null, descripcion: '40PFD6920/77  Smart TV 40" FHD Philips', cantidad: '15' }],
      aprendidas,
    )
    expect(r[0].codigo).toBe('107001')
    expect(r[0].porDescripcion).toBe(true)
  })

  it('si la factura trae codigo, manda el codigo: la descripcion no se mira', () => {
    const r = resolverLineasPdf(
      [{ orden: 1, codigo: 'ABC', descripcion: '40PFD6920/77 SMART TV 40" FHD PHILIPS', cantidad: '1' }],
      aprendidas,
    )
    expect(r[0].codigo).toBe('ABC')
    expect(r[0].porDescripcion).toBe(false)
  })

  it('un CARGO aprendido gana sobre el codigo impreso', () => {
    // DASS factura "280910 SEGURO-FLETES": el 280910 es un codigo interno
    // del proveedor que no existe en nuestro maestro. Respetarlo dejaria el
    // renglon apuntando a un articulo inexistente y el registro cortaria en
    // Tango. Que el operador lo marque como cargo y le elija un articulo es
    // una decision explicita suya (2026-09-30).
    const cargo = {
      [normalizarDescripcionArticulo('SEGURO-FLETES')]: { codArticu: '103501', sinOc: true },
    }
    const r = resolverLineasPdf(
      [{ orden: 1, codigo: '280910', descripcion: 'SEGURO-FLETES', cantidad: '1' }],
      cargo,
    )
    expect(r[0].codigo).toBe('103501')
    expect(r[0].sinOc).toBe(true)
    expect(r[0].porDescripcion).toBe(true)
    // Y llega a la lista de cargos, que es lo que lo registra sin orden.
    expect(lineasCargo(r).map((l) => l.codigo)).toEqual(['103501'])
  })

  it('un aprendizaje que NO es cargo sigue sin pisar el codigo impreso', () => {
    // La excepcion es solo para los cargos: en el caso normal el codigo de
    // la factura sigue mandando.
    const r = resolverLineasPdf(
      [{ orden: 1, codigo: 'ABC', descripcion: '40PFD6920/77 SMART TV 40" FHD PHILIPS', cantidad: '1' }],
      aprendidas,
    )
    expect(r[0].codigo).toBe('ABC')
  })

  it('sin descripcion aprendida, el renglon queda sin codigo y a vincular', () => {
    const r = resolverLineasPdf(
      [
        { orden: 1, codigo: null, descripcion: 'GESTION DE COMPRA 1%', cantidad: '1' },
        { orden: 2, codigo: null, descripcion: '40PFD6920/77 SMART TV 40" FHD PHILIPS', cantidad: '15' },
      ],
      aprendidas,
    )
    expect(r[0].codigo).toBeNull()
    expect(lineasAVincular(r).map((l) => l.orden)).toEqual([1])
  })

  it('la clave de la descripcion ignora acentos, mayusculas y espacios de mas', () => {
    expect(normalizarDescripcionArticulo('  Colchón  190x140  BRISAS ')).toBe('colchon 190x140 brisas')
  })
})

describe('cargos del proveedor (sin orden de compra)', () => {
  // RED DEL INTERIOR factura "GESTION DE COMPRA 1%" y "GESTION ROSARIO
  // LOGISTICA S.A." (2026-09-22): no forman parte de ninguna OC y tienen que
  // registrarse igual. No se puede deducir -- esos articulos existen en OTRAS
  // ordenes pendientes del mismo proveedor --, asi que lo marca el operador.
  const aprendidas = {
    [normalizarDescripcionArticulo('GESTION DE COMPRA 1%')]: { codArticu: '106715', sinOc: true },
    [normalizarDescripcionArticulo('SMART TV 40" FHD PHILIPS')]: { codArticu: '106911', sinOc: false },
  }

  const lineas = () =>
    resolverLineasPdf(
      [
        { orden: 1, codigo: null, descripcion: 'SMART TV 40" FHD PHILIPS', cantidad: '15' },
        { orden: 2, codigo: null, descripcion: 'GESTION DE COMPRA 1%', cantidad: '1' },
      ],
      aprendidas,
    )

  it('el cargo resuelve su articulo y queda marcado', () => {
    const r = lineas()
    expect(r[1].codigo).toBe('106715')
    expect(r[1].sinOc).toBe(true)
    expect(r[0].sinOc).toBe(false)
  })

  it('los cargos no van contra la OC, pero si se registran', () => {
    const r = lineas()
    expect(lineasContraOc(r).map((l) => l.orden)).toEqual([1])
    expect(lineasCargo(r).map((l) => l.orden)).toEqual([2])
  })

  it('un cargo resuelto no es un renglon a vincular', () => {
    expect(lineasAVincular(lineas())).toEqual([])
  })

  it('un cargo con codigo impreso usa el articulo aprendido, no el codigo', () => {
    // Que un renglon sea un cargo no depende de si el proveedor imprimio un
    // codigo al lado: la clave de lo aprendido es la descripcion.
    //
    // Hasta el 2026-09-30 esto afirmaba que el codigo impreso se conservaba.
    // Era una suposicion que nunca se habia ejercitado contra una factura
    // real: los cargos de RED DEL INTERIOR, que motivaron el caso, venian
    // SIN codigo. DASS factura "280910 SEGURO-FLETES" y ahi se ve que esta
    // mal -- el 280910 es interno del proveedor y no existe en nuestro
    // maestro, asi que conservarlo deja el renglon apuntando a un articulo
    // inexistente y el registro corta en Tango. El articulo que eligio el
    // operador es el unico dato utilizable.
    const r = resolverLineasPdf(
      [{ orden: 1, codigo: 'ABC', descripcion: 'GESTION DE COMPRA 1%', cantidad: '1' }],
      aprendidas,
    )
    expect(r[0].codigo).toBe('106715')
    expect(r[0].sinOc).toBe(true)
  })

  it('un cargo sin articulo vinculado no se registra como cargo', () => {
    // lineasCargo exige codigo: sin articulo no hay nada que grabar en CPA46.
    const r = resolverLineasPdf(
      [{ orden: 1, codigo: null, descripcion: 'OTRO CARGO', cantidad: '1' }],
      { [normalizarDescripcionArticulo('OTRO CARGO')]: { codArticu: '', sinOc: true } },
    )
    expect(lineasCargo(r)).toEqual([])
  })
})

describe('emparejarRenglones con el mismo artículo en varios renglones de la OC', () => {
  // La OC 0000100001703 de IMSA: la moto 105164 en cuatro renglones (1, 4, 3
  // y 3), y el remito que la entrega en cuatro lineas iguales.
  const oc = [
    { nRenglOc: 1, codArticu: '105164', pendiente: 1 },
    { nRenglOc: 2, codArticu: '105164', pendiente: 4 },
    { nRenglOc: 3, codArticu: '105164', pendiente: 3 },
    { nRenglOc: 4, codArticu: '105164', pendiente: 3 },
  ]
  const linea = (orden: number, cantidad: string) => ({ orden, codigo: '105164', cantidad })
  const renglonDe = (r: { enOc: { nRenglOc: number } | null }[]) =>
    r.map((x) => x.enOc?.nRenglOc ?? null)

  it('cada línea va contra un renglón distinto, el de su misma cantidad', () => {
    const r = emparejarRenglones([linea(1, '1'), linea(2, '4'), linea(3, '3'), linea(4, '3')], oc, new Map())
    expect(renglonDe(r)).toEqual([1, 2, 3, 4])
  })

  it('con las líneas en otro orden, igual respeta la cantidad', () => {
    const r = emparejarRenglones([linea(1, '3'), linea(2, '1'), linea(3, '3'), linea(4, '4')], oc, new Map())
    expect(renglonDe(r)).toEqual([3, 1, 4, 2])
  })

  it('sin cantidad igual, el primer renglón libre que alcance', () => {
    const r = emparejarRenglones([linea(1, '2'), linea(2, '2')], oc, new Map())
    expect(renglonDe(r)).toEqual([2, 3])
  })

  it('no usa los renglones ocupados por otras líneas del comprobante', () => {
    const r = emparejarRenglones([linea(2, '3')], oc, new Map(), (x) => x.nRenglOc === 3)
    expect(renglonDe(r)).toEqual([4])
  })

  it('un artículo en un solo renglón de la OC se empareja como siempre', () => {
    const r = emparejarRenglones(
      [{ orden: 1, codigo: 'ABC', cantidad: '5' }],
      [{ nRenglOc: 7, codArticu: 'ABC', pendiente: 10 }],
      new Map(),
    )
    expect(r[0].enOc?.nRenglOc).toBe(7)
  })
})
