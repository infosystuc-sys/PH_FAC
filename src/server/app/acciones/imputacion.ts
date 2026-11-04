'use server'

// Server actions de imputación en Tango: impuestos aprendidos y conceptos.

import { revalidatePath } from 'next/cache'
import { conTransaccion } from '../../db/tx'
import { auditarEn } from '../detalle'
import {
  listarConceptos,
  asignarConceptoProveedor,
  type ConceptoProveedor,
} from '@/server/tango/conceptos'
import { aprenderImpuesto, type TipoAprendizaje } from '../aprendizajeImpuestos'

export async function aprenderImpuestoTango(
  comprobanteId: number,
  codProvee: string,
  tipo: TipoAprendizaje,
  descripcion: string,
  codTango: string,
): Promise<void> {
  await aprenderImpuesto(codProvee, tipo, descripcion, codTango)

  const mensaje =
    tipo === 'iva'
      ? `Impuesto aprendido para el proveedor: IVA ${descripcion}% → código ${codTango}`
      : tipo === 'percepcion'
        ? `Impuesto aprendido para el proveedor: IIBB "${descripcion}" → código ${codTango}`
        : tipo === 'varios'
          ? `Impuesto aprendido para el proveedor: "${descripcion}" → código ${codTango}`
          : `Condición de compra aprendida para el proveedor: "${descripcion}" → código ${codTango}`
  await conTransaccion((tx) => auditarEn(tx, comprobanteId, mensaje))
}

/** Todo el maestro de conceptos, para que el operador elija uno a mano. */
export async function listarConceptosTango(): Promise<ConceptoProveedor[]> {
  return listarConceptos()
}

/**
 * El operador asocia a mano el concepto de un proveedor que no tenía
 * ninguno, para no tener que salir a Tango a cargarlo. Mismo criterio que
 * `asociarCodigoProveedor`: es una escritura sobre dato maestro del ERP, no
 * sobre el comprobante, así que va explícita y la decide el operador.
 *
 * No toca el estado del comprobante: si estaba en observación por falta de
 * concepto, sigue así hasta que el operador confirme -- mismo criterio que
 * `elegirProveedor`, que tampoco saca de observación por su cuenta.
 */
export async function asignarConcepto(
  comprobanteId: number,
  codProvee: string,
  codConcepto: string,
  descripcion: string,
): Promise<void> {
  await asignarConceptoProveedor(codProvee, codConcepto)

  await conTransaccion((tx) =>
    auditarEn(
      tx,
      comprobanteId,
      `Concepto asociado al proveedor en Tango: ${codConcepto} — ${descripcion}`,
    ),
  )

  revalidatePath(`/comprobantes/${comprobanteId}`)
}
