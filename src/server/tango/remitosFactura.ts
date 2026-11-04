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
 * - `CPA_OC_REMITO_FACTURA` (2026-11-03, pedido del usuario): el vínculo de
 *   tres puntas -- renglón de OC, de factura y de remito --, una fila por
 *   cada `CPA48`. Las 10.248 filas reales tienen su `CPA48`, y de todos los
 *   `CPA48` con OC solo 3 no tienen la suya. `NCOMP_IN_C` va como NÚMERO
 *   (ENTEROXL_TG, como en `CPA04`), no con el relleno de `CPA48`. La
 *   cantidad es la del `CPA48` salvo que supere lo imputado a la OC (14
 *   filas reales, remito y factura con más de lo pedido): ahí va lo
 *   imputado. Ver docs/superpowers/plans/2026-11-03-cpa-oc-remito-factura.md.
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
  p: {
    tcompInC: string
    ncompInC: number
    nRenglC: number
    partes: ParteRemito[]
    /** El renglón de OC al que se imputó este renglón de factura (`CPA_OC_FACTURA`). */
    oc: { talonario: number; nOrdenCo: string; nRenglOc: number; cantidadImputada: number }
  },
): Promise<void> {
  const remitosTocados = new Set<string>()
  // Lo imputado a la OC que todavía no se asignó a ningún remito.
  let imputadoSinAsignar = p.oc.cantidadImputada

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

    const cantidadOc = Math.min(parte.cantidad, imputadoSinAsignar)
    imputadoSinAsignar -= cantidadOc
    if (cantidadOc > 0) {
      await e
        .request()
        .input('talonario', sql.SmallInt, p.oc.talonario)
        .input('oc', sql.VarChar(14), p.oc.nOrdenCo)
        .input('nRenglOc', sql.Int, p.oc.nRenglOc)
        .input('tcompInC', sql.VarChar(2), p.tcompInC)
        .input('ncompInC', sql.Float, p.ncompInC)
        .input('nRenglC', sql.Int, p.nRenglC)
        .input('ncompInS', sql.VarChar(8), parte.ncompInS)
        .input('nRenglS', sql.Int, parte.nRenglS)
        .input('cantidad', sql.Decimal(18, 4), cantidadOc)
        .query(`
          INSERT INTO CPA_OC_REMITO_FACTURA
            (CANTIDAD, CANTIDAD_2, TALONARIO_OC, N_ORDEN_CO, N_RENGL_OC,
             TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, TCOMP_IN_S, NCOMP_IN_S, N_RENGL_S)
          VALUES (@cantidad, 0, @talonario, @oc, @nRenglOc,
                  @tcompInC, @ncompInC, @nRenglC, 'RP', @ncompInS, @nRenglS)`)
    }

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

/**
 * Un renglón de factura imputado a una OC cuyo `FALTA_REM` no cumple la
 * regla de Tango: `CANTIDAD − Σ CPA48.CANTIDAD` del renglón.
 */
export type FaltaRemDesalineado = {
  nRenglC: number
  codArticu: string
  cantidad: number
  cubierto: number
  faltaRemActual: number
  faltaRemCorrecto: number
}

/**
 * Los renglones de una factura con `FALTA_REM` mal grabado (2026-11-03,
 * etapa 2 de docs/superpowers/plans/2026-11-03-cpa-oc-remito-factura.md).
 *
 * Hasta ese día la app grababa `FALTA_REM = 0`. Tango, cuando después entra
 * un remito para esa factura, le RESTA lo recibido, y el renglón quedaba
 * negativo. La regla la cumplen los 1.508 renglones de 2026 con OC que grabó
 * Tango. Solo mira los renglones imputados a una OC (`CPA_OC_FACTURA`): los
 * cargos del proveedor no tienen remito que esperar.
 */
export async function faltaRemDesalineadosEn(
  e: Ejecutor,
  ncompInC: number,
): Promise<FaltaRemDesalineado[]> {
  const r = await e
    .request()
    .input('n', sql.Float, ncompInC)
    .input('n48', sql.VarChar(8), ncompInCEnCpa48(ncompInC))
    .query(`
      SELECT d.N_RENGL_C AS nRenglC, LTRIM(RTRIM(d.COD_ARTICU)) AS codArticu,
             d.CANTIDAD AS cantidad, ISNULL(c.cubierto, 0) AS cubierto,
             d.FALTA_REM AS faltaRemActual,
             d.CANTIDAD - ISNULL(c.cubierto, 0) AS faltaRemCorrecto
      FROM CPA46 d
      OUTER APPLY (
        SELECT SUM(x.CANTIDAD) AS cubierto FROM CPA48 x
        WHERE x.TCOMP_IN_C = d.TCOMP_IN_C AND x.NCOMP_IN_C = @n48 AND x.N_RENGL_C = d.N_RENGL_C
      ) c
      WHERE d.TCOMP_IN_C = 'FP' AND d.NCOMP_IN_C = @n
        AND EXISTS (
          SELECT 1 FROM CPA_OC_FACTURA o
          WHERE o.TCOMP_IN_C = d.TCOMP_IN_C AND o.NCOMP_IN_C = d.NCOMP_IN_C AND o.N_RENGL_C = d.N_RENGL_C)
        AND ABS(d.FALTA_REM - (d.CANTIDAD - ISNULL(c.cubierto, 0))) >= 0.0001
      ORDER BY d.N_RENGL_C`)
  return r.recordset.map((f: Record<string, unknown>) => ({
    nRenglC: Number(f.nRenglC),
    codArticu: String(f.codArticu),
    cantidad: Number(f.cantidad),
    cubierto: Number(f.cubierto),
    faltaRemActual: Number(f.faltaRemActual),
    faltaRemCorrecto: Number(f.faltaRemCorrecto),
  }))
}

/**
 * Deja el `FALTA_REM` de un renglón en el valor correcto. Exige en el WHERE
 * que siga valiendo lo que se mostró: si entre el listado y la corrección
 * Tango le relacionó otro remito, no se pisa a ciegas.
 */
export async function corregirFaltaRemEn(
  e: Ejecutor,
  ncompInC: number,
  d: FaltaRemDesalineado,
): Promise<void> {
  const r = await e
    .request()
    .input('n', sql.Float, ncompInC)
    .input('r', sql.Int, d.nRenglC)
    .input('anterior', sql.Decimal(18, 4), d.faltaRemActual)
    .input('nuevo', sql.Decimal(18, 4), d.faltaRemCorrecto)
    .query(`
      UPDATE CPA46 SET FALTA_REM = @nuevo
      WHERE TCOMP_IN_C = 'FP' AND NCOMP_IN_C = @n AND N_RENGL_C = @r
        AND ABS(FALTA_REM - @anterior) < 0.0001`)
  if (r.rowsAffected[0] !== 1) {
    throw new Error(`El renglón ${d.nRenglC} de la factura ${ncompInC} cambió desde el listado: no se corrigió.`)
  }
}
