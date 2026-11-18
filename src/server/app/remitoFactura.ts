import sql from 'mssql'
import { auditarEn, obtenerDetalleEn, type Detalle } from './detalle'
import { lineasPdfResueltasEn } from './ordenCompra'
import { articulosPorSinonimo, describirArticulos } from '@/server/tango/articulos'
import { renglonesFacturaSinRemito } from '@/server/tango/facturasParaRemito'
import { buscarOcPendientes } from '@/server/tango/ordenesCompra'
import { normalizarCodigo } from '@/lib/cotejoOc'
import { parsearImporte } from '@/lib/formato'
import {
  proponerFacturas,
  claveFactura,
  claveRenglonFactura,
  type CandidatoFactura,
} from '@/lib/remitoFactura'

/**
 * Los renglones de un REMITO de proveedor y la factura a la que se vincula
 * cada uno (2026-11-16, pedido del usuario: "el remito se vincula a una
 * factura, no a una orden de compra").
 *
 * Hasta ese día los renglones del remito salían de imputarle una OC. Ahora
 * salen del papel: una fila de PHF_RENGLON por renglón del PDF, con el
 * artículo resuelto por el código impreso (sinónimo de CPA15 o código
 * nuestro) o por la descripción aprendida. A cada uno se le propone el
 * renglón de una factura del proveedor ya registrada en Tango que tenga
 * ese artículo sin recibir (ver `proponerFacturas`), y el operador lo
 * puede cambiar. La orden de compra no se elige: si la factura estaba
 * imputada a una, el registro la hereda (decisión del usuario).
 *
 * Si no hay factura, se vincula a la orden de compra que tenga el artículo
 * pendiente de recibir (2026-11-18, ver `proponerOcEn`), y la factura que
 * llegue después lo consume. Sin factura ni orden, el operador confirma
 * grabarlo sin comprobante de referencia
 * (`PHF_COMPROBANTE.REMITO_SIN_REFERENCIA`): entra a stock sin vincularse a
 * nada.
 *
 * Limitación: una línea desglosada por talle (TOPPER) es UN renglón, con el
 * código impreso; no se abre por talle como en la factura.
 */

type Ejecutor = { request(): sql.Request }

async function cerradoEn(e: Ejecutor, id: number): Promise<boolean> {
  const r = await e.request().input('id', sql.Int, id).query('SELECT ESTADO FROM PHF_COMPROBANTE WHERE ID = @id')
  const estado = r.recordset[0]?.ESTADO
  return estado === 'registrado' || estado === 'existente'
}

function codProveeDe(detalle: Detalle): string | null {
  const c = detalle.campos.find((x) => x.clave === 'codprovee')
  return (c?.valorFinal ?? c?.valorIA ?? '').trim() || null
}

export function esRemito(detalle: Detalle): boolean {
  return detalle.campos.find((c) => c.clave === 'tipoFactura')?.valorFinal === 'remito'
}

export async function remitoSinReferenciaEn(e: Ejecutor, id: number): Promise<boolean> {
  const r = await e.request().input('id', sql.Int, id)
    .query('SELECT REMITO_SIN_REFERENCIA AS x FROM PHF_COMPROBANTE WHERE ID = @id')
  return Boolean(r.recordset[0]?.x)
}

/** Una línea del PDF con el artículo de Tango que le corresponde, si se sabe. */
export type LineaRemito = {
  pdfOrden: number
  codigoImpreso: string | null
  descripcion: string | null
  cantidad: number
  /** El código de Tango tal como está en el maestro, o `null` si no se reconoce. */
  codArticu: string | null
  descripcionTango: string | null
  porDescripcion: boolean
}

/** Resuelve el artículo de cada línea del PDF: sinónimo, código nuestro o descripción aprendida. */
export async function lineasRemitoEn(e: Ejecutor, detalle: Detalle): Promise<LineaRemito[]> {
  const codProvee = codProveeDe(detalle)
  const lineas = await lineasPdfResueltasEn(e, detalle, codProvee)
  const codigos = lineas.map((l) => (l.codigo ?? '').trim()).filter((c) => c !== '')
  const sinonimos = codProvee ? await articulosPorSinonimo(codProvee, codigos) : new Map<string, string>()
  // El codigo nuestro de cada linea: el sinonimo si lo hay, si no lo impreso
  // (o lo aprendido por descripcion), que puede ser directamente nuestro.
  const candidato = (codigo: string) => sinonimos.get(normalizarCodigo(codigo)) ?? codigo
  const maestro = await describirArticulos(codigos.map(candidato))
  const impresoDe = new Map(detalle.renglonesPdf.map((r) => [r.orden, r.codigo]))

  return lineas.map((l) => {
    const codigo = (l.codigo ?? '').trim()
    const art = codigo ? maestro.get(normalizarCodigo(candidato(codigo))) : undefined
    return {
      pdfOrden: l.orden,
      codigoImpreso: impresoDe.get(l.orden) ?? null,
      descripcion: l.descripcion,
      cantidad: parsearImporte(l.cantidad),
      codArticu: art?.codArticu ?? null,
      descripcionTango: art?.descripcion ?? null,
      porDescripcion: l.porDescripcion,
    }
  })
}

async function escribirFacturaEn(
  e: Ejecutor,
  renglonId: number,
  c: CandidatoFactura | null,
  elegida: boolean,
): Promise<void> {
  await e
    .request()
    .input('id', sql.Int, renglonId)
    .input('t', sql.VarChar(2), c?.tcompInC ?? null)
    .input('n', sql.Float, c?.ncompInC ?? null)
    .input('r', sql.Int, c?.nRenglC ?? null)
    .input('nComp', sql.VarChar(20), c?.nComp ?? null)
    .input('falta', sql.Decimal(19, 4), c?.faltaRem ?? null)
    .input('elegida', sql.Bit, elegida)
    .query(`
      UPDATE PHF_RENGLON
      SET FAC_TCOMP_IN_C = @t, FAC_NCOMP_IN_C = @n, FAC_N_RENGL_C = @r, FAC_N_COMP = @nComp,
          FAC_FALTA_REM = @falta, FAC_ELEGIDA = @elegida
      WHERE ID = @id`)
}

/**
 * Deja PHF_RENGLON igual a las líneas del PDF y propone la factura de los
 * renglones que el operador no decidió. Idempotente: se llama al terminar
 * de leer, al abrir la revisión, al vincular un artículo y al revalidar.
 *
 * Actualiza en el lugar (por renglón del PDF) en vez de borrar y recrear:
 * las series que cargó el operador cuelgan del ID del renglón. Si cambia el
 * artículo de un renglón, la factura elegida se descarta.
 */
export async function sincronizarRenglonesRemitoEn(
  e: Ejecutor,
  comprobanteId: number,
): Promise<{ renglones: number; propuestos: number }> {
  if (await cerradoEn(e, comprobanteId)) return { renglones: 0, propuestos: 0 }
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const lineas = await lineasRemitoEn(e, detalle)

  const porPdf = new Map<number, Detalle['renglones'][number]>()
  const sobrantes: number[] = []
  for (const r of detalle.renglones) {
    if (r.pdfOrden === null || porPdf.has(r.pdfOrden)) sobrantes.push(r.id)
    else porPdf.set(r.pdfOrden, r)
  }
  const vigentes = new Set(lineas.map((l) => l.pdfOrden))
  for (const [pdf, r] of porPdf) if (!vigentes.has(pdf)) sobrantes.push(r.id)
  for (const id of sobrantes) {
    await e.request().input('id', sql.Int, id).query('DELETE FROM PHF_RENGLON WHERE ID = @id')
  }

  const maximo = await e.request().input('id', sql.Int, comprobanteId)
    .query('SELECT ISNULL(MAX(ORDEN), 0) AS mx FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id')
  let orden = Number(maximo.recordset[0].mx)

  for (const l of lineas) {
    const previo = porPdf.get(l.pdfOrden)
    const codigo = l.codArticu
    const desc = l.descripcionTango ?? l.descripcion
    if (previo) {
      const cambioArticulo =
        normalizarCodigo(previo.codigo ?? '') !== normalizarCodigo(codigo ?? '') && !previo.codigoFinal
      await e
        .request()
        .input('id', sql.Int, previo.id)
        .input('codigo', sql.NVarChar(60), codigo)
        .input('desc', sql.NVarChar(500), desc)
        .input('cant', sql.Decimal(19, 4), l.cantidad)
        .input('codProv', sql.NVarChar(60), l.codigoImpreso)
        .input('limpiar', sql.Bit, cambioArticulo)
        .query(`
          UPDATE PHF_RENGLON
          SET CODIGO_IA = @codigo, DESCRIPCION_IA = @desc, CANTIDAD_IA = @cant, COD_PROVEEDOR = @codProv,
              -- El remito ya no va contra la OC: la hereda de la factura al registrar.
              OC_N_ORDEN_CO = NULL, OC_TALONARIO = NULL, OC_N_RENGL_OC = NULL, OC_PENDIENTE = NULL,
              PRECIO_UNITARIO_IA = NULL, IMPORTE_IA = NULL,
              FAC_TCOMP_IN_C = CASE WHEN @limpiar = 1 THEN NULL ELSE FAC_TCOMP_IN_C END,
              FAC_NCOMP_IN_C = CASE WHEN @limpiar = 1 THEN NULL ELSE FAC_NCOMP_IN_C END,
              FAC_N_RENGL_C  = CASE WHEN @limpiar = 1 THEN NULL ELSE FAC_N_RENGL_C END,
              FAC_N_COMP     = CASE WHEN @limpiar = 1 THEN NULL ELSE FAC_N_COMP END,
              FAC_FALTA_REM  = CASE WHEN @limpiar = 1 THEN NULL ELSE FAC_FALTA_REM END,
              FAC_ELEGIDA    = CASE WHEN @limpiar = 1 THEN 0 ELSE FAC_ELEGIDA END
          WHERE ID = @id`)
    } else {
      orden += 1
      await e
        .request()
        .input('cid', sql.Int, comprobanteId)
        .input('orden', sql.Int, orden)
        .input('codigo', sql.NVarChar(60), codigo)
        .input('desc', sql.NVarChar(500), desc)
        .input('cant', sql.Decimal(19, 4), l.cantidad)
        .input('codProv', sql.NVarChar(60), l.codigoImpreso)
        .input('pdf', sql.Int, l.pdfOrden)
        .query(`
          INSERT INTO PHF_RENGLON (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA, COD_PROVEEDOR, PDF_ORDEN)
          VALUES (@cid, @orden, @codigo, @desc, @cant, @codProv, @pdf)`)
    }
  }

  const propuestos = await proponerEn(e, comprobanteId)
  await proponerOcEn(e, comprobanteId)
  return { renglones: lineas.length, propuestos }
}

/**
 * La orden de compra de los renglones que NO tienen factura (2026-11-18,
 * pedido del usuario: "el remito que llega antes que la factura se vincula
 * a la OC, y cuando llega la factura se vincula con la OC").
 *
 * A cada renglón sin factura se le asigna el renglón de OC del proveedor con
 * ese artículo pendiente de RECIBIR (`CPA36.CAN_PENDIE`) que alcance para su
 * cantidad, de la orden más vieja a la más nueva, sin pasarse de lo que ya
 * tomaron los otros renglones del remito. Al registrar se graba como Tango
 * graba un remito contra OC sin factura (STA20 con la OC y `CANT_PEND` =
 * la cantidad, `CPA_OC_REMITO`, contadores de recepción de `CPA36` y
 * `STA19.CANT_PEND`), y la factura que llegue después lo consume por ese
 * renglón de OC (ver `saldosDeRemitoEn`).
 *
 * Los renglones con factura no llevan OC propia: la heredan de la factura.
 */
async function proponerOcEn(e: Ejecutor, comprobanteId: number): Promise<void> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const codProvee = codProveeDe(detalle)
  const sinFactura = detalle.renglones.filter((r) => !r.factura)
  const ocs = codProvee && sinFactura.length > 0 ? await buscarOcPendientes(codProvee, 'recibir') : []
  // De la mas vieja a la mas nueva (buscarOcPendientes las trae al reves).
  const candidatos = ocs
    .slice()
    .sort(
      (a, b) =>
        (a.fechaEmision?.getTime() ?? 0) - (b.fechaEmision?.getTime() ?? 0) || a.nOrdenCo.localeCompare(b.nOrdenCo),
    )
    .flatMap((oc) =>
      oc.renglones.map((r) => ({
        nOrdenCo: oc.nOrdenCo,
        talonario: oc.talonario,
        nRenglOc: r.nRenglOc,
        codArticu: normalizarCodigo(r.codArticu),
        pendiente: r.pendiente,
      })),
    )

  const tomado = new Map<string, number>()
  const clave = (c: { talonario: number; nOrdenCo: string; nRenglOc: number }) =>
    `${c.talonario}|${c.nOrdenCo}|${c.nRenglOc}`
  for (const r of detalle.renglones) {
    let elegido: (typeof candidatos)[number] | null = null
    if (!r.factura) {
      const art = normalizarCodigo(r.codigoFinal ?? r.codigo ?? '')
      const cantidad = parsearImporte(r.cantidad)
      elegido =
        candidatos.find(
          (c) => art !== '' && c.codArticu === art && c.pendiente - (tomado.get(clave(c)) ?? 0) - cantidad > -0.00005,
        ) ?? null
      if (elegido) tomado.set(clave(elegido), (tomado.get(clave(elegido)) ?? 0) + cantidad)
    }
    await e
      .request()
      .input('id', sql.Int, r.id)
      .input('oc', sql.VarChar(14), elegido?.nOrdenCo ?? null)
      .input('tal', sql.Int, elegido?.talonario ?? null)
      .input('nr', sql.Int, elegido?.nRenglOc ?? null)
      .input('pend', sql.Decimal(19, 4), elegido?.pendiente ?? null)
      .query(`
        UPDATE PHF_RENGLON
        SET OC_N_ORDEN_CO = @oc, OC_TALONARIO = @tal, OC_N_RENGL_OC = @nr, OC_PENDIENTE = @pend
        WHERE ID = @id`)
  }
}

/**
 * Propone factura a los renglones que el operador no decidió, y refresca la
 * foto de lo que falta recibir en los que ya tienen una.
 */
async function proponerEn(e: Ejecutor, comprobanteId: number): Promise<number> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const codProvee = codProveeDe(detalle)
  if (!codProvee) return 0
  const candidatos = await renglonesFacturaSinRemito(codProvee, e)
  const porClave = new Map(candidatos.map((c) => [claveRenglonFactura(c), c]))

  // Lo que ya tomaron los renglones que decidió el operador.
  const ocupado = new Map<string, number>()
  const libres: { id: number; codArticu: string; cantidad: number }[] = []
  for (const r of detalle.renglones) {
    const cantidad = parsearImporte(r.cantidad)
    if (r.facturaElegida) {
      if (r.factura) {
        const k = claveRenglonFactura(r.factura)
        ocupado.set(k, (ocupado.get(k) ?? 0) + cantidad)
        // La foto de FALTA_REM, al dia.
        await escribirFacturaEn(e, r.id, porClave.get(k) ?? { ...r.factura, nComp: r.factura.nComp ?? '', faltaRem: 0, fechaEmision: null, codArticu: '', cantidad: 0, oc: null }, true)
      }
      continue
    }
    libres.push({ id: r.id, codArticu: (r.codigoFinal ?? r.codigo ?? '').trim(), cantidad })
  }

  const sinReferencia = await remitoSinReferenciaEn(e, comprobanteId)
  const propuesta = sinReferencia ? new Map<number, CandidatoFactura>() : proponerFacturas(libres, candidatos, new Date(), ocupado)
  for (const r of libres) await escribirFacturaEn(e, r.id, propuesta.get(r.id) ?? null, false)
  return propuesta.size
}

/** Lo que la revisión necesita para elegir la factura de cada renglón. */
export type OfertaFacturasRemito = {
  lineas: LineaRemito[]
  /** Los renglones de factura que se pueden elegir, por ID de PHF_RENGLON (mismo artículo). */
  candidatosPorRenglon: Record<number, CandidatoFactura[]>
  /** Las facturas del proveedor con algo sin recibir, para elegir una para todo el remito. */
  facturas: { tcompInC: string; ncompInC: number; nComp: string; fechaEmision: Date | null; renglones: number }[]
  sinReferencia: boolean
}

export async function ofertaFacturasRemitoEn(e: Ejecutor, comprobanteId: number): Promise<OfertaFacturasRemito> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const codProvee = codProveeDe(detalle)
  const lineas = await lineasRemitoEn(e, detalle)
  const candidatos = codProvee ? await renglonesFacturaSinRemito(codProvee, e) : []

  const candidatosPorRenglon: Record<number, CandidatoFactura[]> = {}
  for (const r of detalle.renglones) {
    const art = normalizarCodigo(r.codigoFinal ?? r.codigo ?? '')
    if (!art) continue
    candidatosPorRenglon[r.id] = candidatos.filter((c) => normalizarCodigo(c.codArticu) === art)
  }

  const facturas = new Map<string, OfertaFacturasRemito['facturas'][number]>()
  for (const c of candidatos) {
    const k = claveFactura(c)
    const f = facturas.get(k) ?? { tcompInC: c.tcompInC, ncompInC: c.ncompInC, nComp: c.nComp, fechaEmision: c.fechaEmision, renglones: 0 }
    f.renglones += 1
    facturas.set(k, f)
  }

  return {
    lineas,
    candidatosPorRenglon,
    facturas: [...facturas.values()],
    sinReferencia: await remitoSinReferenciaEn(e, comprobanteId),
  }
}

/**
 * El operador elige la factura de un renglón (o ninguna, con `null`). Se
 * valida contra Tango que el renglón de factura sea del proveedor y del
 * artículo, y que tenga sin recibir al menos la cantidad.
 */
export async function elegirFacturaRenglonEn(
  e: Ejecutor,
  comprobanteId: number,
  renglonId: number,
  ref: { tcompInC: string; ncompInC: number; nRenglC: number } | null,
): Promise<void> {
  if (await cerradoEn(e, comprobanteId)) throw new Error('El comprobante ya está registrado.')
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const r = detalle.renglones.find((x) => x.id === renglonId)
  if (!r) throw new Error('El renglón ya no existe.')

  if (ref === null) {
    await escribirFacturaEn(e, renglonId, null, true)
    await proponerOcEn(e, comprobanteId)
    const oc = (await obtenerDetalleEn(e, comprobanteId)).renglones.find((x) => x.id === renglonId)?.ocNOrdenCo
    await auditarEn(
      e,
      comprobanteId,
      `Renglón ${r.pdfOrden ?? r.orden} del remito sin factura de referencia` +
        (oc ? `: va contra la orden de compra ${oc.trim()}` : ''),
    )
    return
  }

  const codProvee = codProveeDe(detalle)
  const c = (codProvee ? await renglonesFacturaSinRemito(codProvee, e) : []).find(
    (x) => claveRenglonFactura(x) === claveRenglonFactura(ref),
  )
  if (!c) throw new Error('Ese renglón de factura ya no tiene nada sin recibir, o es de otro proveedor.')
  if (normalizarCodigo(c.codArticu) !== normalizarCodigo(r.codigoFinal ?? r.codigo ?? '')) {
    throw new Error(`El renglón de la factura ${c.nComp} es del artículo ${c.codArticu}, no del de este renglón.`)
  }
  await escribirFacturaEn(e, renglonId, c, true)
  await proponerOcEn(e, comprobanteId)
  await auditarEn(e, comprobanteId, `Factura ${c.nComp} (renglón ${c.nRenglC}) elegida para el renglón ${r.pdfOrden ?? r.orden} del remito`)
}

/**
 * El operador elige UNA factura para todo el remito: cada renglón va contra
 * el renglón de esa factura que tenga su artículo. Los que la factura no
 * cubre quedan como estaban. Devuelve cuántos cubrió.
 */
export async function elegirFacturaRemitoEn(
  e: Ejecutor,
  comprobanteId: number,
  factura: { tcompInC: string; ncompInC: number },
): Promise<{ cubiertos: number; total: number }> {
  if (await cerradoEn(e, comprobanteId)) throw new Error('El comprobante ya está registrado.')
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const codProvee = codProveeDe(detalle)
  const candidatos = (codProvee ? await renglonesFacturaSinRemito(codProvee, e) : []).filter(
    (c) => claveFactura(c) === claveFactura(factura),
  )
  if (candidatos.length === 0) throw new Error('Esa factura ya no tiene nada sin recibir, o es de otro proveedor.')

  const renglones = detalle.renglones.map((r) => ({
    id: r.id,
    codArticu: (r.codigoFinal ?? r.codigo ?? '').trim(),
    cantidad: parsearImporte(r.cantidad),
  }))
  // Sin limite de antiguedad: la eligio el operador.
  const asignados = proponerFacturas(renglones, candidatos, new Date(8640000000000000))
  for (const [id, c] of asignados) await escribirFacturaEn(e, id, c, true)
  await proponerOcEn(e, comprobanteId)
  await e.request().input('id', sql.Int, comprobanteId)
    .query('UPDATE PHF_COMPROBANTE SET REMITO_SIN_REFERENCIA = 0 WHERE ID = @id')
  await auditarEn(
    e,
    comprobanteId,
    `Factura ${candidatos[0].nComp} elegida para el remito — ${asignados.size} de ${renglones.length} renglón(es)`,
  )
  return { cubiertos: asignados.size, total: renglones.length }
}

/** El operador confirma (o retira) grabar sin factura los renglones que no tienen. */
export async function marcarRemitoSinReferenciaEn(e: Ejecutor, comprobanteId: number, valor: boolean): Promise<void> {
  if (await cerradoEn(e, comprobanteId)) throw new Error('El comprobante ya está registrado.')
  await e.request().input('id', sql.Int, comprobanteId).input('v', sql.Bit, valor)
    .query('UPDATE PHF_COMPROBANTE SET REMITO_SIN_REFERENCIA = @v WHERE ID = @id')
  await auditarEn(
    e,
    comprobanteId,
    valor
      ? 'Confirmado: los renglones sin factura se graban sin comprobante de referencia'
      : 'Retirada la confirmación de grabar sin comprobante de referencia',
  )
}
