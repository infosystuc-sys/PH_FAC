'use server'

// Server actions de /dnrpa: importar el DNRPA de las motos desde el mail del proveedor.

import { getPool } from '../../db/pool'
import { conTransaccion } from '../../db/tx'
import { vistaPreviaDnrpaEn, aplicarDnrpaEn, type VistaPreviaDnrpa, type ResumenDnrpa } from '../dnrpa'

export type { VistaPreviaDnrpa, ResumenDnrpa, FilaVistaDnrpa } from '../dnrpa'

/** Lee el archivo con IA y dice qué pasaría con cada fila. No escribe nada. */
export async function vistaPreviaDnrpa(archivo: string, contenidoBase64: string): Promise<VistaPreviaDnrpa> {
  return vistaPreviaDnrpaEn(await getPool(), archivo, Buffer.from(contenidoBase64, 'base64'))
}

/** Graba el DNRPA de las filas que el operador confirmó, en una sola transacción. */
export async function aplicarDnrpa(filas: { chasis: string; dnrpa: string }[]): Promise<ResumenDnrpa> {
  const resumen = await conTransaccion((tx) => aplicarDnrpaEn(tx, filas))
  console.log(
    `[dnrpa] cargado el DNRPA de ${resumen.cargadas} serie(s): ${resumen.filasSta06} fila(s) de STA06 y ` +
      `${resumen.filasSta07} de STA07` +
      (resumen.cambiaron.length > 0 ? `; ${resumen.cambiaron.length} cambiaron desde la vista previa` : ''),
  )
  return resumen
}
