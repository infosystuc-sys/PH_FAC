import { describe, it, expect } from 'vitest'
import {
  resolverPercepciones,
  resolverVarios,
  resolverCodigoVarios,
  codigosVarios,
  codigosPercepcion,
} from '@/lib/percepciones'
import { validarPercepciones, validarVarios } from '@/lib/validaciones'

// Los codigos no-IVA reales de CPA14, verificados contra la base.
const CPA14_NO_IVA = [
  { codigo: 40, descripcion: 'IMP INT' },
  { codigo: 52, descripcion: 'IMP. INTERNO NULO' },
  { codigo: 53, descripcion: 'IMP. A LAS GANANCIAS' },
  { codigo: 54, descripcion: 'RETENCION DE GANANCI' },
  { codigo: 55, descripcion: 'PERC. TEM Y PYP' },
  { codigo: 56, descripcion: 'RETENCION MUNICIPAL' },
  { codigo: 60, descripcion: 'PERCEPCION IIBB TUC' },
  { codigo: 61, descripcion: 'PERCEPCION IIBB SALT' },
  { codigo: 62, descripcion: 'PERCEPCION IIBB CABA' },
  { codigo: 63, descripcion: 'RET IIBB TUCUMAN' },
  { codigo: 64, descripcion: 'RET IIBB BANCARIOS' },
  { codigo: 65, descripcion: 'PERCEP DEB Y CRED RG' },
  { codigo: 66, descripcion: 'RET IIBB SIRCREB' },
  { codigo: 67, descripcion: 'RET SIRTAC' },
  { codigo: 68, descripcion: 'PERCEP IIBB FORMOSA' },
]

describe('codigosVarios', () => {
  it('ofrece todos los codigos no-IVA de CPA14, sin esconder ninguno', () => {
    // Hasta el 2026-09-09 escondia las cinco jurisdicciones de Ingresos
    // Brutos. El usuario pidio primero el 64 y despues habilitar todas: el
    // criterio pasa a ser que el operador vea todo lo que Tango admite.
    expect(codigosVarios(CPA14_NO_IVA).map((c) => c.codigo).sort((a, b) => a - b)).toEqual([
      40, 52, 53, 54, 55, 56, 60, 61, 62, 63, 64, 65, 66, 67, 68,
    ])
  })

  it('percepcion y varios ofrecen lo mismo: las dos escriben en CPA18', () => {
    expect(codigosPercepcion(CPA14_NO_IVA)).toEqual(codigosVarios(CPA14_NO_IVA))
  })
})

describe('resolverPercepciones', () => {
  it('ignora los slots sin importe', () => {
    expect(resolverPercepciones({ percep1: 'Tucumán', imppercep1: '' })).toEqual([])
    expect(resolverPercepciones({})).toEqual([])
  })

  it('resuelve dos jurisdicciones distintas a sus codigos', () => {
    const r = resolverPercepciones({
      percep1: 'Tucumán', imppercep1: '7.748,86',
      percep2: 'CABA', imppercep2: '1.120,08',
    })
    expect(r).toHaveLength(2)
    expect(r[0].estado).toBe('registra')
    expect(r[0].codigo?.codigo).toBe('60')
    expect(r[1].codigo?.codigo).toBe('62')
  })

  it('marca sin-codigo una jurisdiccion que no esta en la norma', () => {
    const r = resolverPercepciones({ percep1: 'Córdoba', imppercep1: '500,00' })
    expect(r[0].estado).toBe('sin-codigo')
    expect(r[0].codigo).toBeNull()
  })

  it('resuelve con lo aprendido una jurisdiccion que no esta en la norma', () => {
    const r = resolverPercepciones(
      { percep1: 'Córdoba', imppercep1: '500,00' },
      null,
      { cordoba: '62' },
    )
    expect(r[0].estado).toBe('registra')
    expect(r[0].codigo?.codigo).toBe('62')
  })

  it('un importe sin jurisdiccion tambien queda sin-codigo, no se ignora', () => {
    // Si se ignorara, el importe contaria en el total imputado pero no se
    // grabaria en CPA18: el comprobante entraria a Tango por menos.
    const r = resolverPercepciones({ percep1: '', imppercep1: '500,00' })
    expect(r).toHaveLength(1)
    expect(r[0].estado).toBe('sin-codigo')
  })
})

describe('correccion manual de la percepcion', () => {
  it('el codigo elegido a mano gana sobre la jurisdiccion leida', () => {
    const r = resolverPercepciones({
      percep1: 'Tucumán', imppercep1: '500,00', codpercep1: '61',
    })
    expect(r[0].estado).toBe('registra')
    expect(r[0].codigo?.codigo).toBe('61')
  })

  it('rescata una jurisdiccion que sin correccion no se reconoceria', () => {
    const r = resolverPercepciones({
      percep1: 'Córdoba', imppercep1: '500,00', codpercep1: '60',
    })
    expect(r[0].estado).toBe('registra')
    expect(r[0].codigo?.codigo).toBe('60')
  })

  it('acepta corregir a cualquier codigo de CPA14, no solo a una jurisdiccion', () => {
    // Desde el 2026-09-09 el operador puede corregir una percepcion a
    // cualquier codigo del maestro -- pedido del usuario. La etiqueta sale de
    // CPA14 cuando no es una de las cinco jurisdicciones.
    const r = resolverPercepciones(
      { percep1: 'Tucumán', imppercep1: '500,00', codpercep1: '63' },
      null,
      {},
      CPA14_NO_IVA,
    )
    expect(r[0].estado).toBe('registra')
    expect(r[0].codigo?.codigo).toBe('63')
    expect(r[0].codigo?.jurisdiccion).toBe('RET IIBB TUCUMAN')
  })

  it('la jurisdiccion conserva su etiqueta propia, no la de CPA14', () => {
    // "Tucumán" y no "PERCEPCION IIBB TUC": la lista curada gana cuando el
    // codigo esta en las dos.
    const r = resolverPercepciones(
      { percep1: 'CABA', imppercep1: '500,00', codpercep1: '60' },
      null,
      {},
      CPA14_NO_IVA,
    )
    expect(r[0].codigo?.jurisdiccion).toBe('Tucumán')
  })

  it('un codigo que no existe en ningun lado queda sin-codigo', () => {
    const r = resolverPercepciones(
      { percep1: 'Tucumán', imppercep1: '500,00', codpercep1: '999' },
      null,
      {},
      CPA14_NO_IVA,
    )
    expect(r[0].estado).toBe('sin-codigo')
  })
})

describe('resolverVarios', () => {
  it('ignora los slots sin importe', () => {
    expect(resolverVarios({ varios1: '40', impvarios1: '' }, CPA14_NO_IVA)).toEqual([])
  })

  it('resuelve el codigo elegido a su descripcion de Tango', () => {
    const r = resolverVarios({ varios1: '40', impvarios1: '1.234,00' }, CPA14_NO_IVA)
    expect(r[0].estado).toBe('registra')
    expect(r[0].descripcion).toBe('IMP INT')
  })

  it('admite un codigo que antes era exclusivo de percepcion', () => {
    // El 60 pertenece a la familia de percepciones, pero desde el 2026-09-09
    // las dos listas ofrecen lo mismo: las dos escriben en CPA18 y el
    // operador elige. Si termina cargado en las dos, el registro las suma en
    // una sola fila y el panel lo avisa (ver validarCodigosRepetidos).
    const r = resolverVarios({ varios1: '60', impvarios1: '1.000,00' }, CPA14_NO_IVA)
    expect(r[0].estado).toBe('registra')
    expect(r[0].descripcion).toBe('PERCEPCION IIBB TUC')
  })

  it('rechaza un codigo inexistente', () => {
    const r = resolverVarios({ varios1: '999', impvarios1: '1.000,00' }, CPA14_NO_IVA)
    expect(r[0].estado).toBe('sin-codigo')
  })

  it('resuelve por el rotulo que el proveedor ya enseño', () => {
    // El caso que motivo el cambio: el operador eligio el impuesto una vez
    // en una liquidacion de Tarjeta Naranja y la siguiente tiene que salir
    // sola. Antes `variosN` guardaba el codigo, asi que no habia rotulo
    // contra el cual aprender y la eleccion se perdia.
    const r = resolverVarios(
      { varios1: 'Trib. emerg. munic.', impvarios1: '1.763,47' },
      CPA14_NO_IVA,
      { 'trib. emerg. munic.': '40' },
    )
    expect(r[0].estado).toBe('registra')
    expect(r[0].codigo).toBe('40')
    expect(r[0].texto).toBe('Trib. emerg. munic.')
  })

  it('matchea el rotulo aprendido con otro casing o acentuacion', () => {
    const r = resolverVarios(
      { varios1: 'RETENCIÓN  TEM', impvarios1: '453,74' },
      CPA14_NO_IVA,
      { 'retencion tem': '40' },
    )
    expect(r[0].estado).toBe('registra')
  })

  it('la correccion del operador gana sobre lo aprendido', () => {
    const r = resolverVarios(
      { varios1: 'Trib. emerg. munic.', impvarios1: '1.000,00', codvarios1: '53' },
      CPA14_NO_IVA,
      { 'trib. emerg. munic.': '40' },
    )
    expect(r[0].codigo).toBe('53')
  })

  it('un rotulo sin aprender queda sin codigo, para que el operador lo elija', () => {
    const r = resolverVarios(
      { varios1: 'Un impuesto que nunca vimos', impvarios1: '1.000,00' },
      CPA14_NO_IVA,
    )
    expect(r[0].estado).toBe('sin-codigo')
    expect(r[0].texto).toBe('Un impuesto que nunca vimos')
  })

  it('sigue entendiendo los comprobantes viejos, que guardaban el codigo en el rotulo', () => {
    // Compatibilidad: los comprobantes anteriores al cambio tienen "40" en
    // `varios1`. Sin esta rama quedarian todos en 'sin-codigo' y no se
    // podrian registrar, que es peor que la inconsistencia que arrastran.
    const r = resolverVarios({ varios1: '40', impvarios1: '1.234,00' }, CPA14_NO_IVA)
    expect(r[0].estado).toBe('registra')
    expect(r[0].codigo).toBe('40')
  })
})

describe('validarPercepciones', () => {
  it('una linea sin imputar pide elegir el codigo', () => {
    // Antes decia "no se reconoce la jurisdiccion", que desde el 2026-09-11
    // ya no describe el caso: en tarjeta la jurisdiccion es irrelevante y lo
    // que falta es la fila de la tabla de imputacion para ese emisor.
    const r = validarPercepciones(
      resolverPercepciones({ percep1: 'Ret.IB TUCUMAN 5,00 %', imppercep1: '1.000,00' }, 'tarjeta'),
    )
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('Elegí el código de Tango')
    expect(r.mensaje).toContain('Ret.IB TUCUMAN 5,00 %')
  })

  it('ok sin lineas', () => {
    expect(validarPercepciones([]).estado).toBe('ok')
  })

  it('ok mostrando jurisdiccion y codigo de cada una', () => {
    const r = validarPercepciones(
      resolverPercepciones({ percep1: 'Tucumán', imppercep1: '7.748,86' }),
    )
    expect(r.estado).toBe('ok')
    expect(r.mensaje).toContain('Tucumán')
    expect(r.mensaje).toContain('60')
  })

  it('bloquea con la jurisdiccion textual que no se reconocio', () => {
    const r = validarPercepciones(
      resolverPercepciones({ percep1: 'Córdoba', imppercep1: '500,00' }),
    )
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('Córdoba')
  })
})

describe('validarVarios', () => {
  it('ok sin lineas', () => {
    expect(validarVarios([]).estado).toBe('ok')
  })

  it('ok mostrando codigo y descripcion', () => {
    const r = validarVarios(
      resolverVarios({ varios1: '40', impvarios1: '1.234,00' }, CPA14_NO_IVA),
    )
    expect(r.estado).toBe('ok')
    expect(r.mensaje).toContain('IMP INT')
  })

  it('bloquea si hay importe sin codigo elegido', () => {
    const r = validarVarios(resolverVarios({ impvarios1: '1.234,00' }, CPA14_NO_IVA))
    expect(r.estado).toBe('error')
  })
})

describe('resolverPercepciones en resumen de tarjeta', () => {
  // La tabla de imputacion del usuario (48 filas, cargadas como aprendidas
  // por proveedor) es la unica fuente en tarjeta. Lo que no esta en ella no
  // se adivina: queda sin codigo y lo imputa el operador. Decision del
  // 2026-09-11, despues de que la regla anterior --toda linea de IIBB de una
  // tarjeta al 64-- imputara la retencion de Tucuman al codigo del SIRTAC.
  it('sin fila en la tabla, la linea queda sin codigo', () => {
    for (const juris of ['Tucumán', 'Salta', 'CABA', 'Bancarias', 'Córdoba']) {
      const l = resolverPercepciones({ percep1: juris, imppercep1: '1.000,00' }, 'tarjeta')
      expect(l[0].codigo, juris).toBeNull()
      expect(l[0].estado, juris).toBe('sin-codigo')
    }
  })

  it('el SIRCREB tampoco queda exceptuado', () => {
    // Tenia el 66 fijo; no figura en la tabla del usuario.
    const l = resolverPercepciones({ percep1: 'SIRCREB', imppercep1: '500,00' }, 'tarjeta')
    expect(l[0].estado).toBe('sin-codigo')
  })

  it('con la fila de la tabla, resuelve al codigo que ella dice', () => {
    // El rotulo impreso es la clave, y la tabla manda el IIBB de Tucuman de
    // las liquidaciones al 63 -- no al 60 de la jurisdiccion ni al 64.
    const l = resolverPercepciones(
      { percep1: 'Ret.IB TUCUMAN 5,00 %', imppercep1: '1.000,00' },
      'tarjeta',
      { 'ret.ib tucuman 5,00 %': '63' },
      CPA14_NO_IVA,
    )
    expect(l[0].codigo?.codigo).toBe('63')
    expect(l[0].estado).toBe('registra')
  })

  it('no cambia nada en conceptos ni en articulos', () => {
    for (const tipo of ['conceptos', 'articulos'] as const) {
      const l = resolverPercepciones({ percep1: 'Tucumán', imppercep1: '1.000,00' }, tipo)
      expect(l[0].codigo?.codigo, tipo).toBe('60')
    }
  })

  it('la correccion manual sigue ganando sobre todo', () => {
    // Si el operador eligio un codigo a mano, es porque sabe algo que la
    // tabla no: no se lo pisa.
    const l = resolverPercepciones(
      { percep1: 'Tucumán', imppercep1: '1.000,00', codpercep1: '62' },
      'tarjeta',
    )
    expect(l[0].codigo?.codigo).toBe('62')
  })

  it('toma el tipo de los propios valores si no se lo pasan aparte', () => {
    const l = resolverPercepciones({
      tipoFactura: 'tarjeta',
      percep1: 'Salta',
      imppercep1: '300,00',
    })
    expect(l[0].estado).toBe('sin-codigo')
  })
})

describe('resolverCodigoVarios', () => {
  // La celda "En Tango" del formulario y resolverVarios llaman a esta misma
  // funcion. Hasta el 2026-09-06 la celda repetia la precedencia a mano y se
  // le habia quedado afuera un termino: mostraba el desplegable vacio y en
  // rojo mientras el registro imputaba a otra cosa. Estos casos fijan la
  // precedencia entera para que las dos no puedan volver a separarse.

  it('la correccion del operador gana sobre lo aprendido', () => {
    expect(
      resolverCodigoVarios('Ret.IB SIRTAC', '56', CPA14_NO_IVA, { 'ret.ib sirtac': '63' }),
    ).toBe('56')
  })

  it('lo aprendido del proveedor resuelve el rotulo', () => {
    // Es el camino por el que se aplica la tabla de imputacion del usuario.
    expect(resolverCodigoVarios('Ret.IB SIRTAC', '', CPA14_NO_IVA, { 'ret.ib sirtac': '63' })).toBe(
      '63',
    )
  })

  it('el SIRTAC ya no se resuelve solo: sin fila en la tabla, lo elige el operador', () => {
    // Habia una regla que mandaba cualquier rotulo con la sigla a un codigo
    // fijo. Esa constante dio cuatro vueltas --56, 63, 67, 64-- porque el
    // codigo no se deduce de la sigla: lo define la tabla, por emisor. Se
    // saco el 2026-09-11.
    for (const rotulo of [
      'Ret.IB SIRTAC',
      'RETENCION IIBB SIRTAC',
      'Retencion I.B. /SIRTAC',
      'Régimen de Retención SIRTAC',
    ]) {
      expect(resolverCodigoVarios(rotulo, '', CPA14_NO_IVA, {}), rotulo).toBe('')
    }
  })

  it('acepta el codigo guardado en el campo del rotulo, de los comprobantes viejos', () => {
    expect(resolverCodigoVarios('56', '', CPA14_NO_IVA, {})).toBe('56')
  })

  it('devuelve vacio para un rotulo que no resuelve a nada', () => {
    expect(resolverCodigoVarios('Trib. emerg. munic.', '', CPA14_NO_IVA, {})).toBe('')
    expect(resolverCodigoVarios('', '', CPA14_NO_IVA, {})).toBe('')
  })

  it('resuelve lo mismo que resolverVarios, que es el punto de que exista', () => {
    const aprendidos = { 'ret.ib sirtac': '64' }
    const valores = { varios1: 'Ret.IB SIRTAC', impvarios1: '1.000,00' }
    const porLinea = resolverVarios(valores, CPA14_NO_IVA, aprendidos)[0]
    const suelto = resolverCodigoVarios(
      'Ret.IB SIRTAC',
      '',
      codigosVarios(CPA14_NO_IVA),
      aprendidos,
    )
    expect(porLinea.codigo).toBe(suelto)
    expect(porLinea.estado).toBe('registra')
  })
})
