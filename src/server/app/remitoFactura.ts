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
  claveOcRenglon,
  claveOc,
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
 * pendiente de recibir que elija el operador (2026-11-18, ver `elegirOcRenglonEn`), y la factura que
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
              -- La OC la elige el operador para los renglones sin factura
              -- (2026-11-18): se conserva salvo que cambie el articulo.
              OC_N_ORDEN_CO = CASE WHEN @limpiar = 1 THEN NULL ELSE OC_N_ORDEN_CO END,
              OC_TALONARIO  = CASE WHEN @limpiar = 1 THEN NULL ELSE OC_TALONARIO END,
              OC_N_RENGL_OC = CASE WHEN @limpiar = 1 THEN NULL ELSE OC_N_RENGL_OC END,
              OC_PENDIENTE  = CASE WHEN @limpiar = 1 THEN NULL ELSE OC_PENDIENTE END,
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
  await depurarOcEn(e, comprobanteId)
  return { renglones: lineas.length, propuestos }
}

/**
 * La orden de compra de los renglones que NO tienen factura (2026-11-18,
 * pedido del usuario: "el remito que llega antes que la factura se vincula
 * a la OC, y cuando llega la factura se vincula con la OC").
 *
 * La app NO la asigna sola (mismo día, corrección del usuario: "que el
 * remito no se vincule automáticamente a una OC; proponé las OC que tengan
 * los artículos"): ofrece los renglones de OC del proveedor con el artículo
 * pendiente de RECIBIR (`CPA36.CAN_PENDIE`), de la orden más vieja a la más
 * nueva, y el operador elige por renglón (`elegirOcRenglonEn`) o una orden
 * para todo el remito (`elegirOcRemitoEn`). Al registrar se graba como Tango
 * graba un remito contra OC sin factura (STA20 con la OC y `CANT_PEND` = la
 * cantidad, `CPA_OC_REMITO`, contadores de recepción de `CPA36` y
 * `STA19.CANT_PEND`), y la factura que llegue después lo consume por ese
 * renglón de OC (ver `saldosDeRemitoEn`).
 *
 * Los renglones con factura no llevan OC propia: la heredan de la factura.
 */
export type CandidatoOcRemito = {
  nOrdenCo: string
  talonario: number
  nRenglOc: number
  codArticu: string
  fechaEmision: Date | null
  /** Lo pendiente de recibir del renglón de OC (`CPA36.CAN_PENDIE`). */
  pendiente: number
}


/** Los renglones de OC del proveedor con algo pendiente de recibir, de la orden más vieja a la más nueva. */
async function candidatosOcEn(detalle: Detalle): Promise<CandidatoOcRemito[]> {
  const codProvee = codProveeDe(detalle)
  if (!codProvee) return []
  const ocs = await buscarOcPendientes(codProvee, 'recibir')
  return ocs
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
        codArticu: r.codArticu,
        fechaEmision: oc.fechaEmision,
        pendiente: r.pendiente,
      })),
    )
}

async function escribirOcEn(e: Ejecutor, renglonId: number, c: CandidatoOcRemito | null): Promise<void> {
  await e
    .request()
    .input('id', sql.Int, renglonId)
    .input('oc', sql.VarChar(14), c?.nOrdenCo ?? null)
    .input('tal', sql.Int, c?.talonario ?? null)
    .input('nr', sql.Int, c?.nRenglOc ?? null)
    .input('pend', sql.Decimal(19, 4), c?.pendiente ?? null)
    .query(`
      UPDATE PHF_RENGLON
      SET OC_N_ORDEN_CO = @oc, OC_TALONARIO = @tal, OC_N_RENGL_OC = @nr, OC_PENDIENTE = @pend
      WHERE ID = @id`)
}

/**
 * Mantiene al día la OC que eligió el operador: se saca si el renglón pasó a
 * tener factura o si ese renglón de OC ya no tiene el artículo pendiente, y
 * se refresca la foto de lo pendiente. No asigna ninguna.
 */
async function depurarOcEn(e: Ejecutor, comprobanteId: number): Promise<void> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const conOc = detalle.renglones.filter((r) => r.ocNOrdenCo)
  if (conOc.length === 0) return
  const porClave = new Map((await candidatosOcEn(detalle)).map((c) => [claveOcRenglon(c), c]))
  for (const r of conOc) {
    const c = porClave.get(claveOcRenglon({ talonario: r.ocTalonario, nOrdenCo: r.ocNOrdenCo!, nRenglOc: r.ocNRenglOc }))
    const vale =
      !r.factura && c && normalizarCodigo(c.codArticu) === normalizarCodigo(r.codigoFinal ?? r.codigo ?? '')
    await escribirOcEn(e, r.id, vale ? c! : null)
  }
}

/**
 * El operador elige la OC de un renglón sin factura (o ninguna, con `null`).
 * Tiene que ser del artículo y tener pendiente de recibir lo que el renglón
 * trae, descontado lo que ya tomaron de ese mismo renglón de OC los otros
 * renglones del remito.
 */
export async function elegirOcRenglonEn(
  e: Ejecutor,
  comprobanteId: number,
  renglonId: number,
  ref: { nOrdenCo: string; talonario: number; nRenglOc: number } | null,
): Promise<void> {
  if (await cerradoEn(e, comprobanteId)) throw new Error('El comprobante ya está registrado.')
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const r = detalle.renglones.find((x) => x.id === renglonId)
  if (!r) throw new Error('El renglón ya no existe.')
  const n = r.pdfOrden ?? r.orden

  if (ref === null) {
    await escribirOcEn(e, renglonId, null)
    await auditarEn(e, comprobanteId, `Renglón ${n} del remito sin orden de compra`)
    return
  }
  if (r.factura) throw new Error(`El renglón ${n} va contra la factura ${r.factura.nComp ?? ''}: la orden es la de la factura.`)

  const c = (await candidatosOcEn(detalle)).find((x) => claveOcRenglon(x) === claveOcRenglon(ref))
  if (!c) throw new Error(`El renglón ${ref.nRenglOc} de la orden ${ref.nOrdenCo.trim()} ya no tiene nada pendiente de recibir.`)
  if (normalizarCodigo(c.codArticu) !== normalizarCodigo(r.codigoFinal ?? r.codigo ?? '')) {
    throw new Error(`El renglón ${c.nRenglOc} de la orden ${c.nOrdenCo.trim()} es del artículo ${c.codArticu}, no del de este renglón.`)
  }
  const tomado = detalle.renglones
    .filter((x) => x.id !== renglonId && x.ocNOrdenCo && claveOcRenglon({ talonario: x.ocTalonario, nOrdenCo: x.ocNOrdenCo, nRenglOc: x.ocNRenglOc }) === claveOcRenglon(c))
    .reduce((t, x) => t + parsearImporte(x.cantidad), 0)
  const cantidad = parsearImporte(r.cantidad)
  if (cantidad + tomado - c.pendiente > 0.00005) {
    throw new Error(
      `La orden ${c.nOrdenCo.trim()} tiene ${c.pendiente} pendiente(s) de recibir de ${c.codArticu}` +
        (tomado > 0 ? ` y otros renglones del remito ya toman ${tomado}` : '') +
        `: no alcanza para ${cantidad}.`,
    )
  }
  await escribirOcEn(e, renglonId, c)
  await auditarEn(e, comprobanteId, `Orden de compra ${c.nOrdenCo.trim()} (renglón ${c.nRenglOc}) elegida para el renglón ${n} del remito`)
}

/**
 * El operador elige UNA orden para todo el remito: cada renglón sin factura
 * va contra el renglón de esa orden que tenga su artículo y pendiente
 * suficiente. Los que la orden no cubre quedan como estaban.
 */
export async function elegirOcRemitoEn(
  e: Ejecutor,
  comprobanteId: number,
  oc: { nOrdenCo: string; talonario: number },
): Promise<{ cubiertos: number; total: number }> {
  if (await cerradoEn(e, comprobanteId)) throw new Error('El comprobante ya está registrado.')
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const candidatos = (await candidatosOcEn(detalle)).filter((c) => claveOc(c) === claveOc(oc))
  if (candidatos.length === 0) throw new Error(`La orden ${oc.nOrdenCo.trim()} ya no tiene nada pendiente de recibir.`)

  const sinFactura = detalle.renglones.filter((r) => !r.factura)
  const tomado = new Map<string, number>()
  let cubiertos = 0
  for (const r of sinFactura) {
    const art = normalizarCodigo(r.codigoFinal ?? r.codigo ?? '')
    const cantidad = parsearImporte(r.cantidad)
    const c = candidatos.find(
      (x) => art !== '' && normalizarCodigo(x.codArticu) === art && x.pendiente - (tomado.get(claveOcRenglon(x)) ?? 0) - cantidad > -0.00005,
    )
    if (!c) continue
    tomado.set(claveOcRenglon(c), (tomado.get(claveOcRenglon(c)) ?? 0) + cantidad)
    await escribirOcEn(e, r.id, c)
    cubiertos += 1
  }
  await auditarEn(
    e,
    comprobanteId,
    `Orden de compra ${oc.nOrdenCo.trim()} elegida para el remito — ${cubiertos} de ${sinFactura.length} renglón(es) sin factura`,
  )
  return { cubiertos, total: sinFactura.length }
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
  /**
   * Los renglones de OC con el artículo pendiente de recibir, por ID de
   * PHF_RENGLON (2026-11-18): lo que se le propone a un renglón sin factura.
   */
  ocsPorRenglon: Record<number, CandidatoOcRemito[]>
  /** Las órdenes que tienen pendiente algún artículo del remito, para elegir una para todo. */
  ocs: { nOrdenCo: string; talonario: number; fechaEmision: Date | null; renglones: number }[]
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

  // Las OC que tienen los articulos del remito: se proponen, no se asignan.
  const candidatosOc = codProvee ? await candidatosOcEn(detalle) : []
  const ocsPorRenglon: Record<number, CandidatoOcRemito[]> = {}
  const ocs = new Map<string, OfertaFacturasRemito['ocs'][number]>()
  for (const r of detalle.renglones) {
    const art = normalizarCodigo(r.codigoFinal ?? r.codigo ?? '')
    if (!art) continue
    ocsPorRenglon[r.id] = candidatosOc.filter((c) => normalizarCodigo(c.codArticu) === art)
    for (const c of new Map(ocsPorRenglon[r.id].map((x) => [claveOc(x), x])).values()) {
      const o = ocs.get(claveOc(c)) ?? { nOrdenCo: c.nOrdenCo, talonario: c.talonario, fechaEmision: c.fechaEmision, renglones: 0 }
      o.renglones += 1
      ocs.set(claveOc(c), o)
    }
  }

  return {
    lineas,
    candidatosPorRenglon,
    facturas: [...facturas.values()],
    ocsPorRenglon,
    ocs: [...ocs.values()],
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
    await depurarOcEn(e, comprobanteId)
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
  await depurarOcEn(e, comprobanteId)
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
  await depurarOcEn(e, comprobanteId)
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
