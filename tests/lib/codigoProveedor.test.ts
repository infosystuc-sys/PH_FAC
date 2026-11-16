import { describe, it, expect } from 'vitest'
import { codigoParaSinonimo, prefijoDeRespaldo, restoDelCodigo } from '@/lib/codigoProveedor'

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

  it('los demas proveedores no tienen respaldo', () => {
    expect(prefijoDeRespaldo('010337', 'MNTD-150AZUL2026')).toBeNull()
    expect(restoDelCodigo(null, 'CUBQU110BASEROJO')).toBe('')
  })
})
