/**
 * Contra qué renglones de remito se factura un renglón de factura.
 *
 * Una factura contra una orden de compra cuya mercadería ya entró por remito
 * (2026-11-03, pedido del usuario) tiene que consumir ese remito, como hace
 * Tango cuando el operador la carga a mano: si no, el remito queda pendiente
 * de facturar para siempre. Esto es solo la cuenta; las tablas las toca
 * `src/server/tango/remitosFactura.ts`.
 */

export type SaldoRemito = {
  ncompInS: string
  nRenglS: number
  /** Lo que ese renglón de remito todavía no se facturó (`STA20.CANT_PEND`). */
  pendiente: number
}

export type ParteRemito = {
  ncompInS: string
  nRenglS: number
  cantidad: number
}

const redondear = (n: number) => Math.round(n * 10000) / 10000

/**
 * Reparte `cantidad` entre los saldos, en el orden en que vienen (el que
 * llama los ordena del remito más viejo al más nuevo). Un renglón de remito
 * nunca aporta más que su saldo, y lo que ningún remito cubre queda en
 * `faltaRem`: es lo que Tango guarda en `CPA46.FALTA_REM`.
 */
export function repartirEntreRemitos(
  cantidad: number,
  saldos: SaldoRemito[],
): { partes: ParteRemito[]; faltaRem: number } {
  const partes: ParteRemito[] = []
  let resta = redondear(cantidad)

  for (const s of saldos) {
    if (resta <= 0) break
    const aporta = redondear(Math.min(resta, s.pendiente))
    if (aporta <= 0) continue
    partes.push({ ncompInS: s.ncompInS, nRenglS: s.nRenglS, cantidad: aporta })
    resta = redondear(resta - aporta)
  }

  return { partes, faltaRem: Math.max(0, resta) }
}
