import { describe, it, expect } from 'vitest'
import {
  JURISDICCIONES_IIBB,
  resolverPercepcionIibb,
  resolverIibbPorTipo,
} from '@/lib/percepcionIibb'

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

  it('lo aprendido GANA sobre una jurisdiccion que resuelve por alias', () => {
    // Cambio del 2026-09-09, pedido del usuario. Antes ganaba el alias y la
    // correccion del operador se guardaba sin aplicarse nunca: era el caso
    // mas comun, porque el rotulo casi siempre resuelve por alias.
    expect(resolverPercepcionIibb('Tucumán', { tucuman: '61' })?.codigo).toBe('61')
  })

  it('sin nada aprendido, la lista fija sigue resolviendo sola', () => {
    // El argumento con el que lo aprendido iba ultimo: una jurisdiccion real
    // no puede depender de que alguien la haya enseñado. Sigue valiendo.
    expect(resolverPercepcionIibb('Tucumán')?.codigo).toBe('60')
    expect(resolverPercepcionIibb('Tucumán', { salta: '61' })?.codigo).toBe('60')
  })

  it('aprende tambien un codigo que no es una de las cinco jurisdicciones', () => {
    // Desde que se pueden elegir todos los codigos de CPA14, lo aprendido
    // puede ser uno que no es jurisdiccion. Sin el maestro no habia donde
    // buscarlo y la fila aprendida quedaba muerta -- paso de verdad con
    // "bancarias" -> 63 del proveedor 010108.
    const cpa14 = [{ codigo: 63, descripcion: 'RET IIBB TUCUMAN' }]
    const r = resolverPercepcionIibb('Bancarias', { bancarias: '63' }, cpa14)
    expect(r?.codigo).toBe('63')
    expect(r?.jurisdiccion).toBe('RET IIBB TUCUMAN')
  })

  it('sin el maestro, un codigo aprendido fuera de las cinco cae a la lista fija', () => {
    // "Bancarias" resuelve por alias al 64, asi que degrada a eso en vez de
    // quedar sin codigo: es lo que corresponde, no un fallo.
    expect(resolverPercepcionIibb('Bancarias', { bancarias: '63' })?.codigo).toBe('64')
    // Un rotulo sin alias si queda sin resolver.
    expect(resolverPercepcionIibb('Córdoba', { cordoba: '63' })).toBeNull()
  })

  it('sin aprendizaje para ese texto, sigue devolviendo null', () => {
    expect(resolverPercepcionIibb('Córdoba', { 'santa fe': '62' })).toBeNull()
  })
})

describe('resolverIibbPorTipo', () => {
  // Los codigos no-IVA de CPA14 que hacen falta para estos casos.
  const CPA14 = [
    { codigo: 60, descripcion: 'PERCEPCION IIBB TUC' },
    { codigo: 63, descripcion: 'RET IIBB TUCUMAN' },
    { codigo: 64, descripcion: 'RET IIBB BANCARIOS' },
  ]

  it('en conceptos y articulos manda la jurisdiccion leida', () => {
    expect(resolverIibbPorTipo('Tucumán', 'conceptos')?.codigo).toBe('60')
    expect(resolverIibbPorTipo('CABA', 'articulos')?.codigo).toBe('62')
  })

  it('en tarjeta todo IIBB va al 64, diga lo que diga la jurisdiccion', () => {
    expect(resolverIibbPorTipo('Tucumán', 'tarjeta')?.codigo).toBe('64')
    expect(resolverIibbPorTipo('Salta', 'tarjeta')?.codigo).toBe('64')
  })

  it('en tarjeta SIRCREB conserva el suyo', () => {
    expect(resolverIibbPorTipo('Ret. IIBB SIRCREB', 'tarjeta')?.codigo).toBe('66')
  })

  it('lo aprendido GANA sobre la regla de tarjeta', () => {
    // El pedido del usuario (2026-09-10): que la correccion se recuerde,
    // igual que ya pasaba con las alicuotas. Antes la regla del 64 pisaba
    // tambien lo aprendido, y como casi todas las percepciones que el
    // operador corrige vienen de resumenes de tarjeta, el aprendizaje no
    // servia para nada: las tres filas que habia en PHF_ALICUOTA_PROVEEDOR
    // eran de tarjeta y ninguna se aplicaba.
    expect(resolverIibbPorTipo('Tucumán', 'tarjeta', { tucuman: '60' }, CPA14)?.codigo).toBe('60')
  })

  it('lo aprendido gana aunque sea un codigo que no es jurisdiccion', () => {
    const r = resolverIibbPorTipo('Bancarias', 'tarjeta', { bancarias: '63' }, CPA14)
    expect(r?.codigo).toBe('63')
    expect(r?.jurisdiccion).toBe('RET IIBB TUCUMAN')
  })

  it('sin nada aprendido, la regla de tarjeta sigue mandando', () => {
    expect(resolverIibbPorTipo('Tucumán', 'tarjeta', { salta: '61' }, CPA14)?.codigo).toBe('64')
  })
})
