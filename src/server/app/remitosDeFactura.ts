import sql from 'mssql'
import type { Detalle } from './detalle'
import { saldosDeRemitoEn } from '@/server/tango/remitosFactura'
import { esFacturaDeArticulos } from '@/lib/tipoFactura'
import { parsearImporte } from '@/lib/formato'
import type { ResultadoValidacion } from '@/lib/validaciones'

/**
 * La factura de artículos que llega DESPUÉS de su remito (2026-11-18,
 * pedido del usuario): "verificás si la OC elegida ya tiene el remito; si
 * es así, verificás que las cantidades sean coherentes entre OC, factura y
 * remito, y si es correcto mostrás un aviso de que vas a vincularla al
 * remito y continuás si te dan el ok. Si la OC no tiene remito, procedés
 * como cualquier factura de artículos".
 *
 * El vínculo en sí ya lo graba el registro (2026-11-03, `consumirRemitosEn`):
 * cada renglón de la factura consume los remitos recibidos contra el mismo
 * renglón de OC y todavía sin facturar. Esto es lo que se muestra ANTES de
 * registrar, con las mismas consultas (`saldosDeRemitoEn`), para que el
 * operador lo vea y lo confirme.
 *
 * Coherente quiere decir que, por cada renglón de OC, lo que la factura
 * cobra es exactamente lo que el remito tiene pendiente de facturar. Si no
 * coincide, bloquea con el detalle: un remito que quedaría a medio facturar,
 * o una factura que cobraría más de lo recibido, se resuelven a mano.
 */

type Ejecutor = { request(): sql.Request }

export type RemitoAVincular = {
  nOrdenCo: string
  nRenglOc: number
  codArticu: string
  /** Lo que la factura cobra contra este renglón de OC (suma de sus renglones). */
  cantidadFactura: number
  /** Lo que la OC tenía pendiente de facturar al imputarla. */
  pendienteOc: number | null
  /** Lo que los remitos de este renglón de OC tienen pendiente de facturar. */
  pendienteRemito: number
  /** El número del proveedor de cada remito ("R0005100029925"). */
  remitos: string[]
}

export async function remitosAVincularEn(e: Ejecutor, detalle: Detalle): Promise<RemitoAVincular[]> {
  const valores: Record<string, string | null> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal
  // La factura-remito trae su propio remito: no consume remitos previos.
  if (!esFacturaDeArticulos(valores.tipoFactura) || valores.tipoFactura === 'facturaRemito') return []
  const codProvee = (valores.codprovee ?? '').trim()
  if (!codProvee) return []

  // Por renglón de OC: dos renglones de la factura pueden ir contra el mismo.
  const porOc = new Map<string, RemitoAVincular>()
  for (const r of detalle.renglones) {
    if (!r.ocNOrdenCo || !r.ocNRenglOc) continue
    const k = `${r.ocTalonario ?? ''}|${r.ocNOrdenCo}|${r.ocNRenglOc}`
    const previo = porOc.get(k)
    const cantidad = parsearImporte(r.cantidad)
    if (previo) {
      previo.cantidadFactura += cantidad
      continue
    }
    porOc.set(k, {
      nOrdenCo: r.ocNOrdenCo,
      nRenglOc: r.ocNRenglOc,
      codArticu: (r.codigoFinal ?? r.codigo ?? '').trim(),
      cantidadFactura: cantidad,
      pendienteOc: r.ocPendiente === null ? null : Number(r.ocPendiente),
      pendienteRemito: 0,
      remitos: [],
    })
  }

  const resultado: RemitoAVincular[] = []
  for (const v of porOc.values()) {
    const saldos = await saldosDeRemitoEn(e, {
      codProvee,
      nOrdenCo: v.nOrdenCo,
      nRenglOc: v.nRenglOc,
      codArticu: v.codArticu,
    })
    if (saldos.length === 0) continue
    v.pendienteRemito = saldos.reduce((t, s) => t + Number(s.pendiente), 0)
    const internos = [...new Set(saldos.map((s) => String(s.ncompInS)))]
    for (const ncompInS of internos) {
      const q = await e.request().input('n', sql.VarChar(8), ncompInS)
        .query(`SELECT LTRIM(RTRIM(N_COMP)) AS nComp FROM STA14 WHERE TCOMP_IN_S = 'RP' AND NCOMP_IN_S = @n`)
      v.remitos.push(String(q.recordset[0]?.nComp ?? ncompInS))
    }
    resultado.push(v)
  }
  return resultado
}

/** El ítem de "Listo para registrar" del remito que ya llegó, o `null` si la OC no tiene ninguno. */
export function validarRemitosAVincular(vinculos: RemitoAVincular[]): ResultadoValidacion | null {
  if (vinculos.length === 0) return null
  const fmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 })
  const remitos = [...new Set(vinculos.flatMap((v) => v.remitos))]

  const distintos = vinculos.filter((v) => Math.abs(v.cantidadFactura - v.pendienteRemito) > 0.00005)
  if (distintos.length > 0) {
    return {
      estado: 'error',
      mensaje:
        `La orden de compra ya tiene ${remitos.length === 1 ? 'el remito' : 'los remitos'} ${remitos.join(', ')} ` +
        `y las cantidades no coinciden: ` +
        distintos
          .map(
            (v) =>
              `${v.codArticu} factura ${fmt.format(v.cantidadFactura)}, remito ${fmt.format(v.pendienteRemito)} ` +
              `sin facturar` +
              (v.pendienteOc !== null ? `, orden ${fmt.format(v.pendienteOc)} pendiente(s) de facturar` : ''),
          )
          .join('; ') +
        '.',
    }
  }
  return {
    estado: 'advertencia',
    mensaje:
      `Al registrar, la factura se vincula al ${remitos.length === 1 ? 'remito' : 'los remitos'} ${remitos.join(', ')} ` +
      `(${vinculos.length} renglón(es) de la orden de compra, cantidades coincidentes). Se pide confirmación al registrar.`,
  }
}
