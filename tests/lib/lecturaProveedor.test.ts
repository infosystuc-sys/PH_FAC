import { describe, it, expect } from 'vitest'
import { deducirRegla, debeReemplazar, esEscalaLectura } from '@/lib/lecturaProveedor'

// Los codigos reales de los dos casos que motivaron esto, normalizados como
// los guarda normalizarCodigo: los BASE que el proveedor imprime cuando la
// lectura se queda corta, y las VARIANTES que quedan cuando sale bien.
const EVIDENCIA = {
  bases: new Set(['1261095', '1261096', '167686']),
  variantes: new Set(['1261095140', '1261096750', '167686001L']),
}

describe('deducirRegla', () => {
  it('deduce el desglose por talle cuando el renglon lo trae', () => {
    const r = deducirRegla(
      [{ codigo: '167686', descripcion: 'SHORT CORE RUN L : 6 M : 4 S : 2 XL : 4' }],
      EVIDENCIA,
    )
    expect(r).toBe('desglose-talle')
  })

  it('deduce la columna de color cuando el codigo impreso es un articulo base', () => {
    // DASS: imprime 1261095, que en Tango es el base de 1261095140.
    const r = deducirRegla(
      [{ codigo: '1261095', descripcion: 'CAP UNISEX FILA F-BOX MARINO' }],
      EVIDENCIA,
    )
    expect(r).toBe('columna-color')
  })

  it('el desglose por talle gana sobre el codigo base', () => {
    // Si hay desglose, el sufijo es el talle aunque el codigo sea base.
    const r = deducirRegla(
      [{ codigo: '167686', descripcion: 'SHORT L : 6 M : 4 S : 2 XL : 4' }],
      EVIDENCIA,
    )
    expect(r).toBe('desglose-talle')
  })

  it('sin evidencia no deduce nada, y en particular no deduce "ninguna"', () => {
    // Que esta factura no traiga escala no dice nada de la siguiente.
    const r = deducirRegla(
      [{ codigo: '106037', descripcion: 'HELADERA MIDEA 340LT INVER' }],
      EVIDENCIA,
    )
    expect(r).toBeNull()
  })

  it('deduce la columna de color cuando la lectura ACERTO juntando dos partes', () => {
    // Con el prompt v15 el codigo ya viene armado ("1261095 140"). Si la
    // regla solo se dedujera del fallo, el dia que la lectura empieza a
    // salir bien dejaria de aprenderse para siempre.
    const r = deducirRegla(
      [{ codigo: '1261095 140', descripcion: 'CAP UNISEX FILA F-BOX MARINO' }],
      EVIDENCIA,
    )
    expect(r).toBe('columna-color')
  })

  it('una variante impresa de una sola pieza no es evidencia de nada', () => {
    // Si el proveedor ya imprime el codigo completo, no hay regla que
    // aprender: no reparte nada en columnas.
    const r = deducirRegla(
      [{ codigo: '1261095140', descripcion: 'CAP UNISEX FILA F-BOX MARINO' }],
      EVIDENCIA,
    )
    expect(r).toBeNull()
  })

  it('no deduce nada de una factura sin renglones', () => {
    expect(deducirRegla([], EVIDENCIA)).toBeNull()
  })

  it('ignora los codigos vacios', () => {
    expect(deducirRegla([{ codigo: '', descripcion: 'SEGURO-FLETES' }], EVIDENCIA)).toBeNull()
    expect(deducirRegla([{ codigo: null, descripcion: null }], EVIDENCIA)).toBeNull()
  })
})

describe('debeReemplazar', () => {
  const auto = { codProvee: '1', escala: 'columna-color' as const, comprobantes: 3, manual: false }
  const manual = { codProvee: '1', escala: 'ninguna' as const, comprobantes: 1, manual: true }

  it('sin regla guardada, cualquier cosa entra', () => {
    expect(debeReemplazar(null, 'columna-color', false)).toBe(true)
  })

  it('una automatica distinta reemplaza a una automatica', () => {
    expect(debeReemplazar(auto, 'desglose-talle', false)).toBe(true)
  })

  it('la misma regla no se reescribe', () => {
    expect(debeReemplazar(auto, 'columna-color', false)).toBe(false)
  })

  it('lo automatico no pisa lo que eligio el operador', () => {
    expect(debeReemplazar(manual, 'columna-color', false)).toBe(false)
  })

  it('el operador si pisa lo del operador', () => {
    expect(debeReemplazar(manual, 'columna-color', true)).toBe(true)
  })
})

describe('esEscalaLectura', () => {
  it('acepta las tres y rechaza cualquier otra cosa', () => {
    expect(esEscalaLectura('columna-color')).toBe(true)
    expect(esEscalaLectura('desglose-talle')).toBe(true)
    expect(esEscalaLectura('ninguna')).toBe(true)
    expect(esEscalaLectura('otra')).toBe(false)
    expect(esEscalaLectura(null)).toBe(false)
  })
})
