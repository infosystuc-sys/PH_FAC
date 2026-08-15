import { normalizarCuit } from '@/lib/formato'

/**
 * El CUIT de la empresa que usa la app: el CLIENTE de todas las facturas
 * que se importan, nunca el proveedor.
 *
 * Existe por un error concreto: en una factura de LIETUVA SRL a RAM SRL,
 * la IA cargó como proveedor los datos del cliente. El prompt listaba
 * "razon" y "cuit" sin decir de quién eran, así que el modelo elegía. La
 * primera barrera es decírselo (ver prompt.ts); esta es la segunda, para
 * cuando igual se equivoque.
 *
 * Vive en `.env.local` y no en el código porque es un dato de la
 * instalación: la misma app corriendo para otra empresa tiene otro CUIT.
 * Si no está configurado, la barrera queda desactivada -- la app sigue
 * funcionando, solo pierde este chequeo.
 */
export function cuitPropio(): string | null {
  return normalizarCuit(process.env.PHF_CUIT_PROPIO)
}

/** `true` si el CUIT leído del comprobante es el de la propia empresa. */
export function esCuitPropio(cuit: string | null | undefined): boolean {
  const propio = cuitPropio()
  if (!propio) return false
  return normalizarCuit(cuit) === propio
}
