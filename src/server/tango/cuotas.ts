import sql from 'mssql'
import { getPool } from '../db/pool'
import { obtenerDetalleEn } from '@/server/app/detalle'
import { parsearImporte, totalImputado } from '@/lib/formato'
import { parsearFechaArg } from '@/lib/validaciones'
import { renglonesCondicionCompra, buscarCondicionCompra } from './condicionesCompra'
import type { Ejecutor } from './asiento'

/**
 * Arma y, si se pide, graba los vencimientos de la cuenta corriente del
 * proveedor (CPA54) a partir de la condicion de compra del comprobante.
 * Mismo patron que `asiento.ts`: `previsualizarCuotasEn` calcula, "Ver
 * cuotas" en la revision la usa de solo lectura, y `escribirCuotasEn`
 * reusa el mismo calculo para grabar -- preview y escritura real nunca
 * pueden divergir.
 *
 * Tango guarda la condicion de compra en dos niveles: `CONDICION_COMPRA`
 * es la cabecera (una fila por condicion) y `CPA49` es la vista de
 * renglones de cuota (que porcentaje vence a los cuantos dias) -- ver el
 * comentario en `condicionesCompra.ts`. Esta app ya leia `CONDICION_COMPRA`
 * desde Fase 3/4 para el selector de "Condicion de compra"; lo que faltaba
 * era usar los renglones de `CPA49` para grabar un `CPA54` por cuota real
 * en vez de un unico vencimiento por el total.
 */

export type CuotaPreview = {
  nroCuota: number
  diasVencimiento: number
  fechaVencimiento: Date
  porcentaje: number
  importe: number
}

export type CuotasPreview = {
  condicionDescripcion: string | null
  cuotas: CuotaPreview[]
  totalCuotas: number
  totalComprobante: number
  cierra: boolean
}

/**
 * Vista previa de solo lectura: no bloquea por datos faltantes, igual que
 * `previsualizarAsientoEn` -- una condicion sin elegir o un total en cero
 * simplemente no arma cuotas, no es un error.
 */
export async function previsualizarCuotasEn(e: Ejecutor, comprobanteId: number): Promise<CuotasPreview> {
  const detalle = await obtenerDetalleEn(e, comprobanteId)
  const valores: Record<string, string | null | undefined> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const codCondCompra = Number(valores.condcompra)
  // Sin fallback a `new Date()`: una fecha que no parsea no puede
  // convertirse en "hoy" en silencio -- ver el comentario en
  // parsearFechaArg. Acá la vista previa simplemente no arma cuotas, igual
  // que sin condicion de compra o sin total; escribirCuotasEn hereda el
  // bloqueo porque `cierra` queda en false.
  const fechaEmision = parsearFechaArg((valores.fecha ?? '').trim())
  const total =
    valores.tipoFactura === 'tarjeta' ? totalImputado(valores) : parsearImporte(valores.total)

  const vacio: CuotasPreview = {
    condicionDescripcion: null,
    cuotas: [],
    totalCuotas: 0,
    totalComprobante: total,
    cierra: false,
  }
  if (!fechaEmision || !Number.isInteger(codCondCompra) || codCondCompra <= 0 || total <= 0) return vacio

  const [condicion, renglones] = await Promise.all([
    buscarCondicionCompra(codCondCompra),
    renglonesCondicionCompra(codCondCompra),
  ])
  if (!condicion || renglones.length === 0) return { ...vacio, condicionDescripcion: condicion?.descripcion ?? null }

  // El ultimo renglon absorbe el resto del redondeo, igual criterio que el
  // prorrateo de renglones en asiento.ts: la suma de cuotas redondeadas
  // independientemente puede quedar uno o dos centavos corta o pasada del
  // total, y estas son cuotas reales de cobro, no algo que pueda diferir.
  let acumulado = 0
  const cuotas: CuotaPreview[] = renglones.map((r, i) => {
    const esUltimo = i === renglones.length - 1
    const importe = esUltimo
      ? Math.round((total - acumulado) * 100) / 100
      : Math.round((total * (r.porcentaje / 100)) * 100) / 100
    acumulado = Math.round((acumulado + importe) * 100) / 100

    const fechaVencimiento = new Date(fechaEmision)
    fechaVencimiento.setDate(fechaVencimiento.getDate() + r.diasVencimiento)

    return {
      nroCuota: i + 1,
      diasVencimiento: r.diasVencimiento,
      fechaVencimiento,
      porcentaje: r.porcentaje,
      importe,
    }
  })

  const totalCuotas = cuotas.reduce((a, c) => a + c.importe, 0)

  return {
    condicionDescripcion: condicion.descripcion,
    cuotas,
    totalCuotas: Math.round(totalCuotas * 100) / 100,
    totalComprobante: total,
    cierra: Math.abs(totalCuotas - total) < 0.01,
  }
}

export async function previsualizarCuotas(comprobanteId: number): Promise<CuotasPreview> {
  return previsualizarCuotasEn(await getPool(), comprobanteId)
}

/**
 * Graba un CPA54 por cuota. Bloquea si el calculo no cierra contra el
 * total -- un vencimiento mal armado en la cuenta corriente del proveedor
 * es un dato que se paga o se cobra mal, no algo que se pueda dejar pasar
 * como con el asiento.
 *
 * `idCpa04` enlaza el vencimiento a la factura via `CPA54.ID_CPA04` --
 * verificado contra la base real: 17.849 de 17.853 filas existentes de
 * CPA54 (99,98%) lo tienen seteado igual a `CPA04.ID_CPA04`. Antes de este
 * cambio la app no lo grababa (quedaba NULL), a diferencia de cualquier
 * factura cargada nativamente en Tango.
 */
export async function escribirCuotasEn(
  e: Ejecutor,
  comprobanteId: number,
  codProvee: string,
  tComp: string,
  nComprobante: string,
  idCpa04: number,
): Promise<CuotasPreview> {
  const preview = await previsualizarCuotasEn(e, comprobanteId)
  if (!preview.cierra) {
    throw new Error(
      `Las cuotas no cierran contra el total (cuotas $ ${preview.totalCuotas} vs total $ ${preview.totalComprobante}): no se puede registrar.`,
    )
  }

  for (const c of preview.cuotas) {
    await e
      .request()
      .input('codProvee', sql.VarChar(6), codProvee)
      .input('fechaVto', sql.DateTime, c.fechaVencimiento)
      .input('importeVto', sql.Decimal(18, 2), c.importe)
      .input('nComp', sql.VarChar(20), nComprobante)
      .input('tComp', sql.VarChar(10), tComp)
      .input('idCpa04', sql.Int, idCpa04)
      .query(`
        INSERT INTO CPA54 (
          COD_PROVEE, ESTADO_AUT, ESTADO_VTO, FECHA_VTO, IMPORT_VTO, N_COMP, T_COMP,
          ESTADO_UNIDADES, IMPORTE_VENCIMIENTO_UNIDADES, FILLER, ID_CPA04
        )
        VALUES (@codProvee, '', 'PEN', @fechaVto, @importeVto, @nComp, @tComp, 'PEN', @importeVto, '', @idCpa04)
      `)
  }

  return preview
}
