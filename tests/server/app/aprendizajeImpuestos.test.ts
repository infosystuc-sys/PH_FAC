import { describe, it, expect, afterAll } from 'vitest'
import { conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'
import { aprenderImpuestoEn, cargarAprendidosEn } from '@/server/app/aprendizajeImpuestos'

afterAll(async () => {
  await cerrarPool()
})

/** Un COD_PROVEE inventado y único por corrida: la tabla no tiene FK a
 *  CPA01, así que no hace falta un proveedor real para probarla. */
function provPrueba(): string {
  return `ZZ${Date.now() % 100000}`
}

describe('aprenderImpuestoEn / cargarAprendidosEn', () => {
  it('graba una alicuota de IVA y despues aparece en lo aprendido', async () => {
    await conRollback(async (tx) => {
      const prov = provPrueba()
      await aprenderImpuestoEn(tx, prov, 'iva', '21', '1')

      const aprendidos = await cargarAprendidosEn(tx, prov, 'iva')
      expect(aprendidos).toEqual({ '21': '1' })
    })
  })

  it('normaliza el porcentaje: "21,00" y "21" pegan en la misma fila', async () => {
    await conRollback(async (tx) => {
      const prov = provPrueba()
      await aprenderImpuestoEn(tx, prov, 'iva', '21,00', '1')

      const aprendidos = await cargarAprendidosEn(tx, prov, 'iva')
      // La clave queda en la forma numerica canonica, no la grafia original.
      expect(aprendidos).toEqual({ '21': '1' })
    })
  })

  it('normaliza la jurisdiccion: sin acentos ni mayusculas', async () => {
    await conRollback(async (tx) => {
      const prov = provPrueba()
      await aprenderImpuestoEn(tx, prov, 'percepcion', 'Córdoba', '62')

      const aprendidos = await cargarAprendidosEn(tx, prov, 'percepcion')
      expect(aprendidos).toEqual({ cordoba: '62' })
    })
  })

  it('una segunda correccion para el mismo texto reemplaza a la primera', async () => {
    await conRollback(async (tx) => {
      const prov = provPrueba()
      await aprenderImpuestoEn(tx, prov, 'iva', '5', '4')
      await aprenderImpuestoEn(tx, prov, 'iva', '5', '2')

      const aprendidos = await cargarAprendidosEn(tx, prov, 'iva')
      expect(aprendidos).toEqual({ '5': '2' })
    })
  })

  it('iva y percepcion son namespaces separados para el mismo proveedor', async () => {
    await conRollback(async (tx) => {
      const prov = provPrueba()
      await aprenderImpuestoEn(tx, prov, 'iva', '21', '1')
      await aprenderImpuestoEn(tx, prov, 'percepcion', 'Tucumán', '60')

      expect(await cargarAprendidosEn(tx, prov, 'iva')).toEqual({ '21': '1' })
      expect(await cargarAprendidosEn(tx, prov, 'percepcion')).toEqual({ tucuman: '60' })
    })
  })

  it('no mezcla lo aprendido de un proveedor con el de otro', async () => {
    await conRollback(async (tx) => {
      const provA = provPrueba()
      const provB = `${provA}B`
      await aprenderImpuestoEn(tx, provA, 'iva', '21', '1')

      expect(await cargarAprendidosEn(tx, provB, 'iva')).toEqual({})
    })
  })

  it('no escribe nada sin proveedor, descripcion o codigo', async () => {
    await conRollback(async (tx) => {
      const prov = provPrueba()
      await aprenderImpuestoEn(tx, '', 'iva', '21', '1')
      await aprenderImpuestoEn(tx, prov, 'iva', '', '1')
      await aprenderImpuestoEn(tx, prov, 'iva', '21', '')

      expect(await cargarAprendidosEn(tx, prov, 'iva')).toEqual({})
    })
  })

  it('cargarAprendidosEn devuelve vacio sin codProvee, sin pegarle a la base', async () => {
    await conRollback(async (tx) => {
      expect(await cargarAprendidosEn(tx, '', 'iva')).toEqual({})
      expect(await cargarAprendidosEn(tx, '   ', 'percepcion')).toEqual({})
    })
  })
})
