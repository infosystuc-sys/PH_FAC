import { describe, it, expect } from 'vitest'
import { normalizarParaBusqueda, coincide } from '@/lib/resaltado'

describe('normalizarParaBusqueda', () => {
  it('saca acentos, espacios y pasa a minusculas', () => {
    expect(normalizarParaBusqueda('  Razón  Social  ')).toBe('razonsocial')
  })

  it('saca los separadores de un CUIT', () => {
    expect(normalizarParaBusqueda('30-71042636-9')).toBe('30710426369')
  })

  it('deja el importe comparable con o sin separador de miles', () => {
    expect(normalizarParaBusqueda('322.982,28')).toBe('32298228')
  })
})

describe('coincide', () => {
  it('encuentra el CUIT con guiones en un span sin guiones', () => {
    expect(coincide('CUIT 30710426369', '30-71042636-9')).toBe(true)
  })

  it('encuentra el importe con formato distinto', () => {
    expect(coincide('Total: 322982,28', '322.982,28')).toBe(true)
  })

  it('no matchea contra texto vacio', () => {
    expect(coincide('', '123')).toBe(false)
    expect(coincide('123', '')).toBe(false)
  })

  it('no matchea un valor de un solo caracter, que resaltaria medio PDF', () => {
    expect(coincide('un texto cualquiera con a', 'a')).toBe(false)
  })

  // Valores reales del catalogo de campos (src/lib/campos.ts), no
  // inventados: porciva1/porciva2/porciva3 son las alicuotas de IVA,
  // cotizacion es la cotizacion de moneda, ptovta es el punto de venta.
  // Dentro del piso general de MINIMO, ningun otro minimo de longitud
  // separa bien "no resaltar una alicuota corta" de "si resaltar una
  // cotizacion igual de corta" -- la regla que sí los separa es que la
  // coincidencia no puede quedar pegada a otro digito (ver
  // matcheaSinFlanqueoNumerico en resaltado.ts).
  describe('valores numericos: limite de numero, no solo longitud', () => {
    it('porciva1 real ("21.0" -> "210") no matchea dentro de un importe que lo contiene', () => {
      expect(coincide('Importe: 1.210,50', '21.0')).toBe(false)
    })

    it('porciva2 real ("27.0" -> "270") tampoco matchea dentro de un importe que lo contiene', () => {
      expect(coincide('Importe: 1.270,00', '27.0')).toBe(false)
    })

    it('cotizacion real ("1,00" -> "100"), misma longitud que las alicuotas, SI matchea porque es el numero completo', () => {
      expect(coincide('Cotización: 1,00', '1,00')).toBe(true)
    })

    it('punto de venta ("0011") matchea al final de un span sin quedar pegado a otro digito', () => {
      expect(coincide('Punto de Venta: 0011', '0011')).toBe(true)
    })

    it('el CUIT con guiones sigue matcheando bajo la regla de limite de numero', () => {
      expect(coincide('CUIT: 30-66328849-7', '30-66328849-7')).toBe(true)
    })

    it('el total de la factura sigue matcheando bajo la regla de limite de numero', () => {
      expect(coincide('Total a Pagar: $690.983,02', '690.983,02')).toBe(true)
    })

    // Encontrado probando en el navegador contra un comprobante real: sin
    // el piso de MINIMO, porciva3 = "3" (alicuota sin decimales) resaltaba
    // 6 lugares del PDF sin relacion entre si -- "Plan Control 3GB",
    // "3% mensual" de una clausula de interes -- porque un digito suelto
    // no tiene ningun limite de numero que lo salve: aparece libre,
    // rodeado de letras, por todos lados. La regla de limite de numero
    // resuelve la colision con importes largos, pero no la de un digito
    // aislado que es demasiado corto para ser especifico.
    it('un solo digito, como porciva3 = "3", no matchea aunque no este pegado a otro numero', () => {
      expect(coincide('Plan Control 3GB PC92R', '3')).toBe(false)
    })
  })

  it('para texto (no numerico) el minimo general de 2 sigue alcanzando', () => {
    expect(coincide('Cond. IVA: RI', 'RI')).toBe(true)
  })
})
