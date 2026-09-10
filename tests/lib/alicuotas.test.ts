import { describe, it, expect } from 'vitest'
import {
  resolverCodigoIva,
  resolverAlicuotas,
  esPorcentaje,
  claveAprendidaIva,
  CODIGO_IVA_PREFERIDO,
  type AlicuotaTango,
} from '@/lib/alicuotas'
import { validarAlicuotas } from '@/lib/validaciones'

// Las alicuotas TIPO_ALI='IV' reales de CPA14, verificadas contra la base.
// El 0% y el 3% son los dos porcentajes con mas de un codigo posible.
const CPA14: AlicuotaTango[] = [
  { codigo: 4, porcentaje: 27, descripcion: 'IVA 27%' },
  { codigo: 1, porcentaje: 21, descripcion: 'IVA 21%' },
  { codigo: 3, porcentaje: 10.5, descripcion: 'IVA 10,5%' },
  { codigo: 15, porcentaje: 3, descripcion: 'PERCEPCION R.G.3337' },
  { codigo: 16, porcentaje: 3, descripcion: 'PERCEP. DE IVA' },
  { codigo: 2, porcentaje: 0, descripcion: 'IVA 0%' },
  { codigo: 17, porcentaje: 0, descripcion: 'RETENCION IVA' },
]

describe('resolverCodigoIva', () => {
  it('resuelve los porcentajes de codigo unico', () => {
    expect(resolverCodigoIva(21, CPA14)?.codigo).toBe(1)
    expect(resolverCodigoIva(27, CPA14)?.codigo).toBe(4)
    expect(resolverCodigoIva(10.5, CPA14)?.codigo).toBe(3)
  })

  it('desempata el 3% al codigo 16, no al 15', () => {
    expect(resolverCodigoIva(3, CPA14)?.codigo).toBe(16)
  })

  it('devuelve null para un porcentaje que Tango no tiene', () => {
    expect(resolverCodigoIva(5, CPA14)).toBeNull()
  })

  it('usa lo aprendido cuando el porcentaje no resuelve solo', () => {
    expect(resolverCodigoIva(5, CPA14, { '5': '1' })?.codigo).toBe(1)
  })

  it('lo aprendido no gana sobre un porcentaje que ya resuelve solo', () => {
    // El proveedor no puede "desaprender" el 21% -> 1 con una fila vieja
    // o mal cargada para otro porcentaje.
    expect(resolverCodigoIva(21, CPA14, { '21': '999' })?.codigo).toBe(1)
  })

  it('sin aprendizaje para ese porcentaje, sigue devolviendo null', () => {
    expect(resolverCodigoIva(5, CPA14, { '7': '1' })).toBeNull()
  })
})

describe('resolverAlicuotas', () => {
  it('ignora los slots sin importe', () => {
    expect(resolverAlicuotas({ porciva1: '21', impiva1: '' }, CPA14)).toEqual([])
    expect(resolverAlicuotas({}, CPA14)).toEqual([])
  })

  it('resuelve dos slots con sus codigos de Tango', () => {
    const r = resolverAlicuotas(
      { porciva1: '21', impiva1: '9.134,65', porciva2: '3', impiva2: '1.304,95' },
      CPA14,
    )
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ slot: 1, porcentaje: 21, estado: 'registra' })
    expect(r[0].alicuota?.codigo).toBe(1)
    expect(r[1]).toMatchObject({ slot: 2, porcentaje: 3, estado: 'registra' })
    expect(r[1].alicuota?.codigo).toBe(16)
  })

  it('marca la alicuota 0% como omitida en vez de resolverla', () => {
    // Norma de registracion: la 0% no se registra. Antes caia en el
    // desempate del 3% (buscaba el codigo preferido), no lo encontraba y el
    // registro fallaba con "no se pudo resolver el codigo de IVA".
    const r = resolverAlicuotas({ porciva1: '0', impiva1: '1.000,00' }, CPA14)
    expect(r).toHaveLength(1)
    expect(r[0].estado).toBe('omitida')
    expect(r[0].alicuota).toBeNull()
  })

  it('marca sin-codigo un porcentaje que Tango no tiene', () => {
    const r = resolverAlicuotas({ porciva1: '5', impiva1: '500,00' }, CPA14)
    expect(r[0].estado).toBe('sin-codigo')
  })

  it('resuelve con lo aprendido un porcentaje que Tango no tiene', () => {
    const r = resolverAlicuotas({ porciva1: '5', impiva1: '500,00' }, CPA14, { '5': '4' })
    expect(r[0].estado).toBe('registra')
    expect(r[0].alicuota?.codigo).toBe(4)
  })

  it('lee el porcentaje con coma decimal', () => {
    const r = resolverAlicuotas({ porciva1: '10,5', impiva1: '100,00' }, CPA14)
    expect(r[0].alicuota?.codigo).toBe(3)
  })
})

describe('correccion manual del codigo', () => {
  it('el codigo elegido a mano gana sobre el que resuelve el porcentaje', () => {
    // El caso real: el 3% resuelve al 16 por norma, pero el operador
    // necesita el 15 ("PERCEPCION R.G.3337") para este comprobante puntual.
    const r = resolverAlicuotas(
      { porciva1: '3', impiva1: '1.000,00', codiva1: '15' },
      CPA14,
    )
    expect(r[0].estado).toBe('registra')
    expect(r[0].alicuota?.codigo).toBe(15)
  })

  it('gana tambien sobre la regla del 0%, que si no se omitiria', () => {
    const r = resolverAlicuotas(
      { porciva1: '0', impiva1: '1.000,00', codiva1: '2' },
      CPA14,
    )
    expect(r[0].estado).toBe('registra')
    expect(r[0].alicuota?.codigo).toBe(2)
  })

  it('rescata una fila que sin correccion quedaria sin codigo', () => {
    const r = resolverAlicuotas(
      { porciva1: '7', impiva1: '500,00', codiva1: '1' },
      CPA14,
    )
    expect(r[0].estado).toBe('registra')
  })

  it('un codigo corregido que no existe en Tango queda sin-codigo', () => {
    const r = resolverAlicuotas(
      { porciva1: '21', impiva1: '500,00', codiva1: '999' },
      CPA14,
    )
    expect(r[0].estado).toBe('sin-codigo')
  })
})

describe('validarAlicuotas', () => {
  it('ok sin alicuotas', () => {
    expect(validarAlicuotas([]).estado).toBe('ok')
  })

  it('ok mostrando el codigo y la descripcion de cada una', () => {
    const r = validarAlicuotas(
      resolverAlicuotas(
        { porciva1: '21', impiva1: '9.134,65', porciva2: '3', impiva2: '1.304,95' },
        CPA14,
      ),
    )
    expect(r.estado).toBe('ok')
    expect(r.mensaje).toContain('IVA 21%')
    expect(r.mensaje).toContain('cód. 1')
    expect(r.mensaje).toContain('PERCEP. DE IVA')
    expect(r.mensaje).toContain('cód. 16')
  })

  it('advierte que la 0% no se registra, sin bloquear', () => {
    const r = validarAlicuotas(
      resolverAlicuotas(
        { porciva1: '21', impiva1: '9.134,65', porciva2: '0', impiva2: '500,00' },
        CPA14,
      ),
    )
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('no se registra')
    // Sigue diciendo que la 21% si se graba: el operador tiene que ver las dos cosas.
    expect(r.mensaje).toContain('IVA 21%')
  })

  it('bloquea si el porcentaje no existe en Tango', () => {
    const r = validarAlicuotas(resolverAlicuotas({ porciva1: '5', impiva1: '500,00' }, CPA14))
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('5%')
  })

  it('formatea el porcentaje con coma, como lo escribe el operador', () => {
    const r = validarAlicuotas(resolverAlicuotas({ porciva1: '7', impiva1: '10,00' }, CPA14))
    expect(r.mensaje).toContain('7%')
    const conDecimal = validarAlicuotas(
      resolverAlicuotas({ porciva1: '2,5', impiva1: '10,00' }, CPA14),
    )
    expect(conDecimal.mensaje).toContain('2,5%')
  })
})

describe('linea sin porcentaje impreso', () => {
  // Caso real (Banco Macro, resumen NaranjaX/VISA): "Percepción IVA RG 2408"
  // trae un importe ($ 147.092,39) pero ningun porcentaje en ningun lado
  // del PDF -- a diferencia de las alicuotas reales, que si imprimen
  // "Tasa 21,00%"/"Tasa 10,50%". Antes del fix esto caia en la regla del
  // 0% (parsearImporte('') tambien da 0) y quedaba omitida del registro.
  it('sin porcentaje pero con importe, resuelve directo al codigo preferido (16)', () => {
    const r = resolverAlicuotas({ porciva3: undefined, impiva3: '147.092,39' }, CPA14)
    expect(r).toHaveLength(1)
    expect(r[0].estado).toBe('registra')
    expect(r[0].alicuota?.codigo).toBe(16)
    // El porcentaje que se graba es el que Tango define para el 16 (3%),
    // no un 0% inventado.
    expect(r[0].porcentaje).toBe(3)
  })

  it('un string vacio de porcentaje se trata igual que ausente', () => {
    const r = resolverAlicuotas({ porciva1: '', impiva1: '500,00' }, CPA14)
    expect(r[0].estado).toBe('registra')
    expect(r[0].alicuota?.codigo).toBe(16)
  })

  it('la correccion manual sigue ganando aunque no haya porcentaje', () => {
    const r = resolverAlicuotas(
      { porciva1: undefined, impiva1: '500,00', codiva1: '17' },
      CPA14,
    )
    expect(r[0].estado).toBe('registra')
    expect(r[0].alicuota?.codigo).toBe(17)
  })

  it('un "0" explicito sigue siendo 0% real, distinto de sin dato', () => {
    // No hay que confundir el fix: "0" (texto) sigue omitiendose, solo lo
    // ausente (undefined/'') cae en el codigo preferido.
    const r = resolverAlicuotas({ porciva1: '0', impiva1: '500,00' }, CPA14)
    expect(r[0].estado).toBe('omitida')
  })
})

describe('lineas con importe en cero', () => {
  it('no genera linea para una alicuota con importe 0, aunque tenga porcentaje', () => {
    // Caso real (MAKRO, factura A 00004894): el comprobante imprime
    // "PERC IVA RG 2408  1,50%  0,00". La tasa figura pero no se cobro
    // nada. Esa linea no se graba, y por lo tanto no es un problema a
    // resolver: antes salia en rojo como "Sin codigo en Tango".
    const lineas = resolverAlicuotas(
      {
        porciva1: '21,00',
        impiva1: '34.442,97',
        porciva2: '3,00',
        impiva2: '4.920,42',
        porciva3: '1,50',
        impiva3: '0,00',
      },
      CPA14,
    )

    expect(lineas.map((l) => l.slot)).toEqual([1, 2])
    expect(lineas.some((l) => l.estado === 'sin-codigo')).toBe(false)
  })

  it('tampoco la genera si el porcentaje no existe en Tango', () => {
    // Sin importe no importa que el porcentaje sea irreconocible: no hay
    // nada que resolver.
    const lineas = resolverAlicuotas({ porciva1: '7,25', impiva1: '0,00' }, CPA14)
    expect(lineas).toEqual([])
  })

  it('la correccion manual no revive una linea sin importe', () => {
    const lineas = resolverAlicuotas(
      { porciva1: '1,50', impiva1: '0,00', codiva1: '15' },
      CPA14,
    )
    expect(lineas).toEqual([])
  })
})

describe('aprendizaje de IVA por rotulo', () => {
  // Las lineas que no imprimen porcentaje llevan su rotulo en porcivaN, y es
  // lo unico que dice a que alicuota van. Viene de la planilla de imputacion
  // del usuario (2026-09-10): "IVA S/ARANCEL + COSTO FINANCIERO" va al 1 y
  // "Retencion IVA" al 17, y ninguna de las dos se deduce de nada.
  const CPA14 = [
    { codigo: 1, porcentaje: 21, descripcion: 'IVA 21%' },
    { codigo: 3, porcentaje: 10.5, descripcion: 'IVA 10,5%' },
    { codigo: 16, porcentaje: 3, descripcion: 'PERCEP. DE IVA' },
    { codigo: 17, porcentaje: 0, descripcion: 'RETENCION IVA' },
  ]

  it('distingue un porcentaje de un rotulo', () => {
    expect(esPorcentaje('21')).toBe(true)
    expect(esPorcentaje('21,00')).toBe(true)
    expect(esPorcentaje('10,50 %')).toBe(true)
    expect(esPorcentaje('')).toBe(false)
    expect(esPorcentaje('Retención IVA')).toBe(false)
    // El caso que obliga a mirar la forma y no a parsear: parsearImporte le
    // saca un numero, pero es un rotulo.
    expect(esPorcentaje('IVA 21% DEC 879')).toBe(false)
  })

  it('la clave es el numero cuando es porcentaje y el texto cuando es rotulo', () => {
    expect(claveAprendidaIva('21,00')).toBe('21')
    expect(claveAprendidaIva('21.0')).toBe('21')
    expect(claveAprendidaIva('Retención IVA')).toBe('retencion iva')
  })

  it('resuelve una linea sin porcentaje por el rotulo aprendido', () => {
    const r = resolverAlicuotas(
      { porciva1: 'IVA S/ARANCEL + COSTO FINANCIERO', impiva1: '1.000,00' },
      CPA14,
      { 'iva s/arancel + costo financiero': '1' },
    )
    expect(r[0].estado).toBe('registra')
    expect(r[0].alicuota?.codigo).toBe(1)
  })

  it('permite llegar al 17, que ninguna regla resuelve sola', () => {
    const r = resolverAlicuotas(
      { porciva1: 'Retención IVA', impiva1: '500,00' },
      CPA14,
      { 'retencion iva': '17' },
    )
    expect(r[0].alicuota?.codigo).toBe(17)
  })

  it('sin nada aprendido, un rotulo cae al codigo preferido como antes', () => {
    const r = resolverAlicuotas({ porciva1: 'Retención IVA', impiva1: '500,00' }, CPA14)
    expect(r[0].alicuota?.codigo).toBe(CODIGO_IVA_PREFERIDO)
  })

  it('la correccion del operador gana sobre lo aprendido', () => {
    const r = resolverAlicuotas(
      { porciva1: 'Retención IVA', impiva1: '500,00', codiva1: '3' },
      CPA14,
      { 'retencion iva': '17' },
    )
    expect(r[0].alicuota?.codigo).toBe(3)
  })

  it('lo aprendido gana sobre el porcentaje impreso', () => {
    // Misma precedencia que en percepciones y varios: lo que el operador
    // enseño para ESE proveedor es mas especifico que la regla general.
    const r = resolverAlicuotas({ porciva1: '21', impiva1: '500,00' }, CPA14, { '21': '3' })
    expect(r[0].alicuota?.codigo).toBe(3)
  })
})
