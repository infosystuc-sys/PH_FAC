import sql from 'mssql'
import { auditarEn, obtenerDetalleEn } from './detalle'
import { buscarOcPorNumero } from '@/server/tango/ordenesCompra'
import { articulosPorSinonimo } from '@/server/tango/articulos'
import { emparejarRenglones, resolverCodigoArticulo } from '@/lib/matchOc'
import { normalizarCodigo } from '@/lib/cotejoOc'
import { parsearImporte } from '@/lib/formato'

type Ejecutor = { request(): sql.Request }

/**
 * Imputa una orden de compra a una factura de artículos.
 *
 * Desde 2026-09-06 las facturas de artículos se imputan a una OC y no se
 * cotejan contra un remito (decisión del usuario). La OC es la fuente del
 * precio y del vínculo con Tango.
 *
 * **Trae solo los renglones que la FACTURA cobra**, no todos los pendientes
 * de la orden -- decisión del usuario, 2026-09-07. Antes traía la OC
 * entera: una factura de CARRIER que cobra un solo artículo contra una OC
 * de nueve renglones dejaba ocho filas que el operador tenía que borrar a
 * mano, y que si se le pasaban se registraban en Tango como facturadas.
 *
 * La cantidad es la que factura el proveedor, no lo pendiente de la orden:
 * es lo que se está cobrando y lo que tiene que ir a `CPA46`. El precio sí
 * sale de la OC, que es el pactado.
 *
 * AGREGA, no reemplaza: una factura puede repartirse entre varias órdenes
 * (hay 64 así en la base), y el modelo de datos ya lo soportaba porque la
 * OC vive en el renglón y no en la cabecera. Volver a imputar la MISMA
 * orden sí reemplaza lo suyo, para que sea idempotente.
 */
export async function agregarOcEn(
  e: Ejecutor,
  comprobanteId: number,
  nOrdenCo: string,
  codProvee: string | null,
): Promise<{ agregados: number; sinEmparejar: number }> {
  const oc = await buscarOcPorNumero(nOrdenCo)
  if (!oc) {
    throw new Error(`La orden de compra ${nOrdenCo.trim()} no existe o ya no tiene nada pendiente.`)
  }

  const detalle = await obtenerDetalleEn(e, comprobanteId)
  if (detalle.renglonesPdf.length === 0) {
    throw new Error(
      'No se leyeron los renglones de la factura, así que no hay con qué emparejar la orden de ' +
        'compra. Reprocesá el comprobante antes de imputarla.',
    )
  }

  // Lo ya imputado desde OTRAS ordenes no se toca; lo de esta se rehace.
  await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .input('oc', sql.VarChar(14), oc.nOrdenCo)
    .query('DELETE FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id AND OC_N_ORDEN_CO = @oc')

  const yaCubiertos = new Set(
    detalle.renglones
      .filter((r) => r.ocNOrdenCo && r.ocNOrdenCo !== oc.nOrdenCo)
      .map((r) => normalizarCodigo(r.codigoFinal ?? r.codigo ?? '')),
  )

  const sinonimos = codProvee
    ? await articulosPorSinonimo(
        codProvee,
        detalle.renglonesPdf.map((r) => r.codigo ?? ''),
      )
    : new Map<string, string>()

  const emparejados = emparejarRenglones(
    detalle.renglonesPdf.map((r) => ({ orden: r.orden, codigo: r.codigo, cantidad: r.cantidad })),
    oc.renglones,
    sinonimos,
  )

  // ORDEN es UNIQUE por comprobante y ya puede haber renglones de otra
  // orden: se sigue desde el mayor en vez de arrancar de 1.
  const maximo = await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .query<{ maxOrden: number | null }>(
      'SELECT MAX(ORDEN) AS maxOrden FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id',
    )
  let orden = Number(maximo.recordset[0]?.maxOrden ?? 0)

  let agregados = 0
  let sinEmparejar = 0
  for (const { linea, enOc } of emparejados) {
    if (!enOc) {
      sinEmparejar += 1
      continue
    }
    // Ya lo trajo otra orden: no se duplica. El operador saca esa otra si
    // lo que quiere es imputarlo contra esta.
    if (yaCubiertos.has(normalizarCodigo(enOc.codArticu))) continue

    // La cantidad que factura el proveedor. Si el PDF no la trajo se cae a
    // lo pendiente de la orden, que es la lectura más probable, y el
    // operador la corrige.
    const cantidad = parsearImporte(linea.cantidad) || enOc.pendienteFacturar
    orden += 1
    agregados += 1

    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('orden', sql.Int, orden)
      // El codigo es el NUESTRO, el de Tango: es con el que se graba en
      // CPA46. La descripcion tambien sale de la OC.
      .input('codigo', sql.NVarChar(60), enOc.codArticu)
      .input('desc', sql.NVarChar(500), enOc.descripcion)
      .input('cant', sql.Decimal(19, 4), cantidad)
      .input('pu', sql.Decimal(19, 4), enOc.precio)
      .input('imp', sql.Decimal(19, 4), Math.round(cantidad * enOc.precio * 100) / 100)
      .input('oc', sql.VarChar(14), oc.nOrdenCo)
      .input('tal', sql.Int, oc.talonario)
      .input('nr', sql.Int, enOc.nRenglOc)
      .input('pend', sql.Decimal(19, 4), enOc.pendienteFacturar)
      // El renglon del PDF del que salio: es lo que despues permite ponerle
      // al lado el subtotal impreso y derivar el precio neto que se graba.
      .input('pdfOrden', sql.Int, linea.orden)
      .query(`
        INSERT INTO PHF_RENGLON
          (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA,
           PRECIO_UNITARIO_IA, IMPORTE_IA,
           OC_N_ORDEN_CO, OC_TALONARIO, OC_N_RENGL_OC, OC_PENDIENTE, PDF_ORDEN)
        VALUES (@id, @orden, @codigo, @desc, @cant, @pu, @imp, @oc, @tal, @nr, @pend, @pdfOrden)
      `)
  }

  const nota =
    sinEmparejar > 0
      ? `, ${sinEmparejar} renglón(es) de la factura sin correspondencia en esta orden`
      : ''
  await auditarEn(
    e,
    comprobanteId,
    `Orden de compra ${oc.nOrdenCo.trim()} imputada — ${agregados} renglón(es)${nota}`,
  )
  return { agregados, sinEmparejar }
}

/** Saca una orden de compra del comprobante, con los renglones que trajo. */
export async function quitarOcEn(
  e: Ejecutor,
  comprobanteId: number,
  nOrdenCo: string,
): Promise<number> {
  const r = await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .input('oc', sql.VarChar(14), nOrdenCo)
    .query('DELETE FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id AND OC_N_ORDEN_CO = @oc')

  const borrados = r.rowsAffected[0] ?? 0
  if (borrados > 0) {
    await auditarEn(
      e,
      comprobanteId,
      `Orden de compra ${nOrdenCo.trim()} quitada — ${borrados} renglón(es)`,
    )
  }
  return borrados
}

/** Las órdenes de compra imputadas a este comprobante, sin repetir. */
export async function ocsDelComprobanteEn(
  e: Ejecutor,
  comprobanteId: number,
): Promise<string[]> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  return [...new Set(detalle.renglones.map((r) => r.ocNOrdenCo).filter((x): x is string => !!x))]
}

/**
 * Los renglones de la factura que todavía no tienen su artículo en ninguna
 * orden imputada.
 *
 * Es lo que hay que resolver antes de poder registrar: `cotejarConOc` los
 * marca como "no está en la orden de compra" y eso bloquea. Se calcula acá
 * para poder mostrarlos, que es lo que el operador necesita para saber qué
 * le falta -- decisión del usuario, 2026-09-07.
 */
export async function renglonesSinOcEn(
  e: Ejecutor,
  comprobanteId: number,
  codProvee: string | null,
): Promise<{ orden: number; codigo: string; cantidad: string | null }[]> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  if (detalle.renglonesPdf.length === 0) return []

  const imputados = new Set(
    detalle.renglones
      .filter((r) => r.ocNOrdenCo)
      .map((r) => normalizarCodigo(r.codigoFinal ?? r.codigo ?? '')),
  )
  const sinonimos = codProvee
    ? await articulosPorSinonimo(
        codProvee,
        detalle.renglonesPdf.map((r) => r.codigo ?? ''),
      )
    : new Map<string, string>()

  return detalle.renglonesPdf
    .filter((r) => resolverCodigoArticulo(r.codigo, imputados, sinonimos) === null)
    .map((r) => ({ orden: r.orden, codigo: (r.codigo ?? '').trim(), cantidad: r.cantidad }))
}
