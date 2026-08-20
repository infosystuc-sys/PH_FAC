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
  observarSinConceptoEn,
  lineasDeRemitos,
  guardarRenglonesFacturadosEn,
  observarRemitosEn,
  observarDiferenciasEn,
  desnormalizarBandejaEn,
  MAX_INTENTOS,
} from '@/server/app/cola'
import {
  MOTIVO_SIN_CONCEPTO,
  MOTIVO_REMITO_SIN_SALDO,
  MOTIVO_FACTURA_NO_COINCIDE,
} from '@/lib/observacion'
import { cotejarRenglones } from '@/lib/cotejo'
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

  it('devuelve null cuando la IA no leyo el CUIT, sin romper', async () => {
    // El null no es solo "no paso nada": observarSinConceptoEn lo usa para
    // saber que todavia no hay proveedor contra el cual buscar concepto.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await expect(resolverProveedorEn(tx, id, null)).resolves.toBeNull()
    })
  })

  it('devuelve el codigo que resolvio, para encadenar con el concepto', async () => {
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
      const cod = await resolverProveedorEn(tx, id, String(real.cuit))
      expect(cod).toBe(String(real.cod))
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

describe('observarSinConceptoEn', () => {
  /** Un COD_PROVEE de CPA01 que no figura en CPA_CONCEPTOS_PROVEEDOR. */
  async function proveedorSinConcepto(): Promise<string | null> {
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT TOP 1 LTRIM(RTRIM(p.COD_PROVEE)) AS cod
      FROM CPA01 p
      WHERE NOT EXISTS (
        SELECT 1 FROM CPA_CONCEPTOS_PROVEEDOR c WHERE c.COD_PROVEE = p.COD_PROVEE)
      ORDER BY p.COD_PROVEE
    `)
    return r.recordset.length > 0 ? String(r.recordset[0].cod) : null
  }

  /** Uno que si lo tiene, para el caso contrario. */
  async function proveedorConConcepto(): Promise<string | null> {
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT TOP 1 LTRIM(RTRIM(COD_PROVEE)) AS cod
      FROM CPA_CONCEPTOS_PROVEEDOR ORDER BY COD_PROVEE
    `)
    return r.recordset.length > 0 ? String(r.recordset[0].cod) : null
  }

  it('manda a observacion la factura de conceptos sin concepto, con el motivo escrito', async () => {
    const cod = await proveedorSinConcepto()
    if (!cod) return // la base no tiene ninguno: nada que verificar

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })

      const observado = await observarSinConceptoEn(tx, id, 'conceptos', cod)
      expect(observado).toBe(true)

      const r = await tx.request().input('id', sql.Int, id).query(
        'SELECT ESTADO, MOTIVO_OBSERVACION, NOTA_OBSERVACION FROM PHF_COMPROBANTE WHERE ID = @id',
      )
      const fila = r.recordset[0]
      expect(fila.ESTADO).toBe('observacion')
      expect(fila.MOTIVO_OBSERVACION).toBe(MOTIVO_SIN_CONCEPTO)
      // La nota tiene que nombrar al proveedor y decir que se hace: es lo
      // unico que el operador va a leer para saber por que se freno.
      expect(String(fila.NOTA_OBSERVACION)).toContain(cod)
      expect(String(fila.NOTA_OBSERVACION)).toMatch(/ficha del proveedor/i)
    })
  })

  it('no toca el comprobante si el proveedor si tiene concepto', async () => {
    const cod = await proveedorConConcepto()
    if (!cod) return

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      expect(await observarSinConceptoEn(tx, id, 'conceptos', cod)).toBe(false)

      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT ESTADO FROM PHF_COMPROBANTE WHERE ID = @id')
      expect(r.recordset[0].ESTADO).toBe('leido')
    })
  })

  it('no aplica a articulos ni a tarjeta: esos no se imputan por concepto', async () => {
    const cod = await proveedorSinConcepto()
    if (!cod) return

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      expect(await observarSinConceptoEn(tx, id, 'articulos', cod)).toBe(false)
      expect(await observarSinConceptoEn(tx, id, 'tarjeta', cod)).toBe(false)
    })
  })

  it('no observa cuando el proveedor no se pudo resolver', async () => {
    // Sin codigo de proveedor no se sabe si tiene concepto. Ese caso ya lo
    // marca la validacion de proveedor; observarlo aca seria culpar al
    // proveedor equivocado.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      expect(await observarSinConceptoEn(tx, id, 'conceptos', null)).toBe(false)
    })
  })
})

describe('lineasDeRemitos', () => {
  /** Un remito con saldo: se descubre, porque los pendientes se van facturando. */
  async function remitoPendiente() {
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT TOP 1 LTRIM(RTRIM(h.N_COMP)) AS nComp, LTRIM(RTRIM(h.COD_PRO_CL)) AS prov,
             LTRIM(RTRIM(h.NCOMP_IN_S)) AS interno, COUNT(*) AS renglones
      FROM STA14 h
      JOIN STA20 r ON r.TCOMP_IN_S = h.TCOMP_IN_S AND r.NCOMP_IN_S = h.NCOMP_IN_S
      WHERE h.TCOMP_IN_S = 'RP' AND h.ESTADO_MOV = 'P' AND r.CANT_PEND > 0
      GROUP BY h.N_COMP, h.COD_PRO_CL, h.NCOMP_IN_S
      ORDER BY COUNT(*) DESC, h.NCOMP_IN_S DESC
    `)
    return r.recordset.length ? r.recordset[0] : null
  }

  it('numera los renglones del remito para que la IA los empareje', async () => {
    const rem = await remitoPendiente()
    if (!rem) return

    const { lineas, origen, carga } = await lineasDeRemitos('articulos', String(rem.prov), {
      remito1: String(rem.nComp),
      remito2: null,
    })

    expect(lineas).toHaveLength(Number(rem.renglones))
    expect(carga.sinSaldo).toEqual([])
    expect(carga.noEncontrados).toEqual([])

    // Correlativos desde 1: es el numero que ve el modelo en el prompt.
    expect(lineas.map((l) => l.indice)).toEqual(
      Array.from({ length: lineas.length }, (_, i) => i + 1),
    )
    for (const l of lineas) {
      expect(l.codArticulo).toBeTruthy()
      expect(l.cantidad).toBeGreaterThan(0)
      expect(l.numeroRemito).toBe(String(rem.nComp))
      // Cada indice sabe de que renglon de Tango salio: es la clave del
      // join contra STA20 al registrar.
      expect(origen.get(l.indice)?.ncompInS).toBe(String(rem.interno))
    }
  })

  it('no devuelve nada si el tipo no es articulos', async () => {
    const rem = await remitoPendiente()
    if (!rem) return

    for (const tipo of ['conceptos', 'tarjeta'] as const) {
      const { lineas } = await lineasDeRemitos(tipo, String(rem.prov), {
        remito1: String(rem.nComp),
      })
      expect(lineas, tipo).toEqual([])
    }
  })

  it('no devuelve nada sin proveedor resuelto ni sin numero de remito', async () => {
    const rem = await remitoPendiente()
    if (!rem) return

    expect((await lineasDeRemitos('articulos', null, { remito1: String(rem.nComp) })).lineas)
      .toEqual([])
    expect((await lineasDeRemitos('articulos', String(rem.prov), { remito1: '' })).lineas)
      .toEqual([])
  })

  it('reporta el remito ya facturado como sin saldo, sin devolver lineas', async () => {
    const pool = await getPool()
    const f = await pool.request().query(`
      SELECT TOP 1 LTRIM(RTRIM(N_COMP)) AS nComp, LTRIM(RTRIM(COD_PRO_CL)) AS prov
      FROM STA14 WHERE TCOMP_IN_S = 'RP' AND ESTADO_MOV = 'F' ORDER BY NCOMP_IN_S DESC
    `)
    if (f.recordset.length === 0) return
    const x = f.recordset[0]

    const { lineas, carga } = await lineasDeRemitos('articulos', String(x.prov), {
      remito1: String(x.nComp),
    })
    expect(lineas).toEqual([])
    expect(carga.sinSaldo).toEqual([String(x.nComp)])
  })

  it('reporta como no encontrado un numero que no existe para ese proveedor', async () => {
    const rem = await remitoPendiente()
    if (!rem) return

    const { carga } = await lineasDeRemitos('articulos', String(rem.prov), {
      remito1: '99999-99999999',
    })
    expect(carga.noEncontrados).toEqual(['99999-99999999'])
  })
})

describe('guardarRenglonesFacturadosEn', () => {
  const LINEAS = [
    {
      indice: 1,
      codArticulo: '106362',
      descripcion: 'TENDER ONE BOX',
      cantidad: 20,
      numeroRemito: 'R0000200006818',
    },
  ]
  const ORIGEN = new Map([[1, { ncompInS: '00003684', nRenglon: 1, numero: 'R0000200006818' }]])

  it('guarda la cantidad y el precio de la FACTURA, no los del remito', async () => {
    // El remito no es valorizado: dice que entro y cuanto, y el precio sale
    // de la factura (decision del usuario).
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const n = await guardarRenglonesFacturadosEn(
        tx,
        id,
        [{ lineaRemito: 1, descripcion: 'ZAPATILLA X', cantidad: '20', precioUnitario: '1.250,50', bonificacion: null }],
        ORIGEN,
        LINEAS,
      )
      expect(n).toBe(1)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones).toHaveLength(1)
      const r = d.renglones[0]
      expect(r.precioUnitario).toBe('1250.5')
      // El codigo es el NUESTRO (con el que se graba en Tango); la
      // descripcion es la del proveedor (la que el operador ve impresa).
      expect(r.codigo).toBe('106362')
      expect(r.descripcion).toBe('ZAPATILLA X')
      expect(r.remitoNcompInS).toBe('00003684')
      expect(r.remitoNRenglS).toBe(1)
      // Lo que entrego el remito viaja junto a lo facturado: es lo que deja
      // a la pantalla mostrar las dos cantidades enfrentadas sin volver a
      // consultar Tango (un remito consumido del todo desaparece de la
      // lista de pendientes, asi que releerlo no siempre es posible).
      expect(r.cantidadRemito).toBe('20')
    })
  })

  it('guarda sin link de remito el renglon que la factura cobra de mas', async () => {
    // Tiene que verse en pantalla: el cotejo ya lo marco como diferencia,
    // pero si no se guardara el operador no sabria que linea es.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarRenglonesFacturadosEn(
        tx,
        id,
        [{ lineaRemito: 0, descripcion: 'FLETE', cantidad: '1', precioUnitario: '5.000,00', bonificacion: null }],
        ORIGEN,
        LINEAS,
      )

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones).toHaveLength(1)
      expect(d.renglones[0].descripcion).toBe('FLETE')
      expect(d.renglones[0].remitoNcompInS).toBeNull()
      expect(d.renglones[0].codigo).toBeNull()
      // Sin renglon de remito no hay cantidad entregada contra la cual
      // cotejar: la pantalla muestra un guion, no un cero.
      expect(d.renglones[0].cantidadRemito).toBeNull()
    })
  })

  it('descuenta la bonificacion al calcular el importe', async () => {
    // Caso real (TOPPER, factura A 00531799): el precio impreso es el de
    // lista y la linea trae 7% de bonificacion. Guardar cantidad x precio
    // sin descontar inflaba ese comprobante en $139.341,24 y la suma de los
    // renglones no cerraba contra el neto gravado de la cabecera.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarRenglonesFacturadosEn(
        tx,
        id,
        [{
          lineaRemito: 1,
          descripcion: 'POLARIS KIDS',
          cantidad: '34',
          precioUnitario: '27.647,06',
          bonificacion: '7,00',
        }],
        ORIGEN,
        LINEAS,
      )

      const d = await obtenerDetalleEn(tx, id)
      const r = d.renglones[0]
      // El bruto se guarda tal cual: es lo que el operador ve en el papel.
      expect(r.precioUnitario).toBe('27647.06')
      expect(r.porcBonif).toBe('7')
      // 34 x 27647,06 x 0,93 = 874.200,03 (el PDF imprime 874.200,01: la
      // diferencia de centavos es del redondeo del proveedor, no nuestro).
      expect(Number(r.importe)).toBeCloseTo(874200.03, 1)
    })
  })

  it('sin bonificacion el importe es cantidad por precio', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarRenglonesFacturadosEn(
        tx,
        id,
        [{ lineaRemito: 1, descripcion: 'X', cantidad: '4', precioUnitario: '100,00', bonificacion: null }],
        ORIGEN,
        LINEAS,
      )
      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones[0].importe).toBe('400')
    })
  })
})

describe('observarRemitosEn', () => {
  it('manda a observacion y distingue el sin saldo del inexistente', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const observado = await observarRemitosEn(tx, id, {
        renglones: 0,
        sinSaldo: ['0001-00000001'],
        noEncontrados: ['0002-00000002'],
      })
      expect(observado).toBe(true)

      const r = await tx.request().input('id', sql.Int, id).query(
        'SELECT ESTADO, MOTIVO_OBSERVACION, NOTA_OBSERVACION FROM PHF_COMPROBANTE WHERE ID = @id',
      )
      const fila = r.recordset[0]
      expect(fila.ESTADO).toBe('observacion')
      expect(fila.MOTIVO_OBSERVACION).toBe(MOTIVO_REMITO_SIN_SALDO)
      // Los dos problemas piden acciones distintas, asi que la nota tiene
      // que nombrarlos por separado y no meterlos en una sola frase.
      const nota = String(fila.NOTA_OBSERVACION)
      expect(nota).toContain('0001-00000001')
      expect(nota).toMatch(/ya está facturado/i)
      expect(nota).toContain('0002-00000002')
      expect(nota).toMatch(/no aparece/i)
    })
  })

  it('no toca el comprobante cuando los remitos se cargaron bien', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const observado = await observarRemitosEn(tx, id, {
        renglones: 5,
        sinSaldo: [],
        noEncontrados: [],
      })
      expect(observado).toBe(false)

      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT ESTADO FROM PHF_COMPROBANTE WHERE ID = @id')
      expect(r.recordset[0].ESTADO).toBe('leido')
    })
  })
})

describe('observarDiferenciasEn', () => {
  const LINEAS = [
    {
      indice: 1,
      codArticulo: '106362',
      descripcion: 'TENDER ONE BOX',
      cantidad: 20,
      numeroRemito: 'R0000200006818',
    },
  ]

  it('manda a observacion con el detalle de la diferencia en la nota', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const diferencias = cotejarRenglones(
        [{ lineaRemito: 1, descripcion: 'X', cantidad: '24', precioUnitario: '100', bonificacion: null }],
        LINEAS,
      )

      expect(await observarDiferenciasEn(tx, id, diferencias)).toBe(true)

      const r = await tx.request().input('id', sql.Int, id).query(
        'SELECT ESTADO, MOTIVO_OBSERVACION, NOTA_OBSERVACION FROM PHF_COMPROBANTE WHERE ID = @id',
      )
      const fila = r.recordset[0]
      expect(fila.ESTADO).toBe('observacion')
      expect(fila.MOTIVO_OBSERVACION).toBe(MOTIVO_FACTURA_NO_COINCIDE)
      // El operador tiene que poder ir al papel sin abrir Tango: la nota
      // nombra el articulo, el remito y las dos cantidades.
      const nota = String(fila.NOTA_OBSERVACION)
      expect(nota).toContain('106362')
      expect(nota).toContain('R0000200006818')
      expect(nota).toContain('20')
      expect(nota).toContain('24')
    })
  })

  it('no toca el comprobante cuando la factura coincide con el remito', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const diferencias = cotejarRenglones(
        [{ lineaRemito: 1, descripcion: 'X', cantidad: '20', precioUnitario: '100', bonificacion: null }],
        LINEAS,
      )
      expect(diferencias).toEqual([])
      expect(await observarDiferenciasEn(tx, id, diferencias)).toBe(false)

      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT ESTADO FROM PHF_COMPROBANTE WHERE ID = @id')
      expect(r.recordset[0].ESTADO).toBe('leido')
    })
  })
})
