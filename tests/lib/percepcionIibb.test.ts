import { describe, it, expect } from 'vitest'
import { JURISDICCIONES_IIBB, resolverPercepcionIibb } from '@/lib/percepcionIibb'

describe('JURISDICCIONES_IIBB', () => {
  it('son exactamente los cinco codigos que fija la norma de registracion', () => {
    expect(JURISDICCIONES_IIBB.map((j) => j.codigo).sort()).toEqual([
      '60', '61', '62', '64', '66',
    ])
  })

  it('el 66 (SIRCREB) va antes que el 64, que se define por descarte', () => {
    const codigos = JURISDICCIONES_IIBB.map((j) => j.codigo)
    expect(codigos.indexOf('66')).toBeLessThan(codigos.indexOf('64'))
  })
})

describe('resolverPercepcionIibb', () => {
  it('resuelve la jurisdiccion escrita tal cual', () => {
    expect(resolverPercepcionIibb('Tucumán')?.codigo).toBe('60')
    expect(resolverPercepcionIibb('Salta')?.codigo).toBe('61')
    expect(resolverPercepcionIibb('CABA')?.codigo).toBe('62')
  })

  it('ignora acentos y mayusculas', () => {
    expect(resolverPercepcionIibb('TUCUMAN')?.codigo).toBe('60')
    expect(resolverPercepcionIibb('tucuman')?.codigo).toBe('60')
  })

  it('la encuentra dentro del texto completo de la linea del comprobante', () => {
    expect(resolverPercepcionIibb('Perc. IIBB Tucumán RG 22/18')?.codigo).toBe('60')
    expect(resolverPercepcionIibb('Percepción Ingresos Brutos SALTA')?.codigo).toBe('61')
    expect(resolverPercepcionIibb('IIBB Ciudad Autónoma de Buenos Aires')?.codigo).toBe('62')
  })

  it('SIRCREB gana sobre bancaria, porque tambien es bancaria', () => {
    // Sin la precedencia, "Ret. IIBB SIRCREB bancaria" caeria en el 64.
    expect(resolverPercepcionIibb('Ret. IIBB SIRCREB bancaria')?.codigo).toBe('66')
    expect(resolverPercepcionIibb('SIRCREB')?.codigo).toBe('66')
  })

  it('resuelve las bancarias que no mencionan SIRCREB', () => {
    expect(resolverPercepcionIibb('Retención IIBB bancaria')?.codigo).toBe('64')
    expect(resolverPercepcionIibb('IIBB bancarios')?.codigo).toBe('64')
  })

  it('acepta el codigo escrito directo', () => {
    expect(resolverPercepcionIibb('60')?.codigo).toBe('60')
    expect(resolverPercepcionIibb('66')?.codigo).toBe('66')
  })

  it('devuelve null si no reconoce la jurisdiccion', () => {
    expect(resolverPercepcionIibb('Córdoba')).toBeNull()
    expect(resolverPercepcionIibb('Santa Fe')).toBeNull()
    expect(resolverPercepcionIibb('')).toBeNull()
    expect(resolverPercepcionIibb(null)).toBeNull()
  })

  it('no resuelve por porcentaje: el 60 y el 61 son ambos 2,5%', () => {
    // El porcentaje no identifica la jurisdiccion, asi que un texto que
    // solo trae el numero no puede resolverse a ningun codigo.
    expect(resolverPercepcionIibb('2,5%')).toBeNull()
  })

  it('usa lo aprendido cuando la jurisdiccion no esta en la lista fija', () => {
    // La clave del mapa va normalizada: sin acentos ni mayusculas, igual
    // que la comparacion contra los alias.
    expect(resolverPercepcionIibb('Córdoba', { cordoba: '62' })?.codigo).toBe('62')
  })

  it('lo aprendido no gana sobre una jurisdiccion que ya resuelve por alias', () => {
    expect(resolverPercepcionIibb('Tucumán', { tucuman: '61' })?.codigo).toBe('60')
  })

  it('sin aprendizaje para ese texto, sigue devolviendo null', () => {
    expect(resolverPercepcionIibb('Córdoba', { 'santa fe': '62' })).toBeNull()
  })
})
