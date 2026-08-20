/**
 * El motivo que la cola pone sola cuando el proveedor de una factura de
 * conceptos no tiene un concepto asociado en Tango. Esta en la misma
 * lista que los demas para que el desplegable del modal lo ofrezca: si el
 * operador saca el comprobante de observacion y despues quiere volver a
 * ponerlo por lo mismo, tiene que poder elegir el mismo motivo.
 */
export const MOTIVO_SIN_CONCEPTO = 'Proveedor sin concepto en Tango'

/**
 * El motivo que la cola pone sola cuando los remitos que la IA leyo en una
 * factura de articulos no se pudieron usar: o ya estan facturados, o no
 * aparecen para ese proveedor. La nota distingue cual de los dos.
 */
export const MOTIVO_REMITO_SIN_SALDO = 'Remito sin saldo o inexistente'

/**
 * El motivo cuando los renglones de una factura de articulos no coinciden
 * con los del remito que referencia: cantidades distintas, articulos que
 * faltan o articulos que la factura cobra de mas. La nota lleva el detalle
 * renglon por renglon (ver describirDiferencias en lib/cotejo.ts).
 */
export const MOTIVO_FACTURA_NO_COINCIDE = 'La factura no coincide con el remito'

export const MOTIVOS_OBSERVACION = [
  'Diferencia de importe con la O/C',
  'Proveedor inexistente en Tango',
  MOTIVO_SIN_CONCEPTO,
  MOTIVO_REMITO_SIN_SALDO,
  MOTIVO_FACTURA_NO_COINCIDE,
  'Falta remito asociado',
  'CAE vencido o inválido',
  'Precio distinto al acordado',
] as const
