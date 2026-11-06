import sql from 'mssql'
import { auditarEn, obtenerDetalleEn } from './detalle'
import { buscarOcPorNumero } from '@/server/tango/ordenesCompra'
import { criterioOcDe } from '@/lib/tipoFactura'
import { articulosPorSinonimo } from '@/server/tango/articulos'
import {
  emparejarRenglones,
  resolverCodigoArticulo,
  resolverLineasPdf,
  abrirPorTalle,
  lineasAVincular,
  lineasContraOc,
  lineasCargo,
  type LineaPdfResuelta,
} from '@/lib/matchOc'
import { articulosPorDescripcionEn } from './articulosProveedor'
import { reglaDeProveedorEn } from './lecturaProveedor'
import type { Detalle } from './detalle'
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
/**
 * Los renglones del PDF con el codigo con el que se emparejan: el impreso, o
 * el aprendido por descripcion para este proveedor (ver resolverLineasPdf).
 * Todas las entradas que miran renglones del PDF pasan por aca, para que un
 * renglon vinculado por descripcion resuelva igual en las cuatro: imputar,
 * listar sin orden, ofrecer OC y validar.
 */
export async function lineasPdfResueltasEn(
  e: Ejecutor,
  detalle: Detalle,
  codProvee: string | null,
): Promise<LineaPdfResuelta[]> {
  const porDescripcion = await articulosPorDescripcionEn(e, codProvee)
  return resolverLineasPdf(
    detalle.renglonesPdf.map((r) => ({
      orden: r.orden,
      codigo: r.codigo,
      descripcion: r.descripcion,
      cantidad: r.cantidad,
    })),
    porDescripcion,
  )
}

/**
 * Cuantos renglones del PDF siguen sin articulo, y lo deja escrito en el
 * comprobante para la pestaña "A vincular" de la bandeja. Se llama al
 * terminar de leer y cada vez que el operador vincula una descripcion.
 */
export async function recalcularAVincularEn(
  e: Ejecutor,
  comprobanteId: number,
  codProvee: string | null,
): Promise<number> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const cantidad = lineasAVincular(await lineasPdfResueltasEn(e, detalle, codProvee)).length
  await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .input('n', sql.Int, cantidad)
    .query('UPDATE PHF_COMPROBANTE SET RENGLONES_A_VINCULAR = @n WHERE ID = @id')
  return cantidad
}

/**
 * `soloPdfOrden` imputa la orden a UN renglón del PDF y no a toda la factura
 * (2026-10-14, pedido del usuario): la revisión elige la OC renglón por
 * renglón, y solo al elegirla en el primero pregunta si va para el resto.
 * En ese modo lo que se rehace es lo de ESE renglón --tuviera la orden que
 * tuviera--, no lo de la orden, y si la orden no tiene su artículo se corta
 * con error en vez de dejarlo sin nada: el operador eligió explícitamente.
 */
export async function agregarOcEn(
  e: Ejecutor,
  comprobanteId: number,
  nOrdenCo: string,
  codProvee: string | null,
  soloPdfOrden: number | null = null,
): Promise<{ agregados: number; sinEmparejar: number }> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  // Una factura consume lo pendiente de facturar y un remito lo pendiente de
  // recibir: son dos saldos distintos de la misma orden.
  const tipo = detalle.campos.find((c) => c.clave === 'tipoFactura')?.valorFinal ?? null
  const oc = await buscarOcPorNumero(nOrdenCo, criterioOcDe(tipo))
  if (!oc) {
    throw new Error(`La orden de compra ${nOrdenCo.trim()} no existe o ya no tiene nada pendiente.`)
  }

  if (detalle.renglonesPdf.length === 0) {
    throw new Error(
      'No se leyeron los renglones de la factura, así que no hay con qué emparejar la orden de ' +
        'compra. Reprocesá el comprobante antes de imputarla.',
    )
  }

  // Lo ya imputado desde OTRAS ordenes no se toca; lo de esta se rehace.
  // Con un solo renglon, lo que se rehace es lo de ese renglon.
  if (soloPdfOrden === null) {
    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('oc', sql.VarChar(14), oc.nOrdenCo)
      .query('DELETE FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id AND OC_N_ORDEN_CO = @oc')
  } else {
    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('pdf', sql.Int, soloPdfOrden)
      .query(
        'DELETE FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id AND PDF_ORDEN = @pdf AND OC_N_ORDEN_CO IS NOT NULL',
      )
  }

  const yaCubiertos = new Set(
    detalle.renglones
      .filter(
        (r) =>
          r.ocNOrdenCo &&
          r.ocNOrdenCo !== oc.nOrdenCo &&
          (soloPdfOrden === null || r.pdfOrden !== soloPdfOrden),
      )
      .map((r) => normalizarCodigo(r.codigoFinal ?? r.codigo ?? '')),
  )

  const todasLasLineas = await lineasPdfResueltasEn(e, detalle, codProvee)
  const lineas =
    soloPdfOrden === null ? todasLasLineas : todasLasLineas.filter((l) => l.orden === soloPdfOrden)
  if (lineas.length === 0) {
    throw new Error(`El renglón ${soloPdfOrden} no existe en la factura.`)
  }
  const sinonimos = codProvee
    ? await articulosPorSinonimo(
        codProvee,
        lineas.map((r) => r.codigo ?? ''),
      )
    : new Map<string, string>()

  // Las facturas que desglosan por talle traen UNA línea impresa por
  // artículo y color, y en Tango cada talle es un artículo con su propio
  // renglón de OC: se abre acá, contra los códigos de ESTA orden, antes de
  // emparejar (2026-09-24, reportado por el usuario con TOPPER). Una línea
  // sin desglose pasa tal cual.
  // El proveedor que ya se sabe que desglosa habilita el renglon de un solo
  // talle: TOPPER parte una linea impresa en varios y a alguno le toca uno.
  const desglosa = (await reglaDeProveedorEn(e, codProvee))?.escala === 'desglose-talle'
  const abiertas = abrirPorTalle(
    lineas,
    oc.renglones.map((r) => r.codArticu),
    desglosa,
  )

  // Los cargos quedan afuera del emparejamiento: no consumen pendiente de
  // ninguna orden. Sus renglones los crea sincronizarCargosEn.
  // Los renglones de ESTA orden que ya usan otras lineas del comprobante no
  // se vuelven a usar: con el mismo articulo en varios renglones de la
  // orden (IMSA, una moto por color), cada linea va contra el suyo.
  const ocupados = new Set(
    detalle.renglones
      .filter(
        (r) =>
          r.ocNOrdenCo === oc.nOrdenCo &&
          r.ocNRenglOc !== null &&
          soloPdfOrden !== null &&
          r.pdfOrden !== soloPdfOrden,
      )
      .map((r) => r.ocNRenglOc!),
  )
  const emparejados = emparejarRenglones(
    lineasContraOc(abiertas),
    oc.renglones,
    sinonimos,
    (r) => ocupados.has(r.nRenglOc),
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
    const cantidad = parsearImporte(linea.cantidad) || enOc.pendiente
    orden += 1
    agregados += 1

    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('orden', sql.Int, orden)
      // El codigo es el NUESTRO, el de Tango: es con el que se graba en
      // CPA46. La descripcion tambien sale de la OC.
      .input('codigo', sql.NVarChar(60), enOc.codArticu)
      // La descripcion sale de la OC, salvo en los renglones abiertos por
      // talle: ahi los cuatro traen la MISMA descripcion de la OC ("SHORT
      // TOPPER CORE RUN - HOMBRE") y el operador no podria distinguirlos en
      // la revision. Se les agrega el talle al final.
      .input(
        'desc',
        sql.NVarChar(500),
        linea.talle ? `${enOc.descripcion} - ${linea.talle}` : enOc.descripcion,
      )
      .input('cant', sql.Decimal(19, 4), cantidad)
      .input('pu', sql.Decimal(19, 4), enOc.precio)
      .input('imp', sql.Decimal(19, 4), Math.round(cantidad * enOc.precio * 100) / 100)
      .input('oc', sql.VarChar(14), oc.nOrdenCo)
      .input('tal', sql.Int, oc.talonario)
      .input('nr', sql.Int, enOc.nRenglOc)
      .input('pend', sql.Decimal(19, 4), enOc.pendiente)
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

  if (soloPdfOrden !== null) {
    // El operador eligio esta orden para este renglon: si no lo puede
    // cubrir, se dice por que en vez de dejarlo vacio sin explicacion. El
    // throw deshace tambien el DELETE de arriba.
    if (agregados === 0) {
      throw new Error(
        sinEmparejar > 0
          ? `La orden ${oc.nOrdenCo.trim()} no tiene pendiente el artículo del renglón ${soloPdfOrden}.`
          : `El artículo del renglón ${soloPdfOrden} ya lo trae otra orden imputada.`,
      )
    }
    await auditarEn(
      e,
      comprobanteId,
      `Orden de compra ${oc.nOrdenCo.trim()} imputada al renglón ${soloPdfOrden} de la factura`,
    )
    return { agregados, sinEmparejar }
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

/**
 * Saca la orden de compra de UN renglón del PDF, con todo lo que trajo
 * (un renglón desglosado por talle trae varios). Los cargos no se tocan:
 * no tienen orden.
 */
export async function quitarOcDeRenglonEn(
  e: Ejecutor,
  comprobanteId: number,
  pdfOrden: number,
): Promise<number> {
  const r = await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .input('pdf', sql.Int, pdfOrden)
    .query(
      'DELETE FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id AND PDF_ORDEN = @pdf AND OC_N_ORDEN_CO IS NOT NULL',
    )

  const borrados = r.rowsAffected[0] ?? 0
  if (borrados > 0) {
    await auditarEn(e, comprobanteId, `Orden de compra quitada del renglón ${pdfOrden} de la factura`)
  }
  return borrados
}

/**
 * Vuelve a leer de Tango lo que tiene pendiente cada renglón de OC imputado
 * y pisa `OC_PENDIENTE`, que es una foto tomada al imputar (ver
 * `agregarOcEn`). Si en Tango se amplió la orden, o se anuló lo que la
 * consumía, la revisión tiene que verlo sin volver a imputar.
 *
 * El pendiente es el del mismo saldo que usó la imputación: de facturar en
 * una factura, de recibir en un remito (`criterioOcDe`). Un renglón que la
 * orden ya no trae --la orden se cerró o se consumió entera-- queda en 0, que
 * es lo que Tango dice que hay.
 *
 * Devuelve cuántos renglones cambiaron.
 */
export async function actualizarPendientesOcEn(e: Ejecutor, comprobanteId: number): Promise<number> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const tipo = detalle.campos.find((c) => c.clave === 'tipoFactura')?.valorFinal ?? null

  let cambiados = 0
  for (const nOrdenCo of await ocsDelComprobanteEn(e, comprobanteId)) {
    const oc = await buscarOcPorNumero(nOrdenCo, criterioOcDe(tipo))
    const vivo = new Map((oc?.renglones ?? []).map((r) => [r.nRenglOc, r.pendiente]))

    for (const r of detalle.renglones) {
      if (r.ocNOrdenCo !== nOrdenCo || r.ocNRenglOc === null) continue
      const pendiente = vivo.get(r.ocNRenglOc) ?? 0
      const actual = r.ocPendiente === null ? null : Number(r.ocPendiente)
      if (actual !== null && Math.abs(actual - pendiente) < 0.00005) continue

      await e
        .request()
        .input('id', sql.Int, r.id)
        .input('pend', sql.Decimal(19, 4), pendiente)
        .query('UPDATE PHF_RENGLON SET OC_PENDIENTE = @pend WHERE ID = @id')
      cambiados += 1
    }
  }
  return cambiados
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
): Promise<
  { orden: number; codigo: string; descripcion: string | null; cantidad: string | null; porDescripcion: boolean }[]
> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  if (detalle.renglonesPdf.length === 0) return []

  const imputados = new Set(
    detalle.renglones
      .filter((r) => r.ocNOrdenCo)
      .map((r) => normalizarCodigo(r.codigoFinal ?? r.codigo ?? '')),
  )
  const lineas = await lineasPdfResueltasEn(e, detalle, codProvee)
  const sinonimos = codProvee
    ? await articulosPorSinonimo(
        codProvee,
        lineas.map((r) => r.codigo ?? ''),
      )
    : new Map<string, string>()

  // Abierto por talle contra lo ya imputado: una linea desglosada cuyos
  // talles estan todos imputados no es un faltante, aunque su codigo pelado
  // no figure en ninguna orden. Es justo el caso que el operador veia en
  // rojo con TOPPER.
  const desglosa = (await reglaDeProveedorEn(e, codProvee))?.escala === 'desglose-talle'
  // Los codigos TAL CUAL, no normalizados: el talle con decimales ("41.5"
  // contra el "415" impreso) se reconoce por el punto, y normalizar lo
  // borra. Con los normalizados, la linea de cinco talles de TOPPER quedaba
  // "sin orden" aunque la orden imputada los cubria todos (2026-10-14).
  const abiertas = abrirPorTalle(
    lineas,
    detalle.renglones.filter((r) => r.ocNOrdenCo).map((r) => (r.codigoFinal ?? r.codigo ?? '').trim()),
    desglosa,
  )

  // Los cargos del proveedor no van contra ninguna orden: no son un
  // faltante, son otra cosa (ver SIN_OC en migrate.ts).
  return lineasContraOc(abiertas)
    .filter((r) => resolverCodigoArticulo(r.codigo, imputados, sinonimos) === null)
    .map((r) => ({
      orden: r.orden,
      codigo: (r.codigo ?? '').trim(),
      descripcion: r.descripcion,
      cantidad: r.cantidad,
      porDescripcion: r.porDescripcion,
    }))
}

/**
 * Crea (o rehace) los renglones de los CARGOS del proveedor: los que el
 * operador marcó como "va sin orden de compra" -- 2026-09-22, pedido del
 * usuario. RED DEL INTERIOR factura "GESTION DE COMPRA 1%" y "GESTION
 * ROSARIO LOGISTICA S.A.": no forman parte de ninguna OC y tienen que
 * entrar igual en la factura y en el asiento.
 *
 * Son renglones de `PHF_RENGLON` como cualquier otro --por eso llegan a
 * CPA46 y a la vista previa del asiento-- pero con las cuatro columnas de
 * OC en NULL: no se vinculan en `CPA_OC_FACTURA` ni descuentan `CPA36`.
 *
 * El precio sale de la FACTURA, no de ninguna orden: es lo único que hay.
 * Se rehacen enteros en cada llamada (borrar + insertar los vigentes) para
 * que desmarcar un cargo, o cambiarle el artículo, no deje un renglón
 * viejo pegado.
 */
export async function sincronizarCargosEn(
  e: Ejecutor,
  comprobanteId: number,
  codProvee: string | null,
): Promise<number> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const cargos = lineasCargo(await lineasPdfResueltasEn(e, detalle, codProvee))

  // Los renglones de cargo se identifican por no tener orden: los de OC los
  // maneja agregarOcEn y no se tocan acá.
  await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .query('DELETE FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id AND OC_N_ORDEN_CO IS NULL')

  if (cargos.length === 0) return 0

  const maximo = await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .query<{ maxOrden: number | null }>(
      'SELECT MAX(ORDEN) AS maxOrden FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id',
    )
  let orden = Number(maximo.recordset[0]?.maxOrden ?? 0)

  const porOrden = new Map(detalle.renglonesPdf.map((r) => [r.orden, r]))
  for (const cargo of cargos) {
    const pdf = porOrden.get(cargo.orden)
    const cantidad = parsearImporte(cargo.cantidad)
    const precio = parsearImporte(pdf?.precioImpreso)
    orden += 1
    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('orden', sql.Int, orden)
      .input('codigo', sql.NVarChar(60), cargo.codigo)
      .input('desc', sql.NVarChar(500), cargo.descripcion)
      .input('cant', sql.Decimal(19, 4), cantidad)
      .input('pu', sql.Decimal(19, 4), precio)
      .input('imp', sql.Decimal(19, 4), parsearImporte(pdf?.subtotalImpreso))
      .input('pdfOrden', sql.Int, cargo.orden)
      .query(`
        INSERT INTO PHF_RENGLON
          (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA,
           PRECIO_UNITARIO_IA, IMPORTE_IA, PDF_ORDEN)
        VALUES (@id, @orden, @codigo, @desc, @cant, @pu, @imp, @pdfOrden)
      `)
  }
  return cargos.length
}
