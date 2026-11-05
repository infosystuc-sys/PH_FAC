import { describe, it, expect } from 'vitest'
import { codigoParaSinonimo } from '@/lib/codigoProveedor'

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
