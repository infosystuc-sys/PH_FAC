import { normalizarCodigo } from './cotejoOc'
import type { ResultadoValidacion } from './validaciones'

/**
 * El remito de proveedor se vincula a la FACTURA de compra que ya está
 * registrada en Tango, no a una orden de compra (2026-11-16, pedido del
 * usuario). Es el caso más común en la base: de los vínculos remito ↔
 * factura desde 2025, en 5.685 el remito se grabó DESPUÉS de la factura,
 * con 6 días de diferencia en promedio (13 pasaron los 180 días).
 *
 * Lógica pura: qué factura se propone para cada renglón y qué se chequea
 * antes de registrar. La lectura de Tango está en
 * src/server/tango/facturasParaRemito.ts y la grabación en
 * src/server/tango/remitosCompra.ts.
 */

/** Un renglón de factura de compra (CPA46) con mercadería sin recibir. */
export type CandidatoFactura = {
  tcompInC: string
  ncompInC: number
  nRenglC: number
  /** El número impreso (CPA04.N_COMP). */
  nComp: string
  fechaEmision: Date | null
  codArticu: string
  cantidad: number
  /** Lo que el renglón tiene sin remito (CPA46.FALTA_REM). */
  faltaRem: number
  /**
   * Lo que la factura cobró por unidad (CPA46.PRECIO_NET). Solo lo trae la
   * relectura con bloqueo del registro: va al precio del renglón del remito
   * (STA20.PRECIO_REM).
   */
  precioNet?: number
  /** El renglón de OC al que se imputó (CPA_OC_FACTURA), si se imputó. */
  oc: { talonario: number; nOrdenCo: string; nRenglOc: number; cantidad: number } | null
}

/** La propuesta automática solo mira facturas de hasta tantos días antes. */
export const DIAS_PROPUESTA = 180

export function claveFactura(c: { tcompInC: string; ncompInC: number }): string {
  return `${c.tcompInC.trim()}|${c.ncompInC}`
}

export function claveRenglonFactura(c: { tcompInC: string; ncompInC: number; nRenglC: number }): string {
  return `${claveFactura(c)}|${c.nRenglC}`
}

/**
 * La factura que se propone para cada renglón del remito.
 *
 * Un remito suele corresponder a UNA factura, así que se elige por factura
 * y no renglón por renglón: primero la que cubre más renglones del remito,
 * y entre las que cubren lo mismo, la más vieja (Tango recibe en orden).
 * Lo que esa factura no cubre se vuelve a proponer con las que quedan.
 *
 * Un renglón se cubre solo si el renglón de la factura, del mismo artículo,
 * tiene sin remito al menos su cantidad: no se parte un renglón del remito
 * entre dos facturas. `ocupado` es lo que ya tomaron otros renglones (los
 * que el operador eligió a mano), por renglón de factura.
 *
 * Las facturas de más de `DIAS_PROPUESTA` días no se proponen: hay unas
 * pocas viejas con FALTA_REM que nadie va a recibir. El selector sí las
 * ofrece.
 */
export function proponerFacturas(
  renglones: { id: number; codArticu: string; cantidad: number }[],
  candidatos: CandidatoFactura[],
  hoy: Date,
  ocupado: Map<string, number> = new Map(),
): Map<number, CandidatoFactura> {
  const limite = new Date(hoy)
  limite.setDate(limite.getDate() - DIAS_PROPUESTA)
  const vigentes = candidatos.filter((c) => c.fechaEmision === null || c.fechaEmision >= limite)

  const libre = new Map<string, number>()
  for (const c of vigentes) {
    const k = claveRenglonFactura(c)
    libre.set(k, c.faltaRem - (ocupado.get(k) ?? 0))
  }

  const porFactura = new Map<string, CandidatoFactura[]>()
  for (const c of vigentes) {
    const k = claveFactura(c)
    porFactura.set(k, [...(porFactura.get(k) ?? []), c])
  }

  const resultado = new Map<number, CandidatoFactura>()
  let pendientes = renglones.filter((r) => r.codArticu.trim() !== '' && r.cantidad > 0)

  // Lo que cubriría cada factura con lo que le queda libre, sin tocarlo.
  const cubrir = (lista: CandidatoFactura[], aplicar: boolean): Map<number, CandidatoFactura> => {
    const usado = new Map<string, number>()
    const asignados = new Map<number, CandidatoFactura>()
    for (const r of pendientes) {
      const art = normalizarCodigo(r.codArticu)
      const c = lista.find((x) => {
        if (normalizarCodigo(x.codArticu) !== art) return false
        const k = claveRenglonFactura(x)
        return (libre.get(k) ?? 0) - (usado.get(k) ?? 0) >= r.cantidad - 0.00005
      })
      if (!c) continue
      const k = claveRenglonFactura(c)
      usado.set(k, (usado.get(k) ?? 0) + r.cantidad)
      asignados.set(r.id, c)
    }
    if (aplicar) for (const [k, u] of usado) libre.set(k, (libre.get(k) ?? 0) - u)
    return asignados
  }

  for (;;) {
    let mejor: { lista: CandidatoFactura[]; cubre: number; fecha: number; ncomp: number } | null = null
    for (const lista of porFactura.values()) {
      const cubre = cubrir(lista, false).size
      if (cubre === 0) continue
      const fecha = lista[0].fechaEmision?.getTime() ?? 0
      const ncomp = lista[0].ncompInC
      if (
        !mejor ||
        cubre > mejor.cubre ||
        (cubre === mejor.cubre && (fecha < mejor.fecha || (fecha === mejor.fecha && ncomp < mejor.ncomp)))
      ) {
        mejor = { lista, cubre, fecha, ncomp }
      }
    }
    if (!mejor) break
    const asignados = cubrir(mejor.lista, true)
    for (const [id, c] of asignados) resultado.set(id, c)
    pendientes = pendientes.filter((r) => !asignados.has(r.id))
    porFactura.delete(claveFactura(mejor.lista[0]))
  }
  return resultado
}

/** Un renglón del remito tal como se va a registrar, para el chequeo. */
export type RenglonRemitoParaValidar = {
  codArticu: string
  cantidad: number
  factura: { nComp: string | null; faltaRem: number | null } | null
  /** La orden de compra de un renglón sin factura (2026-11-18), o `null`. */
  oc?: string | null
}

/**
 * El ítem de "Listo para registrar" sobre la factura de referencia.
 *
 * - Un renglón que recibe más de lo que su factura tiene sin remito,
 *   bloquea: Tango dejaría `FALTA_REM` negativo.
 * - Un renglón sin factura pero con orden de compra (2026-11-18) se graba
 *   contra la orden y queda pendiente de facturar: no pide confirmación.
 * - Renglones sin factura ni orden: bloquean hasta que el operador confirme
 *   que se graban sin comprobante de referencia (pedido del usuario).
 *   Confirmado, queda como advertencia, a la vista.
 */
export function validarFacturasRemito(
  renglones: RenglonRemitoParaValidar[],
  sinReferenciaConfirmado: boolean,
): ResultadoValidacion {
  const fmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 })
  if (renglones.length === 0) {
    return { estado: 'ok', mensaje: 'El remito todavía no tiene renglones.' }
  }

  const excedidos = renglones.filter(
    (r) => r.factura && r.factura.faltaRem !== null && r.cantidad - r.factura.faltaRem > 0.00005,
  )
  if (excedidos.length > 0) {
    const e = excedidos[0]
    return {
      estado: 'error',
      mensaje:
        `${e.codArticu} recibe ${fmt.format(e.cantidad)} y a la factura ${e.factura!.nComp ?? ''} ` +
        `le faltan recibir ${fmt.format(e.factura!.faltaRem!)}.` +
        (excedidos.length > 1 ? ` Y ${excedidos.length - 1} renglón(es) más.` : ''),
    }
  }

  const conFactura = renglones.filter((r) => r.factura)
  const conOc = renglones.filter((r) => !r.factura && r.oc)
  const sinNada = renglones.filter((r) => !r.factura && !r.oc)
  const facturas = [...new Set(conFactura.map((r) => r.factura!.nComp).filter((x): x is string => !!x))]
  const ordenes = [...new Set(conOc.map((r) => r.oc!.trim()))]
  const partes = [
    ...(conFactura.length > 0
      ? [`${conFactura.length} renglón(es) contra ${facturas.length === 1 ? 'la factura' : 'las facturas'} ${facturas.join(', ')}`]
      : []),
    ...(conOc.length > 0
      ? [
          `${conOc.length} renglón(es) contra ${ordenes.length === 1 ? 'la orden de compra' : 'las órdenes de compra'} ` +
            `${ordenes.join(', ')}, pendiente(s) de facturar: se vinculan a la factura cuando llegue`,
        ]
      : []),
  ]
  const contra = partes.join('; ')

  if (sinNada.length === 0) return { estado: 'ok', mensaje: `${contra}.` }

  const todos = sinNada.length === renglones.length
  if (!sinReferenciaConfirmado) {
    return {
      estado: 'error',
      mensaje: todos
        ? 'El remito no tiene ninguna factura ni orden de compra de referencia. Elegí una factura o confirmá grabarlo sin comprobante de referencia.'
        : `${contra}; ${sinNada.length} sin factura ni orden de compra. Elegí una factura o confirmá grabarlos sin comprobante de referencia.`,
    }
  }
  return {
    estado: 'advertencia',
    mensaje: todos
      ? 'Se graba sin comprobante de referencia: no se vincula a ninguna factura ni orden de compra.'
      : `${contra}; ${sinNada.length} se graban sin comprobante de referencia.`,
  }
}
