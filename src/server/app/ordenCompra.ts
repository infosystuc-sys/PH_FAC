import sql from 'mssql'
import { auditarEn, obtenerDetalleEn } from './detalle'
import { buscarOcPorNumero } from '@/server/tango/ordenesCompra'

type Ejecutor = { request(): sql.Request }

/**
 * Asigna una orden de compra a una factura de artículos: reemplaza los
 * renglones del comprobante por los de la OC que todavía tienen algo
 * pendiente de facturar.
 *
 * Desde 2026-09-06 las facturas de artículos se imputan a una OC y no se
 * cotejan contra un remito (decisión del usuario). La OC es la fuente del
 * detalle igual que antes lo era el remito: la cantidad arranca en lo
 * pendiente y el operador la ajusta si el proveedor facturó menos.
 *
 * Reemplaza y no acumula: elegir otra OC deja el comprobante con los
 * renglones de la nueva, sin restos de la anterior. Con una sola OC por
 * factura --que es lo que la pantalla deja hacer hoy-- es lo que el
 * operador espera; el día que se admitan varias, esto pasa a agregar en vez
 * de reemplazar y el modelo de datos ya lo soporta (la OC vive en el
 * renglón, no en la cabecera).
 */
export async function asignarOcEn(
  e: Ejecutor,
  comprobanteId: number,
  nOrdenCo: string,
): Promise<number> {
  const oc = await buscarOcPorNumero(nOrdenCo)
  if (!oc) {
    throw new Error(`La orden de compra ${nOrdenCo.trim()} no existe o ya no tiene nada pendiente.`)
  }

  await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .query('DELETE FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id')

  let orden = 0
  for (const r of oc.renglones) {
    orden += 1
    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('orden', sql.Int, orden)
      // El codigo es el NUESTRO, el de Tango: es con el que se graba en
      // CPA46. La descripcion tambien sale de la OC -- a diferencia del
      // remito, donde salia de lo que imprimia el proveedor.
      .input('codigo', sql.NVarChar(60), r.codArticu)
      .input('desc', sql.NVarChar(500), r.descripcion)
      // La cantidad arranca en lo pendiente: es el caso normal --se factura
      // todo lo que queda-- y el operador la baja si el proveedor facturo
      // menos. El precio sale de la OC, que es el pactado.
      .input('cant', sql.Decimal(19, 4), r.pendienteFacturar)
      .input('pu', sql.Decimal(19, 4), r.precio)
      .input('imp', sql.Decimal(19, 4), Math.round(r.pendienteFacturar * r.precio * 100) / 100)
      .input('oc', sql.VarChar(14), oc.nOrdenCo)
      .input('tal', sql.Int, oc.talonario)
      .input('nr', sql.Int, r.nRenglOc)
      .input('pend', sql.Decimal(19, 4), r.pendienteFacturar)
      .query(`
        INSERT INTO PHF_RENGLON
          (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA,
           PRECIO_UNITARIO_IA, IMPORTE_IA,
           OC_N_ORDEN_CO, OC_TALONARIO, OC_N_RENGL_OC, OC_PENDIENTE)
        VALUES (@id, @orden, @codigo, @desc, @cant, @pu, @imp, @oc, @tal, @nr, @pend)
      `)
  }

  await auditarEn(
    e,
    comprobanteId,
    `Orden de compra ${oc.nOrdenCo.trim()} imputada — ${orden} renglón(es) pendientes de facturar`,
  )
  return orden
}

/** El número de OC imputado a este comprobante, o `null` si todavía no tiene. */
export async function ocDelComprobanteEn(
  e: Ejecutor,
  comprobanteId: number,
): Promise<string | null> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const conOc = detalle.renglones.find((r) => r.ocNOrdenCo)
  return conOc?.ocNOrdenCo ?? null
}
