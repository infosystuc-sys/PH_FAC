import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import sql from 'mssql'
import { conRollback } from '@/server/db/tx'
import { getPool, cerrarPool } from '@/server/db/pool'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { guardarCampoEn } from '@/server/app/detalle'
import { validarComprobanteEn, validarListoParaRegistrarEn } from '@/server/app/validaciones'
import { elegirProveedorEn } from '@/server/app/acciones'

afterAll(async () => {
  await cerrarPool()
})

describe('validarComprobanteEn', () => {
  it('proveedor en error y bloqueante si el CUIT no matchea ningun proveedor', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'cuit', '20-11111111-1')
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '1')
      await guardarCampoEn(tx, id, 'nro', '1')
      await guardarCampoEn(tx, id, 'total', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.proveedor.estado).toBe('error')
      expect(v.bloqueante).toBe(true)
      expect(v.candidatosProveedor).toEqual([])
      // El chequeo de duplicados nunca corrio (no hay con que consultar
      // CPA04 sin proveedor resuelto): tiene que avisar, no decir "Sin
      // duplicados." como si hubiera corrido y no hubiera encontrado nada.
      expect(v.duplicado.estado).toBe('advertencia')
      expect(v.duplicado.mensaje).toMatch(/falta resolver el proveedor/i)
    })
  })

  it('duplicado en advertencia (no verificado) si falta tipo, ptovta o numero aunque el proveedor este resuelto', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const cuitAmx = await tx.request().query(`SELECT TOP 1 N_CUIT FROM CPA01 WHERE COD_PROVEE = '010151'`)
      await guardarCampoEn(tx, id, 'cuit', String(cuitAmx.recordset[0].N_CUIT))
      // Sin tipo/ptovta/nro: el proveedor si se resuelve (CUIT con un solo
      // match), pero no hay con que armar el N_COMP para consultar CPA04.
      await guardarCampoEn(tx, id, 'total', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.proveedor.estado).toBe('ok')
      expect(v.duplicado.estado).toBe('advertencia')
      expect(v.duplicado.mensaje).toMatch(/falta tipo, punto de venta o número/i)
      expect(v.bloqueante).toBe(false)
    })
  })

  it('proveedor ok y sin duplicado cuando el CUIT matchea uno solo y el N_COMP no existe en CPA04', async () => {
    await conRollback(async (tx) => {
      const cuitAmx = await tx.request().query(`SELECT TOP 1 N_CUIT FROM CPA01 WHERE COD_PROVEE = '010151'`)
      const cuit = String(cuitAmx.recordset[0].N_CUIT)

      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'cuit', cuit)
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '99999')
      await guardarCampoEn(tx, id, 'nro', '99999999')
      await guardarCampoEn(tx, id, 'total', '100,00')
      await guardarCampoEn(tx, id, 'neto', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.proveedor.estado).toBe('ok')
      expect(v.duplicado.estado).toBe('ok')
      expect(v.totales.estado).toBe('ok')
      expect(v.bloqueante).toBe(false)
    })
  })

  it('duplicado en error si el N_COMP ya existe en CPA04 para ese proveedor', async () => {
    await conRollback(async (tx) => {
      // Excluye proveedores con CUIT duplicado en CPA01 (hay 7 reales, ver
      // RETOMAR.md): si la fila mas reciente de CPA04 resulta ser de uno de
      // esos proveedores, el CUIT no resuelve a un match unico y el
      // resultado es 'advertencia' (proveedor no verificado), no 'error' --
      // rompe este test sin que el codigo bajo prueba tenga nada mal. Pasó
      // en la práctica: el registro real de un comprobante de prueba contra
      // el proveedor 010246 (CUIT duplicado con 010270) durante la
      // verificacion manual de Fase 4 paso a ser la fila mas reciente.
      const existente = await tx.request().query(`
        SELECT TOP 1 c.COD_PROVEE, c.N_COMP, p.N_CUIT
        FROM CPA04 c JOIN CPA01 p ON p.COD_PROVEE = c.COD_PROVEE
        WHERE c.T_COMP = 'FAC' AND p.N_CUIT IS NOT NULL AND p.N_CUIT <> ''
          AND p.N_CUIT NOT IN (
            SELECT N_CUIT FROM CPA01
            WHERE N_CUIT IS NOT NULL AND N_CUIT <> ''
            GROUP BY N_CUIT HAVING COUNT(*) > 1
          )
        ORDER BY c.NCOMP_IN_C DESC
      `)
      const fila = existente.recordset[0]
      const nComp = String(fila.N_COMP).trim()
      const letra = nComp[0]
      const ptovta = nComp.slice(1, 6)
      const nro = nComp.slice(6)

      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'cuit', String(fila.N_CUIT))
      await guardarCampoEn(tx, id, 'tipo', `FAC ${letra}`)
      await guardarCampoEn(tx, id, 'ptovta', ptovta)
      await guardarCampoEn(tx, id, 'nro', nro)
      await guardarCampoEn(tx, id, 'total', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.duplicado.estado).toBe('error')
      expect(v.bloqueante).toBe(true)
    })
  })

  it('duplicado en error si ya existe otro PHF_COMPROBANTE con el mismo proveedor+tipo+ptovta+numero', async () => {
    await conRollback(async (tx) => {
      const otro = await insertarComprobantePrueba(tx, {
        estado: 'confirmado', tipo: 'FAC A', puntoVenta: '00001', numero: '00000001',
      })
      await tx.request().input('id', sql.Int, otro).input('cp', sql.VarChar(20), '010151')
        .query(`UPDATE PHF_COMPROBANTE SET COD_PROVEE = @cp WHERE ID = @id`)

      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const cuitAmx = await tx.request().query(`SELECT TOP 1 N_CUIT FROM CPA01 WHERE COD_PROVEE = '010151'`)
      await guardarCampoEn(tx, id, 'cuit', String(cuitAmx.recordset[0].N_CUIT))
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '00001')
      await guardarCampoEn(tx, id, 'nro', '00000001')
      await guardarCampoEn(tx, id, 'total', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.duplicado.estado).toBe('error')
    })
  })

  it('totales en advertencia si no cierran, sin bloquear la confirmacion', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const cuitAmx = await tx.request().query(`SELECT TOP 1 N_CUIT FROM CPA01 WHERE COD_PROVEE = '010151'`)
      await guardarCampoEn(tx, id, 'cuit', String(cuitAmx.recordset[0].N_CUIT))
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '99998')
      await guardarCampoEn(tx, id, 'nro', '99999998')
      await guardarCampoEn(tx, id, 'neto', '100,00')
      await guardarCampoEn(tx, id, 'total', '999,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.totales.estado).toBe('advertencia')
      expect(v.bloqueante).toBe(false)
    })
  })
})

/**
 * Regresion del bug critico de la revision final de Fase 3: elegir un
 * proveedor a mano (`elegirProveedorEn`) para un CUIT duplicado tenia que
 * destrabar la validacion bloqueante, y no lo hacia -- `validarComprobanteEn`
 * solo miraba `candidatosProveedor.length` (derivado del CUIT) y nunca leia
 * `codprovee`, asi que un CUIT con 2+ matches quedaba en error para siempre
 * aunque el operador ya hubiera elegido.
 *
 * Se descubre un CUIT duplicado real de CPA01 en vez de hardcodearlo (mismo
 * patron que 'devuelve mas de un resultado para un CUIT duplicado real de la
 * base' en tests/server/tango/proveedores.test.ts): el conjunto de
 * duplicados es un dato de la base, no una constante del codigo.
 *
 * `elegirProveedorEn` y `validarComprobanteEn` corren sobre la misma `tx`
 * para quedarse en la misma conexion/transaccion que `insertarComprobantePrueba`
 * -- si `elegirProveedorEn` abriera su propia conexion de pool, su UPDATE (y
 * el INSERT en PHF_AUDITORIA, que tiene FK a PHF_COMPROBANTE) quedarian
 * esperando el lock de esta transaccion, que no comitea hasta que el test
 * termina: un deadlock por diseño del test, no una carrera real. Mismo
 * motivo documentado en tests/server/app/acciones.test.ts.
 */
describe('elegirProveedorEn resuelve la validacion bloqueante de proveedor', () => {
  let cuitDuplicado: string | null = null
  let candidatos: { cod: string; razon: string }[] = []

  beforeAll(async () => {
    const pool = await getPool()
    const dup = await pool.request().query(`
      SELECT TOP 1 REPLACE(REPLACE(REPLACE(N_CUIT,'-',''),' ',''),'.','') AS cuit
      FROM CPA01
      WHERE N_CUIT IS NOT NULL AND N_CUIT <> ''
      GROUP BY REPLACE(REPLACE(REPLACE(N_CUIT,'-',''),' ',''),'.','')
      HAVING COUNT(*) > 1
    `)
    if (dup.recordset.length === 0) return // no hay CUIT duplicado hoy: no hay nada que probar
    cuitDuplicado = String(dup.recordset[0].cuit)

    const r = await pool
      .request()
      .input('cuit', sql.VarChar(11), cuitDuplicado)
      .query(`
        SELECT LTRIM(RTRIM(COD_PROVEE)) AS cod, LTRIM(RTRIM(ISNULL(NOM_PROVEE,''))) AS razon
        FROM CPA01
        WHERE REPLACE(REPLACE(REPLACE(ISNULL(N_CUIT,''), '-', ''), ' ', ''), '.', '') = @cuit
        ORDER BY COD_PROVEE
      `)
    candidatos = r.recordset.map((x) => ({ cod: String(x.cod), razon: String(x.razon) }))
  })

  it('bloquea antes de elegir y desbloquea despues de que el operador elige a mano', async () => {
    if (!cuitDuplicado || candidatos.length < 2) return // no hay CUIT duplicado hoy: no hay nada que probar

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'cuit', cuitDuplicado!)
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '99995')
      await guardarCampoEn(tx, id, 'nro', '99999995')
      await guardarCampoEn(tx, id, 'total', '100,00')

      const antes = await validarComprobanteEn(tx, id)
      expect(antes.proveedor.estado).toBe('error')
      expect(antes.candidatosProveedor.length).toBeGreaterThan(1)
      expect(antes.bloqueante).toBe(true)

      const elegido = candidatos[0]
      await elegirProveedorEn(tx, id, elegido.cod, elegido.razon, true)

      const despues = await validarComprobanteEn(tx, id)
      expect(despues.proveedor.estado).toBe('ok')
      expect(despues.bloqueante).toBe(false)
    })
  })
})

describe('validarListoParaRegistrarEn', () => {
  it('bloqueante si falta condcompra', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0011')
      await guardarCampoEn(tx, id, 'nro', '63576')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.condCompra.estado).toBe('error')
      expect(r.bloqueante).toBe(true)
    })
  })

  it('bloqueante si hay percepcion de IIBB sin codigo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0011')
      await guardarCampoEn(tx, id, 'nro', '63576')
      await guardarCampoEn(tx, id, 'condcompra', '60')
      await guardarCampoEn(tx, id, 'perciibb', '13.248,69')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.percepcionIibb.estado).toBe('error')
      expect(r.bloqueante).toBe(true)
    })
  })

  it('muestra la descripcion real de Tango cuando el codigo de IIBB esta elegido', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'condcompra', '60')
      await guardarCampoEn(tx, id, 'perciibb', '13.248,69')
      await guardarCampoEn(tx, id, 'codpercibb', '60')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.percepcionIibb.estado).toBe('ok')
      expect(r.percepcionIibb.mensaje).toBe('Percepción IIBB: 60 — PERCEPCION IIBB TUC.')
    })
  })

  it('bloqueante si el numero de comprobante no calza en el formato', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '123456')
      await guardarCampoEn(tx, id, 'nro', '63576')
      await guardarCampoEn(tx, id, 'condcompra', '60')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.formatoComp.estado).toBe('error')
      expect(r.bloqueante).toBe(true)
    })
  })

  it('no bloqueante si todo esta completo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '0011')
      await guardarCampoEn(tx, id, 'nro', '63576')
      await guardarCampoEn(tx, id, 'condcompra', '60')
      await guardarCampoEn(tx, id, 'perciibb', '13.248,69')
      await guardarCampoEn(tx, id, 'codpercibb', '60')
      await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.condCompra.estado).toBe('ok')
      expect(r.percepcionIibb.estado).toBe('ok')
      expect(r.formatoComp.estado).toBe('ok')
      expect(r.bloqueante).toBe(false)
    })
  })

  it('bloqueante si falta tipoFactura', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'condcompra', '60')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.tipoFactura.estado).toBe('error')
      expect(r.bloqueante).toBe(true)
    })
  })

  it('concepto no aplica si tipoFactura es "articulos"', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'condcompra', '60')
      await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.tipoFactura.estado).toBe('ok')
      expect(r.concepto.estado).toBe('ok')
      expect(r.concepto.mensaje).toBe('No aplica.')
    })
  })

  it('bloqueante si tipoFactura es "conceptos" y el proveedor no tiene concepto configurado', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'condcompra', '60')
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'codprovee', '999999')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.concepto.estado).toBe('error')
      expect(r.bloqueante).toBe(true)
    })
  })

  it('ok si tipoFactura es "conceptos" y el proveedor tiene concepto configurado (010151)', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'confirmado' })
      await guardarCampoEn(tx, id, 'condcompra', '60')
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'codprovee', '010151')

      const r = await validarListoParaRegistrarEn(tx, id)
      expect(r.concepto.estado).toBe('ok')
    })
  })
})
