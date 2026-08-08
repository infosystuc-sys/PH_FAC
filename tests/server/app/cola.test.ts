import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import {
  tomarPendientesEn,
  marcarLeidoEn,
  marcarFalloEn,
  resolverProveedorEn,
  desnormalizarBandejaEn,
  MAX_INTENTOS,
} from '@/server/app/cola'
import { obtenerDetalleEn } from '@/server/app/detalle'
import { getPool } from '@/server/db/pool'

afterAll(async () => {
  await cerrarPool()
})

async function estadoDe(tx: sql.Transaction, id: number) {
  const r = await tx.request().input('id', sql.Int, id).query(`
    SELECT ESTADO, INTENTOS, ERROR_MENSAJE, CONFIANZA_PROMEDIO,
           EXTRACCION_MS, EXTRACCION_MODELO
    FROM PHF_COMPROBANTE WHERE ID = @id
  `)
  return r.recordset[0]
}

describe('tomarPendientesEn', () => {
  it('toma un comprobante recien encolado', async () => {
    await conRollback(async (tx) => {
      // La query ordena por FECHA_ALTA ascendente: un limite fijo como 50
      // devuelve los 50 mas viejos, y el recien insertado es el mas nuevo.
      // Si alguna vez hay 50 o mas colgados de verdad en 'procesando' (nada
      // raro con CONCURRENCIA = 3 drenando contra 20 a 100 comprobantes por
      // dia), un limite fijo haria fallar este test aunque la cola funcione
      // bien. Se mide el backlog real antes de insertar y se pide ese
      // tamaño mas uno, para no asumir que la tabla esta vacia.
      const backlog = await tomarPendientesEn(tx, 1_000_000)
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      const tomados = await tomarPendientesEn(tx, backlog.length + 1)
      expect(tomados.map((x) => x.id)).toContain(id)
    })
  })

  it('no toma comprobantes que no estan en procesando', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const tomados = await tomarPendientesEn(tx, 50)
      expect(tomados.map((x) => x.id)).not.toContain(id)
    })
  })

  it('no toma uno que ya agoto los intentos', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await tx.request().input('id', sql.Int, id).input('n', sql.Int, MAX_INTENTOS)
        .query('UPDATE PHF_COMPROBANTE SET INTENTOS = @n WHERE ID = @id')
      const tomados = await tomarPendientesEn(tx, 50)
      expect(tomados.map((x) => x.id)).not.toContain(id)
    })
  })

  it('respeta el limite pedido', async () => {
    await conRollback(async (tx) => {
      for (let i = 0; i < 4; i++) {
        await insertarComprobantePrueba(tx, { estado: 'procesando' })
      }
      expect((await tomarPendientesEn(tx, 2)).length).toBe(2)
    })
  })

  it('no repesca un colgado que todavia no llego a los 10 minutos de ventana', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await tx.request().input('id', sql.Int, id).query(`
        UPDATE PHF_COMPROBANTE SET FECHA_MODIF = DATEADD(MINUTE, -5, SYSDATETIME())
        WHERE ID = @id
      `)
      const tomados = await tomarPendientesEn(tx, 50)
      expect(tomados.map((x) => x.id)).not.toContain(id)
    })
  })

  it('repesca un colgado que ya paso los 10 minutos de ventana', async () => {
    await conRollback(async (tx) => {
      // Igual que en 'toma un comprobante recien encolado': se mide el
      // backlog real antes de insertar, porque tomarPendientesEn ahora
      // tambien es el claim (marca FECHA_MODIF = ahora en la misma
      // sentencia), asi que la primera llamada ya deja afuera de la
      // ventana de repesca a todo lo que devuelve.
      const backlog = await tomarPendientesEn(tx, 1_000_000)
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await tx.request().input('id', sql.Int, id).query(`
        UPDATE PHF_COMPROBANTE SET FECHA_MODIF = DATEADD(MINUTE, -15, SYSDATETIME())
        WHERE ID = @id
      `)
      const tomados = await tomarPendientesEn(tx, backlog.length + 1)
      expect(tomados.map((x) => x.id)).toContain(id)
    })
  })
})

describe('marcarLeidoEn', () => {
  it('pasa a leido con la metrica de la extraccion', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await marcarLeidoEn(tx, id, 0.97, 2400, 'claude-opus-5', 21)

      const c = await estadoDe(tx, id)
      expect(c.ESTADO).toBe('leido')
      expect(Number(c.CONFIANZA_PROMEDIO)).toBeCloseTo(0.97, 4)
      expect(c.EXTRACCION_MS).toBe(2400)
      expect(c.EXTRACCION_MODELO).toBe('claude-opus-5')
      expect(c.ERROR_MENSAJE).toBeNull()
    })
  })

  it('escribe la entrada de auditoria de la lectura', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await marcarLeidoEn(tx, id, 0.97, 2400, 'claude-opus-5', 21)
      const d = await obtenerDetalleEn(tx, id)
      expect(d.auditoria.some((a) => a.texto.includes('21'))).toBe(true)
    })
  })
})

describe('desnormalizarBandejaEn', () => {
  it('copia a la tabla los campos que muestra la bandeja', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await desnormalizarBandejaEn(tx, id, {
        campos: {
          tipo: { valor: 'FAC A', confianza: 1 },
          ptovta: { valor: '0011', confianza: 1 },
          nro: { valor: '00063576', confianza: 1 },
          cuit: { valor: '30-71042636-9', confianza: 1 },
          total: { valor: '484.344,26', confianza: 1 },
          fecha: { valor: '18/05/2026', confianza: 1 },
        },
        renglones: [],
      })

      const r = await tx.request().input('id', sql.Int, id).query(`
        SELECT TIPO, PUNTO_VENTA, NUMERO, CUIT, TOTAL, FECHA_EMISION
        FROM PHF_COMPROBANTE WHERE ID = @id
      `)
      const c = r.recordset[0]
      expect(c.TIPO).toBe('FAC A')
      expect(c.NUMERO).toBe('00063576')
      expect(Number(c.TOTAL)).toBeCloseTo(484344.26, 2)
      // useUTC: false hace que la fecha vuelva en hora local. Si esto
      // empieza a dar 17, se rompio esa config del pool.
      expect(new Date(c.FECHA_EMISION).getDate()).toBe(18)
    })
  })

  it('deja NULL el total y la fecha si la IA leyo algo que no parsea', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await desnormalizarBandejaEn(tx, id, {
        campos: {
          total: { valor: 'ilegible', confianza: 0.1 },
          fecha: { valor: 'no es una fecha', confianza: 0.1 },
        },
        renglones: [],
      })

      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT TOTAL, FECHA_EMISION FROM PHF_COMPROBANTE WHERE ID = @id')
      expect(r.recordset[0].TOTAL).toBeNull()
      expect(r.recordset[0].FECHA_EMISION).toBeNull()
    })
  })
})

describe('resolverProveedorEn', () => {
  it('completa el codigo de proveedor a partir del CUIT extraido cuando matchea uno solo', async () => {
    // Se descubre un CUIT real de CPA01 sin duplicar en vez de hardcodearlo:
    // un CUIT que aparece una sola vez en toda la tabla, no solo "el primero
    // de 11 digitos" (que podria estar duplicado y volver el test flaky
    // desde que resolverProveedorEn dejo de resolver a ciegas el primero).
    const pool = await getPool()
    const p = await pool.request().query(`
      SELECT TOP 1 cuit, MIN(cod) AS cod
      FROM (
        SELECT LTRIM(RTRIM(COD_PROVEE)) AS cod,
               REPLACE(REPLACE(REPLACE(ISNULL(N_CUIT,''), '-', ''), ' ', ''), '.', '') AS cuit
        FROM CPA01
        WHERE LEN(REPLACE(REPLACE(REPLACE(ISNULL(N_CUIT,''), '-', ''), ' ', ''), '.', '')) = 11
      ) x
      GROUP BY cuit
      HAVING COUNT(*) = 1
      ORDER BY cuit
    `)
    const real = p.recordset[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await resolverProveedorEn(tx, id, String(real.cuit))

      const d = await obtenerDetalleEn(tx, id)
      const campo = d.campos.find((c) => c.clave === 'codprovee')!
      expect(campo.valorFinal).toBe(String(real.cod))
      // Lo resolvio el sistema por el CUIT, no el operador: no puede quedar
      // marcado como corregido, o se contamina la metrica de que tan bien
      // lee el modelo.
      expect(campo.corregido).toBe(false)

      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT COD_PROVEE FROM PHF_COMPROBANTE WHERE ID = @id')
      expect(String(r.recordset[0].COD_PROVEE)).toBe(String(real.cod))

      expect(d.auditoria.some((a) => a.texto.includes('Proveedor resuelto por CUIT'))).toBe(true)
    })
  })

  it('no escribe nada cuando el CUIT no matchea ningun proveedor', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await resolverProveedorEn(tx, id, '99-99999999-9')
      const d = await obtenerDetalleEn(tx, id)
      expect(d.campos.find((c) => c.clave === 'codprovee')).toBeUndefined()
    })
  })

  it('no escribe nada cuando el CUIT matchea 2 o mas proveedores -- queda para el selector manual', async () => {
    // Antes resolvia a ciegas el primero por COD_PROVEE (buscarProveedorPorCuit,
    // singular). Eso dejaba un codigo de proveedor arbitrario ya escrito
    // cuando el CUIT esta duplicado, y la validacion bloqueante de la Fase 3
    // nunca lo detectaba porque el campo ya estaba "resuelto". Se descubre un
    // CUIT duplicado real en vez de hardcodearlo (7 casos verificados en
    // CPA01, el conjunto puede cambiar).
    const pool = await getPool()
    const dup = await pool.request().query(`
      SELECT TOP 1 REPLACE(REPLACE(REPLACE(N_CUIT,'-',''),' ',''),'.','') AS cuit
      FROM CPA01
      WHERE N_CUIT IS NOT NULL AND N_CUIT <> ''
      GROUP BY REPLACE(REPLACE(REPLACE(N_CUIT,'-',''),' ',''),'.','')
      HAVING COUNT(*) > 1
    `)
    if (dup.recordset.length === 0) return // no hay CUIT duplicado hoy: no hay nada que probar
    const cuitDuplicado = String(dup.recordset[0].cuit)

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await resolverProveedorEn(tx, id, cuitDuplicado)
      const d = await obtenerDetalleEn(tx, id)
      expect(d.campos.find((c) => c.clave === 'codprovee')).toBeUndefined()

      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT COD_PROVEE FROM PHF_COMPROBANTE WHERE ID = @id')
      expect(r.recordset[0].COD_PROVEE).toBeNull()
    })
  })

  it('no rompe cuando la IA no leyo el CUIT', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await expect(resolverProveedorEn(tx, id, null)).resolves.toBeUndefined()
    })
  })
})

describe('marcarFalloEn', () => {
  it('suma un intento y lo deja en procesando si quedan reintentos', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await marcarFalloEn(tx, id, 'timeout')

      const c = await estadoDe(tx, id)
      expect(c.INTENTOS).toBe(1)
      expect(c.ESTADO).toBe('procesando')
      expect(c.ERROR_MENSAJE).toBe('timeout')
    })
  })

  it('pasa a error cuando se agotan los intentos', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      for (let i = 0; i < MAX_INTENTOS; i++) await marcarFalloEn(tx, id, 'timeout')

      const c = await estadoDe(tx, id)
      expect(c.INTENTOS).toBe(MAX_INTENTOS)
      expect(c.ESTADO).toBe('error')
    })
  })

  it('deja la entrada de auditoria del fallo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await marcarFalloEn(tx, id, 'PDF ilegible')
      const d = await obtenerDetalleEn(tx, id)
      expect(d.auditoria.some((a) => a.texto.includes('PDF ilegible'))).toBe(true)
    })
  })
})
