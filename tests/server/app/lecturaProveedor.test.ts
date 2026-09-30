import { describe, it, expect, afterAll } from 'vitest'
import { conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'
import {
  reglaDeProveedorEn,
  guardarReglaEn,
  reglasDeLecturaEn,
} from '@/server/app/lecturaProveedor'

afterAll(async () => {
  await cerrarPool()
})

// PHF_LECTURA_PROVEEDOR va a tener reglas reales, asi que estos tests usan
// codigos de proveedor inventados por corrida y no asumen tabla vacia.
function provUnico(): string {
  return `T${Math.floor(Math.random() * 100000000)}`
}

describe('reglaDeProveedorEn / guardarReglaEn', () => {
  it('un proveedor sin regla no devuelve nada', async () => {
    await conRollback(async (tx) => {
      expect(await reglaDeProveedorEn(tx, provUnico())).toBeNull()
    })
  })

  it('guarda la regla deducida y la recupera', async () => {
    await conRollback(async (tx) => {
      const prov = provUnico()
      await guardarReglaEn(tx, prov, 'columna-color')
      const r = await reglaDeProveedorEn(tx, prov)
      expect(r?.escala).toBe('columna-color')
      expect(r?.comprobantes).toBe(1)
      expect(r?.manual).toBe(false)
    })
  })

  it('ver la misma regla otra vez suma el conteo y no reescribe', async () => {
    await conRollback(async (tx) => {
      const prov = provUnico()
      await guardarReglaEn(tx, prov, 'desglose-talle')
      await guardarReglaEn(tx, prov, 'desglose-talle')
      const r = await reglaDeProveedorEn(tx, prov)
      expect(r?.escala).toBe('desglose-talle')
      expect(r?.comprobantes).toBe(2)
    })
  })

  it('una regla automatica nueva reemplaza a la automatica anterior', async () => {
    await conRollback(async (tx) => {
      const prov = provUnico()
      await guardarReglaEn(tx, prov, 'columna-color')
      await guardarReglaEn(tx, prov, 'desglose-talle')
      expect((await reglaDeProveedorEn(tx, prov))?.escala).toBe('desglose-talle')
    })
  })

  it('la deduccion automatica NO pisa una regla puesta por el operador', async () => {
    // Es la garantia que importa: si una persona eligio, sabe mas que la
    // deduccion, y una factura rara no puede darla vuelta en silencio.
    await conRollback(async (tx) => {
      const prov = provUnico()
      await guardarReglaEn(tx, prov, 'ninguna', true)
      await guardarReglaEn(tx, prov, 'columna-color')
      const r = await reglaDeProveedorEn(tx, prov)
      expect(r?.escala).toBe('ninguna')
      expect(r?.manual).toBe(true)
    })
  })

  it('el operador si puede cambiar su propia regla', async () => {
    await conRollback(async (tx) => {
      const prov = provUnico()
      await guardarReglaEn(tx, prov, 'ninguna', true)
      await guardarReglaEn(tx, prov, 'columna-color', true)
      expect((await reglaDeProveedorEn(tx, prov))?.escala).toBe('columna-color')
    })
  })

  it('sin proveedor no guarda nada', async () => {
    await conRollback(async (tx) => {
      expect(await guardarReglaEn(tx, null, 'columna-color')).toBeNull()
      expect(await guardarReglaEn(tx, '  ', 'columna-color')).toBeNull()
    })
  })

  it('la regla aparece en el listado', async () => {
    await conRollback(async (tx) => {
      const antes = await reglasDeLecturaEn(tx)
      const prov = provUnico()
      await guardarReglaEn(tx, prov, 'columna-color')
      const despues = await reglasDeLecturaEn(tx)
      expect(despues.length).toBe(antes.length + 1)
      expect(despues.some((r) => r.codProvee === prov)).toBe(true)
    })
  })
})
