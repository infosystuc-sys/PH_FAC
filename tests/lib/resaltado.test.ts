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

    // Regresion real encontrada por la revision: el span impreso pega el
    // punto de venta y el numero de comprobante con un guion en el medio
    // ("0011-00147868"), no con un espacio al final como el test anterior.
    // La pasada laxa borra ese guion sin dejar rastro y funde los dos
    // numeros en un solo bloque de digitos ("001100147868"), donde "0011"
    // queda pegado al "0" que sigue -- la regla de limite lo rechaza por
    // error. La pasada estricta reemplaza el guion por un centinela no
    // numerico en vez de borrarlo, así que la frontera entre los dos
    // numeros sobrevive.
    it('ptovta real ("0011") matchea contra el span real, con el numero de comprobante pegado por un guion', () => {
      expect(coincide('0011-00147868', '0011')).toBe(true)
    })

    it('nro real ("00147868") matchea contra el mismo span, con el punto de venta pegado por un guion', () => {
      expect(coincide('0011-00147868', '00147868')).toBe(true)
    })

    it('el CUIT con guiones sigue matcheando bajo la regla de limite de numero', () => {
      expect(coincide('CUIT: 30-66328849-7', '30-66328849-7')).toBe(true)
    })

    it('el CUIT con guiones tambien matchea contra un span sin guiones (pasada laxa)', () => {
      expect(coincide('Ing. Brutos: 30663288497', '30-66328849-7')).toBe(true)
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
