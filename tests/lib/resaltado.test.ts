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

  // El minimo general de 2 no alcanza para valores puramente numericos.
  // porciva1 real: "21.0" (alicuota IVA) normaliza a "210" -- tres digitos
  // que aparecen por pura coincidencia dentro de cualquier importe del
  // bloque de totales. Con un documento lleno de numeros (importes, CUIT,
  // fechas, CAE) la probabilidad de choque de una secuencia corta de
  // digitos es mucho mas alta que la de una secuencia alfabetica de la
  // misma longitud (10 digitos posibles contra 26 letras), asi que los
  // valores numericos necesitan un piso mas alto.
  it('no matchea una alicuota corta como "21.0" contra un importe que la contiene por casualidad', () => {
    expect(coincide('Importe: 1.210,50', '21.0')).toBe(false)
  })

  it('el minimo mas alto para numeros no rompe importes de 4 digitos o mas', () => {
    expect(coincide('Cotización: 1,0000', '10.00')).toBe(true)
  })

  it('para texto (no numerico) el minimo general de 2 sigue alcanzando', () => {
    expect(coincide('Cond. IVA: RI', 'RI')).toBe(true)
  })
})
