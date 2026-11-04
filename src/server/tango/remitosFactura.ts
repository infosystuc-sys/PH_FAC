import sql from 'mssql'
import {
  repartirEntreRemitos,
  type ParteRemito,
  type SaldoRemito,
} from '@/lib/repartoRemitos'

/**
 * La factura de artículos que cobra mercadería que ya entró por remito
 * (2026-11-03, pedido del usuario).
 *
 * La app factura contra la orden de compra (`CPA_OC_FACTURA`). Cuando esa
 * misma orden tiene un remito recibido y todavía sin facturar, Tango además
 * deja a la factura consumir el remito, y esta base lo confirma: de las
 * facturas desde 2025, 827 tienen a la vez vínculo con la orden y con el
 * remito. Lo que escribe en ese caso, copiado de esas facturas:
 *
 * - `CPA48`: una fila por (renglón de factura, renglón de remito), con la
 *   cantidad que cubre. `NCOMP_IN_C` va en 8 caracteres alineado a la
 *   derecha ("   17774"), como lo guarda Tango.
 * - `STA20.CANT_PEND` baja con esa cantidad. `CANT_FACTU` NO se toca --
 *   decisión del usuario, 2026-11-03: en 153 de los 275 renglones recientes
 *   Tango lo deja en 0 y el pendiente es lo que cuenta.
 * - `STA14.ESTADO_MOV` pasa a 'F' cuando el remito se queda sin ningún
 *   renglón pendiente.
 * - `CPA46.FALTA_REM` de la factura es lo que ningún remito cubrió.
 *
 * Los remitos candidatos son los que se recibieron contra el mismo renglón
 * de orden (vínculo `CPA_OC_REMITO`), del mismo proveedor y del mismo
 * artículo, del más viejo al más nuevo. Sin remito, la factura se registra
 * como siempre.
 */

type Ejecutor = { request(): sql.Request }

/** Los saldos de remito contra los que puede facturarse este renglón de orden. */
export async function saldosDeRemitoEn(
  e: Ejecutor,
  p: { codProvee: string; nOrdenCo: string; nRenglOc: number; codArticu: string },
): Promise<SaldoRemito[]> {
  const r = await e
    .request()
    .input('prov', sql.VarChar(6), p.codProvee.trim())
    .input('oc', sql.VarChar(14), p.nOrdenCo)
    .input('r', sql.Int, p.nRenglOc)
    .input('art', sql.VarChar(20), p.codArticu.trim())
    .query(`
      SELECT s.NCOMP_IN_S AS ncompInS, s.N_RENGL_S AS nRenglS, s.CANT_PEND AS pendiente
      FROM CPA_OC_REMITO o
      JOIN STA20 s ON s.TCOMP_IN_S = o.TCOMP_IN_S AND s.NCOMP_IN_S = o.NCOMP_IN_S
                  AND s.N_RENGL_S = o.N_RENGL_S
      JOIN STA14 h ON h.TCOMP_IN_S = s.TCOMP_IN_S AND h.NCOMP_IN_S = s.NCOMP_IN_S
      WHERE o.TCOMP_IN_S = 'RP' AND o.N_ORDEN_CO = @oc AND o.N_RENGL_OC = @r
        AND h.ESTADO_MOV = 'P' AND s.CANT_PEND > 0
        AND LTRIM(RTRIM(h.COD_PRO_CL)) = @prov
        AND LTRIM(RTRIM(s.COD_ARTICU)) = @art
      ORDER BY h.FECHA_MOV, s.NCOMP_IN_S, s.N_RENGL_S`)

  return r.recordset.map((f: { ncompInS: string; nRenglS: number; pendiente: number }) => ({
    ncompInS: String(f.ncompInS),
    nRenglS: Number(f.nRenglS),
    pendiente: Number(f.pendiente),
  }))
}

/**
 * Qué remitos cubre una factura de `cantidad` de este renglón de orden, y
 * cuánto queda sin cubrir. Solo lee: se llama antes de grabar el renglón
 * porque `faltaRem` va en `CPA46`.
 */
export async function planificarRemitosEn(
  e: Ejecutor,
  p: {
    codProvee: string
    nOrdenCo: string
    nRenglOc: number
    codArticu: string
    cantidad: number
  },
): Promise<{ partes: ParteRemito[]; faltaRem: number }> {
  return repartirEntreRemitos(p.cantidad, await saldosDeRemitoEn(e, p))
}

/** El número interno de la factura como lo guarda `CPA48`: 8, a la derecha. */
export function ncompInCEnCpa48(ncompInC: number): string {
  return String(ncompInC).padStart(8, ' ')
}

/**
 * Graba el consumo del remito que decidió `planificarRemitosEn`. Va dentro
 * de la transacción del registro.
 */
export async function consumirRemitosEn(
  e: Ejecutor,
  p: { tcompInC: string; ncompInC: number; nRenglC: number; partes: ParteRemito[] },
): Promise<void> {
  const remitosTocados = new Set<string>()

  for (const parte of p.partes) {
    await e
      .request()
      .input('tcompInC', sql.VarChar(2), p.tcompInC)
      .input('ncompInC', sql.VarChar(8), ncompInCEnCpa48(p.ncompInC))
      .input('nRenglC', sql.Int, p.nRenglC)
      .input('ncompInS', sql.VarChar(8), parte.ncompInS)
      .input('nRenglS', sql.Int, parte.nRenglS)
      .input('cantidad', sql.Decimal(18, 4), parte.cantidad)
      .query(`
        INSERT INTO CPA48
          (TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, TCOMP_IN_S, NCOMP_IN_S, N_RENGL_S, CANTIDAD, CANTIDAD_2, FILLER)
        VALUES (@tcompInC, @ncompInC, @nRenglC, 'RP', @ncompInS, @nRenglS, @cantidad, 0, '')`)

    // Se vuelve a chequear en el WHERE que el saldo alcance: entre que se
    // planificó y ahora nadie debería haber tocado el renglón (el registro
    // corre con un applock exclusivo), pero un saldo que no alcanza no
    // puede quedar negativo en silencio.
    const upd = await e
      .request()
      .input('ncompInS', sql.VarChar(8), parte.ncompInS)
      .input('nRenglS', sql.Int, parte.nRenglS)
      .input('cantidad', sql.Decimal(18, 4), parte.cantidad)
      .query(`
        UPDATE STA20 SET CANT_PEND = CANT_PEND - @cantidad
        WHERE TCOMP_IN_S = 'RP' AND NCOMP_IN_S = @ncompInS AND N_RENGL_S = @nRenglS
          AND CANT_PEND >= @cantidad`)
    if (upd.rowsAffected[0] !== 1) {
      throw new Error(
        `El remito ${parte.ncompInS.trim()} ya no tiene ${parte.cantidad} pendiente(s) de facturar en el renglón ${parte.nRenglS}.`,
      )
    }
    remitosTocados.add(parte.ncompInS)
  }

  // Un remito sin ningún renglón pendiente pasa a Facturado.
  for (const ncompInS of remitosTocados) {
    await e
      .request()
      .input('ncompInS', sql.VarChar(8), ncompInS)
      .query(`
        UPDATE STA14 SET ESTADO_MOV = 'F'
        WHERE TCOMP_IN_S = 'RP' AND NCOMP_IN_S = @ncompInS AND ESTADO_MOV = 'P'
          AND NOT EXISTS (
            SELECT 1 FROM STA20 s
            WHERE s.TCOMP_IN_S = 'RP' AND s.NCOMP_IN_S = @ncompInS AND s.CANT_PEND > 0)`)
  }
}

/**
 * Los contadores de un renglón de orden de compra después de facturar
 * `cantidad`. Las reglas son las mismas que al recibir (ver `contadoresOc`
 * en remitosCompra.ts): lo recibido que falta facturar y lo facturado que
 * falta recibir son la diferencia entre las dos cantidades, sin bajar de 0
 * -- 6.397 y 6.400 de las 6.431 filas reales con algo recibido y facturado.
 */
export function contadoresAlFacturar(
  oc: { recibida: number; facturada: number },
  cantidad: number,
) {
  const facturada = oc.facturada + cantidad
  return {
    facturada,
    pendienteFacturarRecibida: Math.max(0, oc.recibida - facturada),
    pendienteRecibirFacturada: Math.max(0, facturada - oc.recibida),
  }
}
