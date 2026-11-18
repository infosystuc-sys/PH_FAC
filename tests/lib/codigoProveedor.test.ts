import { describe, it, expect } from 'vitest'
import {
  codigoParaSinonimo,
  codigoEnteroConSerie,
  prefijoDeRespaldo,
  restoDelCodigo,
  sinonimoAGuardar,
} from '@/lib/codigoProveedor'

describe('codigoParaSinonimo', () => {
  it('IMSA (010337): busca solo los 8 primeros caracteres, guiones incluidos', () => {
    expect(codigoParaSinonimo('010337', 'MNTD-150AZUL2026')).toBe('MNTD-150')
    expect(codigoParaSinonimo(' 010337 ', '  MNTD-150 AZUL')).toBe('MNTD-150')
  })

  it('un código de IMSA de 8 o menos queda igual', () => {
    expect(codigoParaSinonimo('010337', 'MNTD-150')).toBe('MNTD-150')
    expect(codigoParaSinonimo('010337', 'AB12')).toBe('AB12')
  })

  it('los demás proveedores buscan el código entero', () => {
    expect(codigoParaSinonimo('010685', 'MNTD-150AZUL2026')).toBe('MNTD-150AZUL2026')
    expect(codigoParaSinonimo(null, ' 1261095140 ')).toBe('1261095140')
  })
})

describe('respaldo de NEWSAN (010003)', () => {
  it('propone los 12 primeros solo si el codigo es mas largo', () => {
    expect(prefijoDeRespaldo('010003', 'CUBQU110BASEROJO')).toBe('CUBQU110BASE')
    expect(prefijoDeRespaldo(' 010003 ', ' AS-12UW4RLRCD02 N ')).toBe('AS-12UW4RLRC')
    expect(prefijoDeRespaldo('010003', 'CUBQU110BASE')).toBeNull()
  })

  it('no recorta lo que se busca primero: el entero va antes', () => {
    expect(codigoParaSinonimo('010003', 'CUBQU110BASEROJO')).toBe('CUBQU110BASEROJO')
  })

  it('lo que sigue a los 12 es el color', () => {
    expect(restoDelCodigo('010003', 'CUBQU110BASEROJO')).toBe('ROJO')
    expect(restoDelCodigo('010003', 'CUBQU110BASEAZUL ')).toBe('AZUL')
    expect(restoDelCodigo('010003', 'CUBQU110BASE')).toBe('')
  })

  it('IMSA, con regla propia, no tiene respaldo; ningun otro proveedor tiene color', () => {
    expect(prefijoDeRespaldo('010337', 'MNTD-150AZUL2026')).toBeNull()
    expect(restoDelCodigo(null, 'CUBQU110BASEROJO')).toBe('')
    expect(restoDelCodigo('010685', 'ABCDEFGHIJKLMNOPQ')).toBe('')
  })
})

describe('respaldo general de 15 (los 15 de CPA15.COD_SINONI)', () => {
  it('los demas proveedores comparan los 15 primeros si el codigo es mas largo', () => {
    expect(prefijoDeRespaldo('010685', 'ABCDEFGHIJKLMNOPQ')).toBe('ABCDEFGHIJKLMNO')
    expect(prefijoDeRespaldo('010685', 'ABCDEFGHIJKLMNO')).toBeNull()
    expect(prefijoDeRespaldo('010685', '1261095140')).toBeNull()
  })

  it('sin proveedor no hay respaldo', () => {
    expect(prefijoDeRespaldo(null, 'ABCDEFGHIJKLMNOPQ')).toBeNull()
  })
})

describe('IMSA, articulos con serie: primero el codigo entero (2026-11-18)', () => {
  it('propone el entero hasta 15, ademas de los 8', () => {
    expect(codigoEnteroConSerie('010337', 'MNLD-110PL-AUE2')).toBe('MNLD-110PL-AUE2')
    expect(codigoEnteroConSerie(' 010337 ', ' MNLD-110PL-AUE2-2026 ')).toBe('MNLD-110PL-AUE2')
    expect(codigoParaSinonimo('010337', 'MNLD-110PL-AUE2')).toBe('MNLD-110')
  })

  it('no hay entero aparte si el codigo no pasa de 8', () => {
    expect(codigoEnteroConSerie('010337', 'MNTD-150')).toBeNull()
  })

  it('los demas proveedores no tienen esta regla', () => {
    expect(codigoEnteroConSerie('010003', 'CUBQU110BASEROJO')).toBeNull()
    expect(codigoEnteroConSerie(null, 'MNLD-110PL-AUE2')).toBeNull()
  })

  it('al ensenar se guarda entero solo si el articulo lleva serie', () => {
    expect(sinonimoAGuardar('010337', 'MNLD-110PL-AUE2', true)).toBe('MNLD-110PL-AUE2')
    expect(sinonimoAGuardar('010337', 'MNLD-110PL-AUE2', false)).toBe('MNLD-110')
    expect(sinonimoAGuardar('010685', 'ABC-123', true)).toBe('ABC-123')
  })
})
