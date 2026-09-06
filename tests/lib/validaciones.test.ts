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
  sinCerosDeRelleno,
  validarNetoContraIva,
} from '@/lib/validaciones'
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

