import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { conRollback } from '@/server/db/tx'
import { getPool, cerrarPool } from '@/server/db/pool'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { obtenerDetalleEn } from '@/server/app/detalle'
import {
  aprenderArticuloEn,
  marcarSinOcEn,
  articulosPorDescripcionEn,
} from '@/server/app/articulosProveedor'
import { vincularDescripcionArticuloEn, comprobanteCerradoEn } from '@/server/app/acciones'
import { normalizarDescripcionArticulo } from '@/lib/matchOc'
import {
  agregarOcEn,
  quitarOcEn,
  ocsDelComprobanteEn,
  renglonesSinOcEn,
  recalcularAVincularEn,
  sincronizarCargosEn,
  lineasPdfResueltasEn,
} from '@/server/app/ordenCompra'
import { buscarOcPendientes, type OrdenCompra } from '@/server/tango/ordenesCompra'

afterAll(async () => {
  await cerrarPool()
})

/**
 * Escribe solo en PHF_RENGLON / PHF_RENGLON_PDF (tablas propias) y dentro de
 * conRollback. De Tango solo lee: las OC son reales, no se crean ni se tocan.
 */
async function unProveedorConOc(minimoDeOc = 1) {
  const pool = await getPool()
  const r = await pool.request().query(`
    SELECT TOP 1 LTRIM(RTRIM(h.COD_PROVEE)) AS cod
    FROM CPA35 h JOIN CPA36 g ON g.N_ORDEN_CO = h.N_ORDEN_CO
    WHERE ISNULL(g.PENDIENTE_FACTURAR, 0) > 0
    GROUP BY h.COD_PROVEE
    HAVING COUNT(DISTINCT h.N_ORDEN_CO) >= ${minimoDeOc}
    ORDER BY COUNT(*) DESC
  `)
  if (r.recordset.length === 0) return null
  const cod = String(r.recordset[0].cod)
  return { codProvee: cod, ocs: await buscarOcPendientes(cod) }
}

/** El detalle que la IA leyó del PDF: es contra esto que se empareja la OC. */
async function renglonesPdf(
  tx: sql.Transaction,
  id: number,
  lineas: { codigo: string; cantidad: string }[],
) {
  let orden = 0
  for (const l of lineas) {
    orden += 1
    await tx
      .request()
      .input('id', sql.Int, id)
      .input('orden', sql.Int, orden)
      .input('cod', sql.NVarChar(60), l.codigo)
      .input('cant', sql.NVarChar(40), l.cantidad)
      .query(`
        INSERT INTO PHF_RENGLON_PDF (COMPROBANTE_ID, ORDEN, CODIGO, CANTIDAD)
        VALUES (@id, @orden, @cod, @cant)
      `)
  }
}

/** Un renglón de la OC que sirva de "artículo que la factura cobra". */
function primerRenglon(oc: OrdenCompra) {
  return oc.renglones[0]
}

describe('agregarOcEn', () => {
  it('trae SOLO los articulos que la factura cobra, no la OC entera', async () => {
    // Es el cambio del 2026-09-07: antes traia los N renglones pendientes de
    // la orden y el operador tenia que borrar los que la factura no cobraba.
    const p = await unProveedorConOc()
    const oc = p!.ocs.find((o) => o.renglones.length > 1) ?? p!.ocs[0]
    const uno = primerRenglon(oc)

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: uno.codArticu, cantidad: '1' }])

      const r = await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)
      expect(r.agregados).toBe(1)
      expect(r.sinEmparejar).toBe(0)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones).toHaveLength(1)
      expect(d.renglones[0].codigo).toBe(uno.codArticu)
    })
  })

  it('la cantidad es la que factura el proveedor, no lo pendiente de la OC', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]
    const uno = primerRenglon(oc)

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: uno.codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      const d = await obtenerDetalleEn(tx, id)
      expect(Number(d.renglones[0].cantidad)).toBeCloseTo(1, 4)
      // El precio si sale de la OC, que es el pactado, y lo pendiente se
      // congela para poder mostrarlo despues.
      expect(Number(d.renglones[0].precioUnitario)).toBeCloseTo(uno.precio, 2)
      expect(Number(d.renglones[0].ocPendiente)).toBeCloseTo(uno.pendienteFacturar, 2)
    })
  })

  it('guarda la clave que despues va a CPA_OC_FACTURA', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]
    const uno = primerRenglon(oc)

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: uno.codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones[0].ocNOrdenCo).toBe(oc.nOrdenCo)
      expect(d.renglones[0].ocTalonario).toBe(oc.talonario)
      expect(d.renglones[0].ocNRenglOc).toBe(uno.nRenglOc)
    })
  })

  it('cuenta los renglones de la factura que esta OC no tiene', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]
    const uno = primerRenglon(oc)

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [
        { codigo: uno.codArticu, cantidad: '1' },
        { codigo: 'NO-ESTA-EN-NINGUNA-OC', cantidad: '5' },
      ])

      const r = await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)
      expect(r.agregados).toBe(1)
      expect(r.sinEmparejar).toBe(1)
    })
  })

  it('imputar OTRA orden agrega, no reemplaza: una factura puede partirse', async () => {
    const p = await unProveedorConOc(2)
    if (!p) return // ningun proveedor con dos OC hoy
    const [a, b] = p.ocs

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [
        { codigo: primerRenglon(a).codArticu, cantidad: '1' },
        { codigo: primerRenglon(b).codArticu, cantidad: '1' },
      ])

      await agregarOcEn(tx, id, a.nOrdenCo, p.codProvee)
      await agregarOcEn(tx, id, b.nOrdenCo, p.codProvee)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones).toHaveLength(2)
      expect(new Set(d.renglones.map((r) => r.ocNOrdenCo)).size).toBe(2)
      // ORDEN es UNIQUE por comprobante: la segunda sigue desde donde quedo
      // la primera en vez de arrancar de 1 y chocar.
      expect(new Set(d.renglones.map((r) => r.orden)).size).toBe(2)
    })
  })

  it('imputar LA MISMA orden dos veces no duplica nada', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]
    const uno = primerRenglon(oc)

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: uno.codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones).toHaveLength(1)
    })
  })

  it('no imputa sin renglones leidos del PDF: no habria con que emparejar', async () => {
    const p = await unProveedorConOc()
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await expect(agregarOcEn(tx, id, p!.ocs[0].nOrdenCo, p!.codProvee)).rejects.toThrow(
        /renglones de la factura/i,
      )
    })
  })

  it('falla con un numero de OC que no existe', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await expect(agregarOcEn(tx, id, 'NO EXISTE', null)).rejects.toThrow(/no existe/)
    })
  })

  it('deja la entrada de auditoria con el numero de OC', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: primerRenglon(oc).codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.auditoria.some((a) => a.texto.includes(oc.nOrdenCo.trim()))).toBe(true)
    })
  })
})

describe('quitarOcEn', () => {
  it('saca la orden con los renglones que trajo', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: primerRenglon(oc).codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      expect(await quitarOcEn(tx, id, oc.nOrdenCo)).toBe(1)
      expect(await ocsDelComprobanteEn(tx, id)).toEqual([])
    })
  })
})

describe('ocsDelComprobanteEn', () => {
  it('arranca vacio y despues trae la imputada', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      expect(await ocsDelComprobanteEn(tx, id)).toEqual([])

      await renglonesPdf(tx, id, [{ codigo: primerRenglon(oc).codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)
      expect(await ocsDelComprobanteEn(tx, id)).toEqual([oc.nOrdenCo])
    })
  })
})

describe('renglonesSinOcEn', () => {
  it('lista lo que la factura cobra y ninguna orden imputada cubre', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [
        { codigo: primerRenglon(oc).codArticu, cantidad: '1' },
        { codigo: 'NO-ESTA-EN-NINGUNA-OC', cantidad: '5' },
      ])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      const faltan = await renglonesSinOcEn(tx, id, p!.codProvee)
      expect(faltan).toHaveLength(1)
      expect(faltan[0].codigo).toBe('NO-ESTA-EN-NINGUNA-OC')
    })
  })

  it('queda vacio cuando todos los renglones tienen su orden', async () => {
    // Es la condicion para poder registrar -- decision del usuario.
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: primerRenglon(oc).codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      expect(await renglonesSinOcEn(tx, id, p!.codProvee)).toEqual([])
    })
  })
})

describe('vincular por descripcion (renglones sin codigo)', () => {
  // Hay proveedores que no imprimen codigo de articulo (2026-09-17): el
  // operador vincula la descripcion una vez y las facturas siguientes del
  // mismo proveedor emparejan solas. Escribe en PHF_ARTICULO_PROVEEDOR,
  // tabla propia, dentro de conRollback.
  async function renglonSinCodigo(tx: sql.Transaction, id: number, descripcion: string, cantidad: string) {
    await tx
      .request()
      .input('id', sql.Int, id)
      .input('desc', sql.NVarChar(300), descripcion)
      .input('cant', sql.NVarChar(40), cantidad)
      .query(`
        INSERT INTO PHF_RENGLON_PDF (COMPROBANTE_ID, ORDEN, CODIGO, DESCRIPCION, CANTIDAD)
        VALUES (@id, 1, NULL, @desc, @cant)
      `)
  }

  it('sin nada aprendido, el renglon queda sin orden y el comprobante a vincular', async () => {
    const p = await unProveedorConOc()

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonSinCodigo(tx, id, 'SMART TV 40" FHD PHILIPS', '15')

      const faltan = await renglonesSinOcEn(tx, id, p!.codProvee)
      expect(faltan).toHaveLength(1)
      expect(faltan[0].codigo).toBe('')
      expect(faltan[0].descripcion).toBe('SMART TV 40" FHD PHILIPS')
      expect(faltan[0].porDescripcion).toBe(false)

      expect(await recalcularAVincularEn(tx, id, p!.codProvee)).toBe(1)
      const fila = await tx.request().input('id', sql.Int, id)
        .query('SELECT RENGLONES_A_VINCULAR AS n FROM PHF_COMPROBANTE WHERE ID = @id')
      expect(Number(fila.recordset[0].n)).toBe(1)
    })
  })

  it('vinculada la descripcion, el renglon empareja con la OC y deja de estar a vincular', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]
    const articulo = primerRenglon(oc).codArticu

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonSinCodigo(tx, id, 'Smart TV 40" FHD Philips', '1')

      // Lo que hace el operador desde la tarjeta de la OC. Con otra grafia
      // (mayusculas, espacios) a proposito: la clave es la normalizada.
      await aprenderArticuloEn(tx, p!.codProvee, '  SMART  TV 40" FHD  PHILIPS ', articulo)
      expect(await recalcularAVincularEn(tx, id, p!.codProvee)).toBe(0)

      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)
      const detalle = await obtenerDetalleEn(tx, id)
      const conOc = detalle.renglones.filter((r) => r.ocNOrdenCo)
      expect(conOc).toHaveLength(1)
      expect(conOc[0].codigo).toBe(articulo)
      expect(conOc[0].pdfOrden).toBe(1)
      expect(await renglonesSinOcEn(tx, id, p!.codProvee)).toEqual([])
    })
  })

  it('si la factura trae codigo, la descripcion aprendida no lo pisa', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await tx.request().input('id', sql.Int, id)
        .query(`INSERT INTO PHF_RENGLON_PDF (COMPROBANTE_ID, ORDEN, CODIGO, DESCRIPCION, CANTIDAD)
                VALUES (@id, 1, 'NO-ESTA-EN-NINGUNA-OC', 'algo', '1')`)
      await aprenderArticuloEn(tx, p!.codProvee, 'algo', primerRenglon(oc).codArticu)

      const faltan = await renglonesSinOcEn(tx, id, p!.codProvee)
      expect(faltan).toHaveLength(1)
      expect(faltan[0].codigo).toBe('NO-ESTA-EN-NINGUNA-OC')
      expect(faltan[0].porDescripcion).toBe(false)
    })
  })
})

describe('cargos del proveedor: renglones sin orden de compra', () => {
  // 2026-09-22, pedido del usuario. Escribe solo en tablas propias y dentro
  // de conRollback.
  async function renglonSinCodigo(tx: sql.Transaction, id: number, orden: number, descripcion: string) {
    await tx
      .request()
      .input('id', sql.Int, id).input('orden', sql.Int, orden)
      .input('desc', sql.NVarChar(300), descripcion)
      .query(`
        INSERT INTO PHF_RENGLON_PDF (COMPROBANTE_ID, ORDEN, CODIGO, DESCRIPCION, CANTIDAD, PRECIO_IMPRESO, SUBTOTAL_IMPRESO)
        VALUES (@id, @orden, NULL, @desc, 1, 38429.75, 38429.75)`)
  }

  it('un cargo se registra como renglon sin OC y no bloquea el cotejo', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]
    const articulo = primerRenglon(oc).codArticu

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: articulo, cantidad: '1' }])
      await renglonSinCodigo(tx, id, 2, 'GESTION DE COMPRA 1%')

      // El operador lo vincula a un articulo Y lo marca como cargo. Se usa
      // el mismo articulo de la OC a proposito: es el caso dificil, porque
      // "esta en una OC" no alcanza para distinguirlo de un renglon normal.
      await aprenderArticuloEn(tx, p!.codProvee, 'GESTION DE COMPRA 1%', articulo, true)

      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)
      await sincronizarCargosEn(tx, id, p!.codProvee)

      const detalle = await obtenerDetalleEn(tx, id)
      const conOc = detalle.renglones.filter((r) => r.ocNOrdenCo)
      const cargos = detalle.renglones.filter((r) => !r.ocNOrdenCo)
      expect(conOc).toHaveLength(1)
      expect(conOc[0].pdfOrden).toBe(1)
      // El cargo es un renglon como cualquiera --llega a CPA46 y al asiento--
      // pero sin orden.
      expect(cargos).toHaveLength(1)
      expect(cargos[0].codigo).toBe(articulo)
      expect(cargos[0].pdfOrden).toBe(2)
      expect(cargos[0].ocNOrdenCo).toBeNull()

      // Y no figura como faltante: no va contra ninguna orden.
      expect(await renglonesSinOcEn(tx, id, p!.codProvee)).toEqual([])
    })
  })

  it('desmarcarlo saca el renglon de cargo', async () => {
    const p = await unProveedorConOc()

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonSinCodigo(tx, id, 1, 'GESTION ROSARIO LOGISTICA S.A.')
      await aprenderArticuloEn(tx, p!.codProvee, 'GESTION ROSARIO LOGISTICA S.A.', '106999', true)
      await sincronizarCargosEn(tx, id, p!.codProvee)
      expect((await obtenerDetalleEn(tx, id)).renglones).toHaveLength(1)

      await marcarSinOcEn(tx, p!.codProvee, 'GESTION ROSARIO LOGISTICA S.A.', false)
      await sincronizarCargosEn(tx, id, p!.codProvee)
      expect((await obtenerDetalleEn(tx, id)).renglones).toHaveLength(0)
      // Y vuelve a exigir orden de compra.
      expect(await renglonesSinOcEn(tx, id, p!.codProvee)).toHaveLength(1)
    })
  })
})

describe('ensenar una descripcion en un comprobante cerrado', () => {
  // 2026-10-07, decision del usuario. Los proveedores que todavia se cargan
  // a mano en Tango dejan todos sus comprobantes en 'existente', asi que si
  // ensenar estuviera bloqueado ahi la app no podria aprender nunca --
  // SPRINGWALL/VAZQUEZ es el caso que lo destapo. Se permite, pero lo que
  // se guarda es del PROVEEDOR: el comprobante cerrado no se toca.
  async function renglonSinCodigo(tx: sql.Transaction, id: number, orden: number, descripcion: string) {
    await tx
      .request()
      .input('id', sql.Int, id).input('orden', sql.Int, orden)
      .input('desc', sql.NVarChar(300), descripcion)
      .query(`
        INSERT INTO PHF_RENGLON_PDF (COMPROBANTE_ID, ORDEN, CODIGO, DESCRIPCION, CANTIDAD, PRECIO_IMPRESO, SUBTOTAL_IMPRESO)
        VALUES (@id, @orden, NULL, @desc, 1, 1000, 1000)`)
  }

  it('reconoce que un comprobante registrado o existente esta cerrado', async () => {
    await conRollback(async (tx) => {
      const leido = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const registrado = await insertarComprobantePrueba(tx, { estado: 'registrado' })
      const existente = await insertarComprobantePrueba(tx, { estado: 'existente' })
      expect(await comprobanteCerradoEn(tx, leido)).toBe(false)
      expect(await comprobanteCerradoEn(tx, registrado)).toBe(true)
      expect(await comprobanteCerradoEn(tx, existente)).toBe(true)
    })
  })

  it('en uno abierto, ensenar un cargo le crea el renglon', async () => {
    const p = await unProveedorConOc()
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonSinCodigo(tx, id, 1, 'SEGURO Y FLETES')
      await vincularDescripcionArticuloEn(tx, id, p!.codProvee, 'SEGURO Y FLETES', '106999', true)
      expect((await obtenerDetalleEn(tx, id)).renglones).toHaveLength(1)
    })
  })

  it('en uno CERRADO, ensenar guarda lo aprendido y NO le toca los renglones', async () => {
    // Es la garantia que importa: en un comprobante registrado los
    // renglones son el registro de lo que se mando a Tango, y rehacerlos lo
    // corromperia.
    const p = await unProveedorConOc()
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'registrado' })
      await renglonSinCodigo(tx, id, 1, 'SEGURO Y FLETES')
      const antes = (await obtenerDetalleEn(tx, id)).renglones.length

      await vincularDescripcionArticuloEn(tx, id, p!.codProvee, 'SEGURO Y FLETES', '106999', true)

      // El comprobante quedo igual...
      expect((await obtenerDetalleEn(tx, id)).renglones).toHaveLength(antes)
      // ...pero lo aprendido vale para el proveedor, que es el punto.
      const aprendidas = await articulosPorDescripcionEn(tx, p!.codProvee)
      expect(aprendidas[normalizarDescripcionArticulo('SEGURO Y FLETES')]?.codArticu).toBe('106999')
    })
  })

  it('lo aprendido desde un comprobante cerrado resuelve el renglon de OTRO', async () => {
    const p = await unProveedorConOc()
    await conRollback(async (tx) => {
      const cerrado = await insertarComprobantePrueba(tx, { estado: 'existente' })
      await renglonSinCodigo(tx, cerrado, 1, 'MAQUETA DELUXE NVO')
      await vincularDescripcionArticuloEn(tx, cerrado, p!.codProvee, 'MAQUETA DELUXE NVO', '106999', false)

      const nuevo = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonSinCodigo(tx, nuevo, 1, 'MAQUETA DELUXE NVO')
      const detalle = await obtenerDetalleEn(tx, nuevo)
      const lineas = await lineasPdfResueltasEn(tx, detalle, p!.codProvee)
      expect(lineas[0].codigo).toBe('106999')
      expect(lineas[0].porDescripcion).toBe(true)
    })
  })
})
