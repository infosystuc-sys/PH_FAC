import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { rm } from 'node:fs/promises'
import { conRollback } from '@/server/db/tx'
import { cerrarPool, getPool } from '@/server/db/pool'
import {
  importarComprobantes,
  elegirProveedorEn,
  confirmarComprobante,
  marcarObservacionEn,
  marcarObservacion,
  registrarComprobante as registrarComprobanteAccion,
  asignarRemitoEn,
  actualizarCantidadesRemitoEn,
  revalidarContraTangoEn,
} from '@/server/app/acciones'
import {
  eliminarComprobanteEn,
  eliminarComprobantesEnLote,
  elegirArticuloEn,
  asociarCodigosProveedorEnLote,
} from '@/server/app/acciones'
import {
  MOTIVOS_OBSERVACION,
  MOTIVO_SIN_CONCEPTO,
  MOTIVO_PROVEEDOR_INEXISTENTE,
} from '@/lib/observacion'
import { obtenerDetalleEn, guardarCampoEn, auditarEn } from '@/server/app/detalle'
import { insertarComprobantePrueba, insertarRenglonPrueba } from '@/server/app/comprobantes'

const creados: string[] = []

afterAll(async () => {
  for (const r of creados) await rm(r, { force: true })
  await cerrarPool()
})

const PDF = Buffer.from('%PDF-1.4 de prueba')

describe('importarComprobantes', () => {
  it('no deja ningun comprobante importado si un archivo del lote supera el limite de tamano', async () => {
    const pool = await getPool()
    const antes = await pool.request().query('SELECT COUNT(*) AS n FROM PHF_COMPROBANTE')

    const fd = new FormData()
    fd.append('archivos', new File([PDF], 'chico.pdf', { type: 'application/pdf' }))
    fd.append(
      'archivos',
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'grande.pdf', { type: 'application/pdf' }),
    )

    // El archivo grande es el segundo del lote: si la validacion no fuera
    // previa a la importacion, "chico.pdf" ya habria quedado commiteado en
    // 'procesando' antes de que el loop llegara a rechazar "grande.pdf".
    await expect(importarComprobantes(fd)).rejects.toThrow('grande.pdf supera los 10 MB.')

    const despues = await pool.request().query('SELECT COUNT(*) AS n FROM PHF_COMPROBANTE')
    expect(despues.recordset[0].n).toBe(antes.recordset[0].n)
  })

  it('rechaza un lote con un archivo que no es PDF ni imagen, sin importar nada', async () => {
    const pool = await getPool()
    const antes = await pool.request().query('SELECT COUNT(*) AS n FROM PHF_COMPROBANTE')

    const fd = new FormData()
    fd.append('archivos', new File([PDF], 'chico.pdf', { type: 'application/pdf' }))
    fd.append('archivos', new File([Buffer.from('no es un pdf')], 'no-es-pdf.txt', { type: 'text/plain' }))

    await expect(importarComprobantes(fd)).rejects.toThrow('no-es-pdf.txt no es un archivo PDF, JPG o PNG.')

    // Y renombrarlo a .pdf con MIME de PDF tampoco alcanza: el tipo se decide
    // por los primeros bytes (2026-09-16), porque el modelo rechaza un
    // `document` que no sea PDF de verdad.
    const fd2 = new FormData()
    fd2.append('archivos', new File([Buffer.from('no es un pdf')], 'disfrazado.pdf', { type: 'application/pdf' }))
    fd2.append('tipoFactura', 'conceptos')
    await expect(importarComprobantes(fd2)).rejects.toThrow('disfrazado.pdf no es un archivo PDF, JPG o PNG.')

    const despues = await pool.request().query('SELECT COUNT(*) AS n FROM PHF_COMPROBANTE')
    expect(despues.recordset[0].n).toBe(antes.recordset[0].n)
  })

  it('rechaza el lote sin importar nada si no vino el tipo de comprobante', async () => {
    // El tipo decide con que prompt lee la IA todo el lote. Caer a un
    // default en silencio dejaria un lote entero mal leido sin senal.
    const pool = await getPool()
    const antes = await pool.request().query('SELECT COUNT(*) AS n FROM PHF_COMPROBANTE')

    const fd = new FormData()
    fd.append('archivos', new File([PDF], 'chico.pdf', { type: 'application/pdf' }))

    await expect(importarComprobantes(fd)).rejects.toThrow(/tipo de comprobante/i)

    const despues = await pool.request().query('SELECT COUNT(*) AS n FROM PHF_COMPROBANTE')
    expect(despues.recordset[0].n).toBe(antes.recordset[0].n)
  })

  it('rechaza un tipo que no esta en el catalogo', async () => {
    const fd = new FormData()
    fd.append('tipoFactura', 'inventado')
    fd.append('archivos', new File([PDF], 'chico.pdf', { type: 'application/pdf' }))

    await expect(importarComprobantes(fd)).rejects.toThrow(/tipo de comprobante/i)
  })
})

describe('elegirProveedorEn', () => {
  it('guarda codprovee, desnormaliza RAZON_SOCIAL/COD_PROVEE y audita', async () => {
    // Se ejercita `elegirProveedorEn(tx, ...)` -- no el wrapper `elegirProveedor`,
    // que abre su propia conexión de pool -- para que corra dentro de la
    // misma transacción que insertó el comprobante de prueba. Si se usara el
    // pool real acá, el UPDATE (y el INSERT en PHF_AUDITORIA, que tiene FK a
    // PHF_COMPROBANTE) quedarían esperando el lock de esta transacción, que a
    // su vez no comitea hasta que el test termina: un deadlock por diseño del
    // test, no una carrera real. Mismo motivo por el que se lee con `tx` en
    // vez de `getPool()`/`obtenerDetalle`.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await elegirProveedorEn(tx, id, '010151', 'AMX ARGENTINA SOCIEDAD ANONIMA', true)

      const detalle = await obtenerDetalleEn(tx, id)
      const campo = detalle.campos.find((c) => c.clave === 'codprovee')
      expect(campo?.valorFinal).toBe('010151')
      expect(campo?.corregido).toBe(true)

      const fila = await tx
        .request()
        .input('id', sql.Int, id)
        .query(`SELECT COD_PROVEE, RAZON_SOCIAL FROM PHF_COMPROBANTE WHERE ID=@id`)
      expect(fila.recordset[0].COD_PROVEE).toBe('010151')
      expect(fila.recordset[0].RAZON_SOCIAL).toBe('AMX ARGENTINA SOCIEDAD ANONIMA')

      expect(detalle.auditoria.some((a) => a.texto.includes('AMX'))).toBe(true)
    })
  })
})

describe('confirmarComprobante con validaciones bloqueantes', () => {
  it('rechaza confirmar si el proveedor no esta resuelto', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      // Sin CUIT resuelto: 0 matches de proveedor -> bloqueante.
      await expect(confirmarComprobante(id)).rejects.toThrow(/validaciones/i)
    })
  })
})

describe('marcarObservacion', () => {
  it('rechaza un motivo que no esta en la lista cerrada', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await expect(marcarObservacionEn(tx, id, 'motivo inventado', '')).rejects.toThrow(/motivo/i)
    })
  })

  it('escribe estado, motivo, nota y la entrada de auditoria', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await marcarObservacionEn(tx, id, MOTIVOS_OBSERVACION[0], 'nota de prueba')

      const fila = await tx
        .request()
        .input('id', sql.Int, id)
        .query(`SELECT ESTADO, MOTIVO_OBSERVACION, NOTA_OBSERVACION FROM PHF_COMPROBANTE WHERE ID=@id`)
      expect(fila.recordset[0].ESTADO).toBe('observacion')
      expect(fila.recordset[0].MOTIVO_OBSERVACION).toBe(MOTIVOS_OBSERVACION[0])
      expect(fila.recordset[0].NOTA_OBSERVACION).toBe('nota de prueba')

      const detalle = await obtenerDetalleEn(tx, id)
      expect(detalle.auditoria.some((a) => a.texto.includes(MOTIVOS_OBSERVACION[0]))).toBe(true)
    })
  })

  it('rechaza marcar en observacion un comprobante registrado', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'registrado' })
      await expect(marcarObservacionEn(tx, id, MOTIVOS_OBSERVACION[0], '')).rejects.toThrow()
    })
  })
})

describe('registrarComprobante (server action)', () => {
  it('rechaza si el comprobante no esta confirmado', async () => {
    // `registrarComprobanteAccion` abre su propia transaccion sobre el pool
    // real -- un conRollback de afuera no le sirve de nada (READ_COMMITTED_
    // SNAPSHOT hace que no vea la fila sin commitear, mismo criterio que
    // documento Fase 3). Se inserta fuera de cualquier transaccion y se
    // borra a mano al final.
    const pool = await getPool()
    const id = await insertarComprobantePrueba(pool as unknown as sql.Transaction, { estado: 'leido' })
    try {
      await expect(registrarComprobanteAccion(id)).rejects.toThrow()
    } finally {
      await pool.request().input('id', sql.Int, id).query('DELETE FROM PHF_COMPROBANTE WHERE ID=@id')
    }
  })
})

describe('asignarRemitoEn', () => {
  it('guarda el link al renglon de remito', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: '106817', descripcion: 'Articulo', cantidad: '4',
        precioUnitario: '80745.57', importe: '322982.28',
      })

      await asignarRemitoEn(tx, renglonId, '00003805', 1, 'R0000100029869')

      const r = await tx.request().input('id', sql.Int, renglonId)
        .query(`SELECT REMITO_NCOMP_IN_S, REMITO_N_RENGL_S, REMITO_NUMERO FROM PHF_RENGLON WHERE ID=@id`)
      expect(String(r.recordset[0].REMITO_NCOMP_IN_S).trim()).toBe('00003805')
      expect(Number(r.recordset[0].REMITO_N_RENGL_S)).toBe(1)
      expect(String(r.recordset[0].REMITO_NUMERO).trim()).toBe('R0000100029869')
    })
  })

  it('desasigna con null', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: '106817', descripcion: 'Articulo', cantidad: '4',
        precioUnitario: '80745.57', importe: '322982.28',
      })
      await asignarRemitoEn(tx, renglonId, '00003805', 1, 'R0000100029869')
      await asignarRemitoEn(tx, renglonId, null, null, null)

      const r = await tx.request().input('id', sql.Int, renglonId)
        .query(`SELECT REMITO_NCOMP_IN_S, REMITO_N_RENGL_S, REMITO_NUMERO FROM PHF_RENGLON WHERE ID=@id`)
      expect(r.recordset[0].REMITO_NCOMP_IN_S).toBeNull()
      expect(r.recordset[0].REMITO_N_RENGL_S).toBeNull()
      expect(r.recordset[0].REMITO_NUMERO).toBeNull()
    })
  })
})

describe('actualizarCantidadesRemitoEn', () => {
  // Remito real 00003805, renglón 1: 106817 (microondas), cantidad
  // entregada 4 -- el mismo que usa 'asignarRemitoEn' arriba. Esta
  // completamente facturado en Tango (CANT_PEND=0), a proposito: prueba
  // que la funcion no se apoya en el filtro de saldo que usa
  // buscarRemitosPendientes, que lo dejaria afuera.
  it('corrige la cantidad guardada si Tango tiene otra hoy', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: '106817', descripcion: 'Articulo', cantidad: '4',
        precioUnitario: '80745.57', importe: '322982.28',
      })
      // Se simula una desactualizacion: la foto guardada dice 999, Tango
      // hoy dice 4 (verificado contra la base real antes de este test).
      await asignarRemitoEn(tx, renglonId, '00003805', 1, 'R0000100029869', 999)

      const actualizados = await actualizarCantidadesRemitoEn(tx, id)
      expect(actualizados).toBe(1)

      const r = await tx.request().input('id', sql.Int, renglonId)
        .query('SELECT CANTIDAD_REMITO FROM PHF_RENGLON WHERE ID=@id')
      expect(Number(r.recordset[0].CANTIDAD_REMITO)).toBe(4)
    })
  })

  it('no cuenta ni toca un renglon que ya esta al dia', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: '106817', descripcion: 'Articulo', cantidad: '4',
        precioUnitario: '80745.57', importe: '322982.28',
      })
      await asignarRemitoEn(tx, renglonId, '00003805', 1, 'R0000100029869', 4)

      const actualizados = await actualizarCantidadesRemitoEn(tx, id)
      expect(actualizados).toBe(0)
    })
  })

  it('no hace nada si ningun renglon tiene remito asignado', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await insertarRenglonPrueba(tx, id, {
        codigo: 'SRV', descripcion: 'Sin remito', cantidad: '1',
        precioUnitario: '100.00', importe: '100.00',
      })

      const actualizados = await actualizarCantidadesRemitoEn(tx, id)
      expect(actualizados).toBe(0)
    })
  })
})

describe('eliminarComprobanteEn', () => {
  it('borra el comprobante y todo lo que cuelga de el', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'cuit', '30-71042636-9')
      await insertarRenglonPrueba(tx, id, {
        codigo: 'SRV', descripcion: 'Servicio', cantidad: '1',
        precioUnitario: '100.00', importe: '100.00',
      })
      await auditarEn(tx, id, 'algo que paso')

      const r = await eliminarComprobanteEn(tx, id)
      expect(r.id).toBe(id)
      expect(r.estado).toBe('leido')

      // Las FK son ON DELETE CASCADE (ver scripts/migrate.ts): la cabecera
      // se lleva campos, renglones y auditoria. Si alguien alguna vez
      // recrea las tablas sin el cascade, esto lo agarra.
      for (const tabla of ['PHF_CAMPO', 'PHF_RENGLON', 'PHF_AUDITORIA']) {
        const q = await tx
          .request()
          .input('id', sql.Int, id)
          .query(`SELECT COUNT(*) AS n FROM ${tabla} WHERE COMPROBANTE_ID = @id`)
        expect(q.recordset[0].n, `quedaron filas en ${tabla}`).toBe(0)
      }

      const cab = await tx
        .request()
        .input('id', sql.Int, id)
        .query('SELECT COUNT(*) AS n FROM PHF_COMPROBANTE WHERE ID = @id')
      expect(cab.recordset[0].n).toBe(0)
    })
  })

  it('devuelve el asiento de Tango de un comprobante ya registrado', async () => {
    // Es lo que la pantalla necesita para advertir que el asiento queda.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await tx
        .request()
        .input('id', sql.Int, id)
        .query(`
          UPDATE PHF_COMPROBANTE
          SET ESTADO = 'registrado', TANGO_N_COMP = '0003-00018742'
          WHERE ID = @id
        `)

      const r = await eliminarComprobanteEn(tx, id)
      expect(r.estado).toBe('registrado')
      expect(r.tangoNComp).toBe('0003-00018742')
    })
  })

  it('lanza si el comprobante no existe, y no dice que lo borro', async () => {
    await conRollback(async (tx) => {
      await expect(eliminarComprobanteEn(tx, 999_999_999)).rejects.toThrow(/no existe/i)
    })
  })

  it('eliminar dos veces el mismo comprobante falla la segunda', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await eliminarComprobanteEn(tx, id)
      await expect(eliminarComprobanteEn(tx, id)).rejects.toThrow(/no existe/i)
    })
  })
})

describe('eliminarComprobantesEnLote', () => {
  // `eliminarComprobantesEnLote` reusa el `eliminarComprobante` real (borra
  // el PDF, pega contra el pool) -- mismo motivo que `importarComprobantes`
  // (plural) tampoco se ejercita con exito real acá: no hay forma de
  // revertirlo con conRollback. Lo que sí se prueba sin tocar nada real es
  // el conteo de fallidos con ids que no existen.
  it('con ids que no existen, cuenta todo como fallido sin tirar', async () => {
    const r = await eliminarComprobantesEnLote([999_999_998, 999_999_999])
    expect(r).toEqual({ eliminados: 0, fallidos: 2 })
  })

  it('con un array vacio no hace nada', async () => {
    const r = await eliminarComprobantesEnLote([])
    expect(r).toEqual({ eliminados: 0, fallidos: 0 })
  })
})

describe('elegirArticuloEn', () => {
  it('guarda la correccion sin pisar lo que resolvio el sistema', async () => {
    // Mismo criterio que VALOR_IA/VALOR_FINAL en PHF_CAMPO: CODIGO_IA queda
    // intacto o se pierde la medicion de que tan bien empareja el modelo.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: 'MAL-EMPAREJADO', descripcion: 'X', cantidad: '1',
        precioUnitario: '100', importe: '100',
      })

      await elegirArticuloEn(tx, renglonId, '27383  001 27')

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones[0].codigoFinal).toBe('27383  001 27')
      expect(d.renglones[0].codigo).toBe('MAL-EMPAREJADO')
    })
  })

  it('con null descarta la correccion y vuelve a lo automatico', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: 'AUTO', descripcion: 'X', cantidad: '1',
        precioUnitario: '100', importe: '100',
      })

      await elegirArticuloEn(tx, renglonId, '27383  001 27')
      await elegirArticuloEn(tx, renglonId, null)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones[0].codigoFinal).toBeNull()
      expect(d.renglones[0].codigo).toBe('AUTO')
    })
  })

  it('trata una cadena vacia como descarte, no como codigo vacio', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: 'AUTO', descripcion: 'X', cantidad: '1',
        precioUnitario: '100', importe: '100',
      })
      await elegirArticuloEn(tx, renglonId, '   ')
      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones[0].codigoFinal).toBeNull()
    })
  })
})

describe('asignarRemitoEn al reapuntar un renglon', () => {
  it('guarda la cantidad entregada y descarta la correccion de articulo', async () => {
    // El articulo lo define el renglon del remito: una correccion manual
    // anterior apuntaba a otro, y dejarla pegada mostraria un articulo que
    // no es el del remito recien elegido.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: 'X', descripcion: 'X', cantidad: '1',
        precioUnitario: '100', importe: '100',
      })
      await elegirArticuloEn(tx, renglonId, 'CORREGIDO-ANTES')

      await asignarRemitoEn(tx, renglonId, '00003684', 7, 'R0000200006818', 6)

      const d = await obtenerDetalleEn(tx, id)
      const r = d.renglones[0]
      expect(r.remitoNcompInS).toBe('00003684')
      expect(r.remitoNRenglS).toBe(7)
      expect(r.remitoNumero).toBe('R0000200006818')
      expect(r.cantidadRemito).toBe('6')
      expect(r.codigoFinal).toBeNull()
    })
  })

  it('al sacar el remito deja la cantidad entregada en null, no en cero', async () => {
    // Sin renglon de remito no hay cantidad contra la cual cotejar: un cero
    // se leeria como que entregaron cero.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: 'X', descripcion: 'X', cantidad: '1',
        precioUnitario: '100', importe: '100',
      })
      await asignarRemitoEn(tx, renglonId, '00003684', 7, 'R0000200006818', 6)
      await asignarRemitoEn(tx, renglonId, null, null, null, null)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones[0].remitoNcompInS).toBeNull()
      expect(d.renglones[0].cantidadRemito).toBeNull()
    })
  })
})

describe('asociarCodigosProveedorEnLote', () => {
  // No se ejercita el camino que escribe de verdad: `asociarArticuloProveedor`
  // usa getPool() (no una transaccion propia, ver el comentario en
  // acciones.ts), asi que llamarlo de verdad pegaria contra CPA15 real sin
  // poder revertirlo -- mismo motivo por el que `asociarArticuloProveedor`
  // (tests/server/tango/articulos.test.ts) tampoco se llama directo, solo
  // se reproduce su MERGE dentro de un conRollback. Lo que sí se puede
  // probar sin tocar nada es el camino vacio.
  it('sin pares no toca nada y devuelve 0', async () => {
    const n = await asociarCodigosProveedorEnLote(999999999, '010685', [])
    expect(n).toBe(0)
  })
})

describe('revalidarContraTangoEn', () => {
  /** Un CUIT de CPA01 que resuelve a un solo proveedor. */
  async function cuitUnico(): Promise<{ cuit: string; cod: string }> {
    const pool = await getPool()
    const r = await pool.request().query(`
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
    return { cuit: String(r.recordset[0].cuit), cod: String(r.recordset[0].cod) }
  }

  async function filaDe(tx: sql.Transaction, id: number) {
    const r = await tx.request().input('id', sql.Int, id).query(
      'SELECT ESTADO, MOTIVO_OBSERVACION, COD_PROVEE FROM PHF_COMPROBANTE WHERE ID = @id',
    )
    return r.recordset[0]
  }

  it('resuelve el proveedor con el CUIT corregido a mano, sin tocar las demas correcciones', async () => {
    const real = await cuitUnico()
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'observacion' })
      await tx.request().input('id', sql.Int, id).input('m', sql.NVarChar(60), MOTIVO_PROVEEDOR_INEXISTENTE)
        .query('UPDATE PHF_COMPROBANTE SET MOTIVO_OBSERVACION = @m WHERE ID = @id')
      await guardarCampoEn(tx, id, 'cuit', real.cuit, { corregidoPorUsuario: true })
      await guardarCampoEn(tx, id, 'nro', '00001234', { corregidoPorUsuario: true })

      const r = await revalidarContraTangoEn(tx, id)
      expect(r.cambios.join(' ')).toContain(real.cod)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.campos.find((c) => c.clave === 'codprovee')?.valorFinal).toBe(real.cod)
      // Lo corregido a mano sigue ahi: es la diferencia con "Reprocesar".
      const nro = d.campos.find((c) => c.clave === 'nro')!
      expect(nro.valorFinal).toBe('00001234')
      expect(nro.corregido).toBe(true)

      const fila = await filaDe(tx, id)
      expect(fila.ESTADO).toBe('leido')
      expect(fila.MOTIVO_OBSERVACION).toBeNull()
      expect(d.auditoria.some((a) => a.texto.startsWith('Revalidado contra Tango'))).toBe(true)
    })
  })

  it('no pisa un proveedor ya elegido ni levanta una observacion que puso el operador', async () => {
    const real = await cuitUnico()
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'observacion' })
      await tx.request().input('id', sql.Int, id).input('m', sql.NVarChar(60), MOTIVOS_OBSERVACION[0])
        .query('UPDATE PHF_COMPROBANTE SET MOTIVO_OBSERVACION = @m WHERE ID = @id')
      await guardarCampoEn(tx, id, 'cuit', real.cuit, { corregidoPorUsuario: false })
      await guardarCampoEn(tx, id, 'codprovee', 'OTRO01', { corregidoPorUsuario: true })

      const r = await revalidarContraTangoEn(tx, id)
      expect(r.cambios).toEqual([])

      const d = await obtenerDetalleEn(tx, id)
      expect(d.campos.find((c) => c.clave === 'codprovee')?.valorFinal).toBe('OTRO01')
      const fila = await filaDe(tx, id)
      expect(fila.ESTADO).toBe('observacion')
      expect(fila.MOTIVO_OBSERVACION).toBe(MOTIVOS_OBSERVACION[0])
    })
  })

  it('saca de observacion la factura de conceptos cuando el proveedor ya tiene concepto', async () => {
    const pool = await getPool()
    const c = await pool.request().query(
      'SELECT TOP 1 LTRIM(RTRIM(COD_PROVEE)) AS cod FROM CPA_CONCEPTOS_PROVEEDOR ORDER BY COD_PROVEE',
    )
    if (c.recordset.length === 0) return
    const cod = String(c.recordset[0].cod)

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'observacion', tipoFactura: 'conceptos' })
      await tx.request().input('id', sql.Int, id).input('m', sql.NVarChar(60), MOTIVO_SIN_CONCEPTO)
        .query('UPDATE PHF_COMPROBANTE SET MOTIVO_OBSERVACION = @m WHERE ID = @id')
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos', { corregidoPorUsuario: false })
      await guardarCampoEn(tx, id, 'codprovee', cod, { corregidoPorUsuario: false })

      await revalidarContraTangoEn(tx, id)
      const fila = await filaDe(tx, id)
      expect(fila.ESTADO).toBe('leido')
      expect(fila.MOTIVO_OBSERVACION).toBeNull()
    })
  })

  it('actualiza lo pendiente de la OC con lo que dice Tango hoy', async () => {
    const pool = await getPool()
    const o = await pool.request().query(`
      SELECT TOP 1 N_ORDEN_CO, TALONARIO, N_RENGL_OC, COD_ARTICU, PENDIENTE_FACTURAR
      FROM CPA36 WHERE PENDIENTE_FACTURAR > 0 ORDER BY N_ORDEN_CO DESC
    `)
    if (o.recordset.length === 0) return
    const oc = o.recordset[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido', tipoFactura: 'articulos' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'articulos', { corregidoPorUsuario: false })
      const renglonId = await insertarRenglonPrueba(tx, id, {
        codigo: String(oc.COD_ARTICU), descripcion: 'x', cantidad: '1', precioUnitario: '1', importe: '1',
      })
      // La foto vieja: al imputarla, la orden no tenia nada pendiente.
      await tx.request()
        .input('id', sql.Int, renglonId)
        .input('oc', sql.VarChar(14), String(oc.N_ORDEN_CO))
        .input('tal', sql.Int, Number(oc.TALONARIO))
        .input('r', sql.Int, Number(oc.N_RENGL_OC))
        .query(`
          UPDATE PHF_RENGLON
          SET OC_N_ORDEN_CO=@oc, OC_TALONARIO=@tal, OC_N_RENGL_OC=@r, OC_PENDIENTE=0
          WHERE ID=@id`)

      const r = await revalidarContraTangoEn(tx, id)
      expect(r.cambios.some((x) => x.includes('pendiente de OC'))).toBe(true)

      const d = await obtenerDetalleEn(tx, id)
      expect(Number(d.renglones[0].ocPendiente)).toBeCloseTo(Number(oc.PENDIENTE_FACTURAR), 2)
    })
  })

  it('rechaza un comprobante ya registrado o sin lectura terminada', async () => {
    await conRollback(async (tx) => {
      const registrado = await insertarComprobantePrueba(tx, { estado: 'registrado' })
      await expect(revalidarContraTangoEn(tx, registrado)).rejects.toThrow(/ya está en Tango/)
      const enError = await insertarComprobantePrueba(tx, { estado: 'error' })
      await expect(revalidarContraTangoEn(tx, enError)).rejects.toThrow(/Reprocesar/)
    })
  })
})
