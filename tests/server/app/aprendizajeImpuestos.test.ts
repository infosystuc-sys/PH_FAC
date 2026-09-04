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

  it('normaliza la condicion de compra: sin acentos, mayusculas ni espacios de mas', async () => {
    await conRollback(async (tx) => {
      const prov = provPrueba()
      await aprenderImpuestoEn(tx, prov, 'condicion', '  Cuenta  Corriente  ', '8')

      const aprendidos = await cargarAprendidosEn(tx, prov, 'condicion')
      expect(aprendidos).toEqual({ 'cuenta corriente': '8' })
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

  describe("tipo 'ptovta'", () => {
    it('guarda un punto de venta por proveedor, con el tipo de factura como clave', async () => {
      await conRollback(async (tx) => {
        const prov = provPrueba()
        await aprenderImpuestoEn(tx, prov, 'ptovta', 'tarjeta', '10077')

        expect(await cargarAprendidosEn(tx, prov, 'ptovta')).toEqual({ tarjeta: '10077' })
      })
    })

    it('no se pisa con lo aprendido para los otros tipos del mismo proveedor', async () => {
      // Los cuatro tipos comparten tabla: la clave unica es
      // (proveedor, tipo, descripcion), asi que 'tarjeta' como descripcion
      // de 'ptovta' no puede chocar con nada de 'iva' ni de 'condicion'.
      await conRollback(async (tx) => {
        const prov = provPrueba()
        await aprenderImpuestoEn(tx, prov, 'ptovta', 'tarjeta', '00000')
        await aprenderImpuestoEn(tx, prov, 'condicion', 'tarjeta', '8')
        await aprenderImpuestoEn(tx, prov, 'iva', '21', '1')

        expect(await cargarAprendidosEn(tx, prov, 'ptovta')).toEqual({ tarjeta: '00000' })
        expect(await cargarAprendidosEn(tx, prov, 'condicion')).toEqual({ tarjeta: '8' })
        expect(await cargarAprendidosEn(tx, prov, 'iva')).toEqual({ 21: '1' })
      })
    })

    it('una segunda correccion reemplaza a la primera', async () => {
      // El operador se equivoco, o el proveedor cambio de convencion: vale
      // lo ultimo que dijo, sin dejar dos filas compitiendo.
      await conRollback(async (tx) => {
        const prov = provPrueba()
        await aprenderImpuestoEn(tx, prov, 'ptovta', 'tarjeta', '00000')
        await aprenderImpuestoEn(tx, prov, 'ptovta', 'tarjeta', '10077')

        expect(await cargarAprendidosEn(tx, prov, 'ptovta')).toEqual({ tarjeta: '10077' })
      })
    })

    it('conserva los ceros a la izquierda del punto de venta', async () => {
      // '00000' es un punto de venta real (VALLE FERTIL y el Banco de
      // Santiago del Estero lo usan): si se guardara como numero se
      // convertiria en '0' y armaria un N_COMP distinto.
      await conRollback(async (tx) => {
        const prov = provPrueba()
        await aprenderImpuestoEn(tx, prov, 'ptovta', 'tarjeta', '00000')

        expect((await cargarAprendidosEn(tx, prov, 'ptovta')).tarjeta).toBe('00000')
      })
    })
  })
})
