import { TIPOS_FACTURA } from '@/lib/tipoFactura'
import { describe, it, expect } from 'vitest'
import {
  letraComprobante,
  nComp,
  validarTotales,
  validarCae,
  validarProveedor,
  validarDuplicado,
  validarFormatoNComp,
  validarFecha,
  validarCondCompra,
  validarTipoFactura,
  parsearFechaArg,
  normalizarFechaArg,
  sinCerosDeRelleno,
  validarNetoContraIva,
  validarCantidadesOc,
  validarCodigosRepetidos,
  validarLeyenda,
  validarRenglonesContraNeto,
  validarPreciosContraOc,
} from '@/lib/validaciones'
import { resolverDescuentoGlobal } from '@/lib/descuentoGlobal'
import type { LineaAlicuota } from '@/lib/alicuotas'

describe('letraComprobante', () => {
  it('reconoce la letra al final de "FAC A"', () => {
    expect(letraComprobante('FAC A')).toBe('A')
  })
  it('reconoce la letra en "FACTURA A 0011-00063576"', () => {
    expect(letraComprobante('FACTURA A 0011-00063576')).toBe('A')
  })
  it('reconoce la letra sola', () => {
    expect(letraComprobante('C')).toBe('C')
  })
  it('es insensible a mayusculas/minusculas', () => {
    expect(letraComprobante('factura b')).toBe('B')
  })
  it('devuelve null si no encuentra ninguna letra de comprobante valida', () => {
    expect(letraComprobante('Factura electronica')).toBe(null)
    expect(letraComprobante('')).toBe(null)
  })
})

describe('nComp', () => {
  it('arma el N_COMP con padding de 5 y 8 digitos', () => {
    expect(nComp('A', '0011', '63576')).toBe('A0011800063576'.slice(0, 1) + '00011' + '00063576')
  })
  it('no trunca si ptovta o nro ya vienen mas largos que el padding', () => {
    expect(nComp('A', '123456', '123456789')).toBe('A123456123456789')
  })
})

describe('validarProveedor', () => {
  it('ok con exactamente un match', () => {
    expect(validarProveedor(1)).toEqual({ estado: 'ok', mensaje: 'Proveedor resuelto.' })
  })
  it('error sin ningun match', () => {
    const r = validarProveedor(0)
    expect(r.estado).toBe('error')
  })
  it('error con mas de un match', () => {
    const r = validarProveedor(3)
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('3')
  })
})

describe('validarDuplicado', () => {
  it('ok si no hay duplicado', () => {
    expect(validarDuplicado(false, null)).toEqual({ estado: 'ok', mensaje: 'Sin duplicados.' })
  })
  it('error con la referencia si hay duplicado', () => {
    const r = validarDuplicado(true, 'comprobante interno 16591')
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('16591')
  })
})

describe('validarTotales', () => {
  it('ok si totalImputado coincide con el total leido (tolerancia de un centavo)', () => {
    const v = { neto: '529.947,50', porciva1: '21.0', impiva1: '39.190,99',
      porciva2: '27.0', impiva2: '92.697,41', porciva3: '3', impiva3: '15.898,43',
      imppercep1: '13.248,69', total: '690.983,02' }
    expect(validarTotales(v).estado).toBe('ok')
  })
  it('advertencia con la diferencia exacta si no coinciden', () => {
    const v = { neto: '100.000,00', total: '112.480,00' }
    const r = validarTotales(v)
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('12.480,00')
  })

  it('en tarjeta siempre ok con el total imputado, ignora el importe leido', () => {
    // El total impreso de un resumen de tarjeta sale por diferencia y no es
    // confiable -- el chequeo no lo compara, muestra directamente lo que se
    // va a grabar.
    const v = { neto: '10.000,00', porciva1: '21', impiva1: '2.100,00', total: '999.999,99' }
    const r = validarTotales(v, 'tarjeta')
    expect(r.estado).toBe('ok')
    expect(r.mensaje).toContain('12.100,00')
    expect(r.mensaje).not.toContain('999.999,99')
  })
})

describe('validarCae', () => {
  const hoy = new Date('2026-08-07T00:00:00')

  it('ok con CAE de 14 digitos y vencimiento futuro', () => {
    expect(validarCae('76123456789012', '31/12/2026', hoy)).toEqual({ estado: 'ok', mensaje: 'CAE válido.' })
  })
  it('advertencia si el CAE no tiene 14 digitos', () => {
    const r = validarCae('123', '31/12/2026', hoy)
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('formato')
  })
  it('advertencia si el CAE vencio', () => {
    const r = validarCae('76123456789012', '01/01/2026', hoy)
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('vencido')
  })
  it('advertencia si no hay CAE', () => {
    expect(validarCae('', '', hoy).estado).toBe('advertencia')
  })
})

describe('validarFormatoNComp', () => {
  it('ok si ptovta tiene hasta 5 digitos y nro hasta 8', () => {
    expect(validarFormatoNComp('0011', '63576').estado).toBe('ok')
    expect(validarFormatoNComp('11', '576').estado).toBe('ok')
  })
  it('error si ptovta supera 5 digitos', () => {
    const r = validarFormatoNComp('123456', '576')
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('punto de venta')
  })
  it('error si nro supera 8 digitos', () => {
    const r = validarFormatoNComp('0011', '123456789')
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('número')
  })
  it('error si ptovta o nro no son numericos', () => {
    expect(validarFormatoNComp('AB11', '576').estado).toBe('error')
    expect(validarFormatoNComp('0011', 'X576').estado).toBe('error')
  })
  it('error si falta ptovta o nro', () => {
    expect(validarFormatoNComp(null, '576').estado).toBe('error')
    expect(validarFormatoNComp('0011', undefined).estado).toBe('error')
  })
})

describe('parsearFechaArg', () => {
  it('acepta barra, punto y guion como separador', () => {
    expect(parsearFechaArg('30/07/2026')).toEqual(new Date(2026, 6, 30))
    expect(parsearFechaArg('30.07.2026')).toEqual(new Date(2026, 6, 30))
    expect(parsearFechaArg('30-07-2026')).toEqual(new Date(2026, 6, 30))
  })
  it('rechaza un mes o dia fuera de rango', () => {
    expect(parsearFechaArg('32/07/2026')).toBeNull()
    expect(parsearFechaArg('30/13/2026')).toBeNull()
  })
  it('rechaza un dia que no existe en ese mes en vez de reindexar al siguiente', () => {
    // 31 de febrero: new Date(2026,1,31) reindexaria a marzo si no se
    // detectara -- este es justo el caso que rompia en silencio antes.
    expect(parsearFechaArg('31/02/2026')).toBeNull()
  })
  it('rechaza vacio o formato irreconocible', () => {
    expect(parsearFechaArg('')).toBeNull()
    expect(parsearFechaArg('30 de julio de 2026')).toBeNull()
  })
  it('acepta dia y mes de un solo digito', () => {
    // C C AGRO imprime "16/9/2026" (2026-09-16). Antes se rechazaba como
    // ilegible y el comprobante no se podia confirmar.
    expect(parsearFechaArg('16/9/2026')).toEqual(new Date(2026, 8, 16))
    expect(parsearFechaArg('1/6/2026')).toEqual(new Date(2026, 5, 1))
    expect(parsearFechaArg('1.6.2026')).toEqual(new Date(2026, 5, 1))
  })
  it('acepta el año de dos digitos como 20aa', () => {
    // Hay proveedores que imprimen "26" por 2026 (2026-09-16, pedido del
    // usuario). No hay ambiguedad real: por esta app no entra ningun
    // comprobante del siglo pasado.
    expect(parsearFechaArg('16/09/26')).toEqual(new Date(2026, 8, 16))
    expect(parsearFechaArg('1/6/26')).toEqual(new Date(2026, 5, 1))
    // Tres digitos no es ninguna de las dos formas.
    expect(parsearFechaArg('16/09/026')).toBeNull()
  })
})

describe('normalizarFechaArg', () => {
  it('deja la fecha en dd/mm/aaaa, venga como venga', () => {
    expect(normalizarFechaArg('16/9/2026')).toBe('16/09/2026')
    expect(normalizarFechaArg('1.6.2026')).toBe('01/06/2026')
    expect(normalizarFechaArg('30-07-2026')).toBe('30/07/2026')
    expect(normalizarFechaArg(' 30/07/2026 ')).toBe('30/07/2026')
    expect(normalizarFechaArg('16/9/26')).toBe('16/09/2026')
  })
  it('devuelve null si no se puede leer, para no pisar lo que vino', () => {
    expect(normalizarFechaArg('30 de julio')).toBeNull()
    expect(normalizarFechaArg(null)).toBeNull()
  })
})

describe('validarFecha', () => {
  it('ok con una fecha valida, cualquiera de los tres separadores', () => {
    expect(validarFecha('30/07/2026').estado).toBe('ok')
    expect(validarFecha('30.07.2026').estado).toBe('ok')
  })
  it('error si falta o no se puede interpretar', () => {
    expect(validarFecha(null).estado).toBe('error')
    expect(validarFecha('').estado).toBe('error')
    expect(validarFecha('30 de julio').estado).toBe('error')
  })
})

describe('validarCondCompra', () => {
  it('ok si tiene un valor', () => {
    expect(validarCondCompra('60').estado).toBe('ok')
  })
  it('error si esta vacio o ausente', () => {
    expect(validarCondCompra('').estado).toBe('error')
    expect(validarCondCompra(null).estado).toBe('error')
    expect(validarCondCompra(undefined).estado).toBe('error')
  })
})

describe('validarTipoFactura', () => {
  it('ok si es "conceptos" o "articulos"', () => {
    expect(validarTipoFactura('conceptos').estado).toBe('ok')
    expect(validarTipoFactura('articulos').estado).toBe('ok')
  })
  it('error si esta vacio o ausente', () => {
    expect(validarTipoFactura('').estado).toBe('error')
    expect(validarTipoFactura(null).estado).toBe('error')
    expect(validarTipoFactura(undefined).estado).toBe('error')
  })
  it('acepta los tres tipos del catalogo', () => {
    // 'tarjeta' estuvo bloqueado mientras no tenia logica de registro. Ya
    // la tiene: se imputa al concepto fijo de comisiones (ver
    // COD_CONCEPTO_TARJETA), asi que el bloqueo se saco.
    for (const t of TIPOS_FACTURA) {
      expect(validarTipoFactura(t.clave).estado, t.clave).toBe('ok')
    }
  })
})

describe('numeros rellenados con ceros', () => {
  // Los resumenes de Banco Macro, BBVA, Galicia y Ciudad imprimen el numero
  // a 12 digitos ("000020984549") y Tango lo guarda a 8. Antes esos 13
  // comprobantes quedaban bloqueados por "el numero tiene 12 digitos, el
  // maximo son 8" pese a que el numero entra: era relleno, no dato.
  it('nComp saca el relleno y vuelve a padear a los 8 de Tango', () => {
    expect(nComp('A', '00001', '000020984549')).toBe('A0000120984549')
    // El mismo numero sin relleno da identico: es la prueba de que la
    // normalizacion no cambia el N_COMP, solo tolera como viene escrito.
    expect(nComp('A', '00001', '20984549')).toBe(nComp('A', '00001', '000020984549'))
  })

  it('valida contra el largo sin relleno', () => {
    expect(validarFormatoNComp('00001', '000020984549').estado).toBe('ok')
    expect(validarFormatoNComp('00001', '000000886327').estado).toBe('ok')
  })

  it('sigue rechazando un numero que de verdad no entra', () => {
    // Nueve digitos significativos no son relleno: no hay forma de meterlos
    // en los 8 de CPA04 sin perder informacion.
    const r = validarFormatoNComp('00001', '000123456789')
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('9 dígitos')
  })

  it('no se come un numero que es todo ceros', () => {
    expect(sinCerosDeRelleno('0000')).toBe('0')
    expect(nComp('A', '00001', '0000')).toBe('A0000100000000')
  })
})

describe('validarNetoContraIva', () => {
  const IVA_21 = { codigo: 1, porcentaje: 21, descripcion: 'IVA 21%' }
  const PERCEP_3 = { codigo: 15, porcentaje: 3, descripcion: 'PERCEPCION R.G.3337' }

  function linea(porcentaje: number, importe: number, alicuota = IVA_21): LineaAlicuota {
    return { slot: 1, porcentaje, importe, estado: 'registra', alicuota }
  }

  it('cierra cuando el neto es el que implica el IVA', () => {
    // VALLE FERTIL real: IVA 914,74 al 21% -> base 4.355,90.
    expect(validarNetoContraIva([linea(21, 914.74)], '4355,94', 'tarjeta').estado).toBe('ok')
  })

  it('detecta el cargo faltante del caso real que lo motivo', () => {
    // La segunda lectura del mismo PDF devolvio solo el arancel (2.177,97)
    // y se comio la comision, que era del mismo importe.
    const r = validarNetoContraIva([linea(21, 914.74)], '2177,97', 'tarjeta')
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('4.355,90')
  })

  it('tolera el redondeo acumulado de un resumen real', () => {
    // BANCO MACRO: el IVA impreso difiere 13 centavos del 21% exacto del
    // neto impreso, sobre $182.759, porque el resumen calcula el IVA por
    // transaccion y despues suma. No es un error.
    expect(validarNetoContraIva([linea(21, 38379.53)], '182759,80', 'tarjeta').estado).toBe('ok')
  })

  it('no suma a la base una percepcion que viaja en los slots de IVA', () => {
    // El otro error real: una percepcion del 3% leida como alicuota del
    // 21%. Una vez que el operador corrige el codigo a 15, esa linea deja
    // de aportar base y el cotejo cierra -- es su via de salida.
    const conPercepcion = [linea(21, 38379.53), linea(3, 5482.77, PERCEP_3)]
    expect(validarNetoContraIva(conPercepcion, '182759,80', 'tarjeta').estado).toBe('ok')

    // Sin corregir, las dos cuentan como IVA al 21% y no cierra.
    const sinCorregir = [linea(21, 38379.53), linea(21, 5482.77)]
    expect(validarNetoContraIva(sinCorregir, '182759,80', 'tarjeta').estado).toBe('error')
  })

  it('solo bloquea en tarjeta; en los otros tipos avisa', () => {
    // En conceptos y articulos el neto viene impreso, asi que una
    // diferencia es mas probablemente un caso legitimo que un error.
    expect(validarNetoContraIva([linea(21, 914.74)], '1000', 'tarjeta').estado).toBe('error')
    expect(validarNetoContraIva([linea(21, 914.74)], '1000', 'conceptos').estado).toBe('advertencia')
    expect(validarNetoContraIva([linea(21, 914.74)], '1000', 'articulos').estado).toBe('advertencia')
  })

  it('no opina si no hay una linea de IVA con porcentaje e importe', () => {
    expect(validarNetoContraIva([], '1000', 'tarjeta').estado).toBe('ok')
    // Una alicuota del 0% no dice nada de la base (y dividiria por cero).
    const exenta = { codigo: 2, porcentaje: 0, descripcion: 'IVA 0%' }
    expect(validarNetoContraIva([linea(0, 0, exenta)], '1000', 'tarjeta').estado).toBe('ok')
  })

  it('suma las bases de varias alicuotas distintas', () => {
    const dos = [linea(21, 2100), linea(10.5, 1050, { codigo: 3, porcentaje: 10.5, descripcion: 'IVA 10,5%' })]
    // 2100/0,21 = 10.000 y 1050/0,105 = 10.000 -> base total 20.000.
    expect(validarNetoContraIva(dos, '20000', 'tarjeta').estado).toBe('ok')
    expect(validarNetoContraIva(dos, '10000', 'tarjeta').estado).toBe('error')
  })
})


describe('validarCantidadesOc', () => {
  // Pedido del usuario, 2026-09-07. validarCotejoOc ya compara contra el
  // pendiente, pero mira las cantidades que la IA leyo del PDF; esta mira las
  // del renglon que se va a registrar, que dejan de ser lo mismo en cuanto el
  // operador corrige una a mano.
  const renglon = (cantidad: number, pendiente: number | null) => ({
    codigo: '106037',
    cantidad,
    pendiente,
  })

  it('deja pasar lo que entra en lo pendiente', () => {
    expect(validarCantidadesOc('articulos', [renglon(30, 30)]).estado).toBe('ok')
    expect(validarCantidadesOc('articulos', [renglon(10, 30)]).estado).toBe('ok')
  })

  it('bloquea el renglon que factura mas de lo pendiente', () => {
    const r = validarCantidadesOc('articulos', [renglon(31, 30)])
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('106037')
    expect(r.mensaje).toContain('31')
    expect(r.mensaje).toContain('30')
  })

  it('tolera el redondeo, igual que el cotejo', () => {
    // Las cantidades salen de parsear texto y CPA36 es DECIMAL(22,7).
    expect(validarCantidadesOc('articulos', [renglon(30.00001, 30)]).estado).toBe('ok')
  })

  it('nombra todos los renglones excedidos, no solo el primero', () => {
    const r = validarCantidadesOc('articulos', [
      { codigo: 'A', cantidad: 5, pendiente: 2 },
      { codigo: 'B', cantidad: 9, pendiente: 1 },
    ])
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('A')
    expect(r.mensaje).toContain('B')
  })

  it('ignora el renglon sin pendiente congelado: no hay contra que comparar', () => {
    expect(validarCantidadesOc('articulos', [renglon(999, null)]).estado).toBe('ok')
  })

  it('no aplica fuera de articulos', () => {
    expect(validarCantidadesOc('conceptos', [renglon(999, 1)]).estado).toBe('ok')
    expect(validarCantidadesOc('tarjeta', [renglon(999, 1)]).estado).toBe('ok')
  })

  it('sin renglones no bloquea', () => {
    expect(validarCantidadesOc('articulos', []).estado).toBe('ok')
  })
})

describe('validarCodigosRepetidos', () => {
  // Tango no admite dos veces el mismo codigo en un comprobante: CPA18 tiene
  // un indice unico sobre (COD_PROVEE, TCOMP_IN_C, NCOMP_IN_C, COD_IMPUES).
  // El registro las suma en una sola linea, asi que esto AVISA y no bloquea
  // -- decision del usuario, 2026-09-08. Se avisa igual para que el operador
  // pueda darse cuenta si lo que paso es que se le escapo el codigo
  // equivocado en una de las dos lineas.
  const iva = (codigo: number, descripcion: string): LineaAlicuota => ({
    slot: 1,
    porcentaje: 21,
    importe: 100,
    estado: 'registra',
    alicuota: { codigo, porcentaje: 21, descripcion },
  })
  const varios = (codigo: string, descripcion: string) => ({
    slot: 1,
    codigo,
    texto: descripcion,
    importe: 100,
    estado: 'registra' as const,
    descripcion,
  })
  const percep = (codigo: string, jurisdiccion: string) => ({
    slot: 1,
    texto: jurisdiccion,
    importe: 100,
    estado: 'registra' as const,
    codigo: { codigo, jurisdiccion, alias: [], criterio: '' },
  })

  it('deja pasar un comprobante sin codigos repetidos', () => {
    const r = validarCodigosRepetidos(
      [iva(1, 'IVA 21%')],
      [percep('64', 'Bancarias')],
      [varios('40', 'IMP INT'), varios('65', 'PERCEP DEB Y CRED RG')],
    )
    expect(r.estado).toBe('ok')
  })

  it('avisa que dos impuestos varios con el mismo codigo se suman', () => {
    // El caso real: "Impuesto interno a nivel item" e "IDC", los dos al 40.
    const r = validarCodigosRepetidos(
      [],
      [],
      [varios('40', 'IMP INT'), varios('40', 'IMP INT')],
    )
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('40')
    expect(r.mensaje).toContain('2 veces')
  })

  it('cuenta juntas las percepciones IIBB y los varios: van a la misma tabla', () => {
    // El indice unico de CPA18 no distingue de que familia venia la linea.
    const r = validarCodigosRepetidos([], [percep('64', 'Bancarias')], [varios('64', 'RET IIBB BANCARIOS')])
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('64')
  })

  it('avisa tambien de dos slots de IVA con la misma alicuota', () => {
    // No hay indice que lo impida --son columnas, no filas-- pero de los
    // 27.090 comprobantes de CPA04 ni uno repite un COD_IVA entre sus slots.
    const r = validarCodigosRepetidos([iva(1, 'IVA 21%'), iva(1, 'IVA 21%')], [], [])
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('IVA 21%')
  })

  it('no cuenta las lineas que no se registran', () => {
    const omitida: LineaAlicuota = {
      slot: 2, porcentaje: 0, importe: 100, estado: 'omitida', alicuota: null,
    }
    expect(validarCodigosRepetidos([iva(1, 'IVA 21%'), omitida], [], []).estado).toBe('ok')
  })

  it('sin lineas no bloquea', () => {
    expect(validarCodigosRepetidos([], [], []).estado).toBe('ok')
  })
})

describe('validarLeyenda', () => {
  // La observacion va a CPA04.LEYENDA, que es varchar(30), ademas de a los
  // renglones del asiento, donde entra holgada (100). Pedido del usuario,
  // 2026-09-08. Avisa, no bloquea: la factura se registra igual.
  it('sin observacion avisa que la leyenda lleva la condicion de compra', () => {
    const r = validarLeyenda(null)
    expect(r.estado).toBe('ok')
    expect(r.mensaje).toContain('condición de compra')
    expect(validarLeyenda('   ').estado).toBe('ok')
  })

  it('muestra la leyenda que se va a grabar cuando entra entera', () => {
    const r = validarLeyenda('RANGER BLANCA - TC ICBC')
    expect(r.estado).toBe('ok')
    expect(r.mensaje).toContain('RANGER BLANCA - TC ICBC')
  })

  it('acepta justo los 30 caracteres', () => {
    // Es el largo exacto de una observacion ya cargada.
    const treinta = 'RANGER BLANCA - CVDG - TC ICBC'
    expect(treinta).toHaveLength(30)
    expect(validarLeyenda(treinta).estado).toBe('ok')
  })

  it('avisa y muestra el recorte cuando se pasa', () => {
    // El caso real: 32 caracteres, se pierden los dos ultimos.
    const larga = 'TEL.MOVIL-20/7-19/8-AMEX-VTO:9/9'
    expect(larga).toHaveLength(32)
    const r = validarLeyenda(larga)
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('32')
    expect(r.mensaje).toContain('TEL.MOVIL-20/7-19/8-AMEX-VTO:9')
    // Y que se entienda que en el asiento no se pierde nada.
    expect(r.mensaje).toContain('asiento')
  })
})

describe('validarRenglonesContraNeto', () => {
  it('no aplica fuera de articulos', () => {
    expect(validarRenglonesContraNeto('conceptos', null).estado).toBe('ok')
    expect(validarRenglonesContraNeto('tarjeta', null).estado).toBe('ok')
  })

  it('en articulos sin renglones leidos bloquea y pide reprocesar', () => {
    const r = validarRenglonesContraNeto('articulos', null)
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('Reprocesá')
  })

  it('refleja lo que resolvio descuentoGlobal: ok si cierra, error si no', () => {
    const cierra = resolverDescuentoGlobal(
      [{ orden: 1, cantidad: '10', precioUnitario: '9.500,00', subtotal: '74.586,80' }],
      '10.000,00',
      '74.586,80',
    )
    expect(validarRenglonesContraNeto('articulos', cierra).estado).toBe('ok')
    expect(validarRenglonesContraNeto('articulos', cierra).mensaje).toContain('ya está dentro')

    const noCierra = resolverDescuentoGlobal(
      [{ orden: 1, cantidad: '10', precioUnitario: '9.500,00', subtotal: '95.000,00' }],
      null,
      '74.586,80',
    )
    const r = validarRenglonesContraNeto('articulos', noCierra)
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('no cierran')
  })
})

describe('validarPreciosContraOc', () => {
  it('advierte, no bloquea, cuando el precio de la factura no es el de la orden', () => {
    // Decision del usuario (2026-09-15): la factura manda, la OC es referencia.
    const r = validarPreciosContraOc('articulos', [
      { codigo: '18070', precioFactura: 7458.68, precioOc: 7458.68 },
      { codigo: '12640', precioFactura: 81448.76, precioOc: 80000 },
    ])
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('12640')
    expect(r.mensaje).toContain('se registra el de la factura')
    expect(r.mensaje).not.toContain('18070')
  })

  it('ok cuando coinciden, con tolerancia de medio centavo', () => {
    const r = validarPreciosContraOc('articulos', [
      { codigo: '18070', precioFactura: 7458.68, precioOc: 7458.684 },
    ])
    expect(r.estado).toBe('ok')
  })

  it('un renglon sin precio de factura no se compara: eso lo bloquea la otra validacion', () => {
    const r = validarPreciosContraOc('articulos', [{ codigo: 'x', precioFactura: null, precioOc: 10 }])
    expect(r.estado).toBe('ok')
  })

  it('no aplica fuera de articulos', () => {
    expect(validarPreciosContraOc('conceptos', []).estado).toBe('ok')
  })
})
