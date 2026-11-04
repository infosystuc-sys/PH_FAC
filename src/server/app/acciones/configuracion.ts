'use server'

// Server actions de /configuracion y /conciliacion: carpetas de escaneo e importación de ARCA.

import { revalidatePath } from 'next/cache'
import { getPool } from '../../db/pool'
import { conTransaccion } from '../../db/tx'
import { importarArcaEn, type ResumenImportacion } from '../arca'
import {
  leerConfiguracionCarpetasEn,
  guardarConfiguracionCarpetasEn,
  escanearCarpetasAhora,
  type ConfiguracionCarpetas,
} from '../carpetas'

export type { ConfiguracionCarpetas } from '../carpetas'

export async function leerConfiguracionCarpetas(): Promise<ConfiguracionCarpetas> {
  return leerConfiguracionCarpetasEn(await getPool())
}

export async function guardarConfiguracionCarpetas(
  carpetaRaiz: string | null,
  intervaloMinutos: number,
): Promise<void> {
  await guardarConfiguracionCarpetasEn(await getPool(), carpetaRaiz, intervaloMinutos)
  revalidatePath('/configuracion')
}

/** Botón "Escanear ahora": dispara el escaneo sin esperar al ciclo. No espera el resultado. */
export async function dispararEscaneoCarpetas(): Promise<void> {
  escanearCarpetasAhora()
}

/**
 * Sube el archivo "Mis Comprobantes" de ARCA y lo deja listo para
 * conciliar (2026-10-09, pedido del usuario).
 *
 * El archivo se lee en el cliente y llega como texto: son unas pocas
 * decenas de KB y así no hace falta montar un endpoint de upload ni dejar
 * el archivo en disco. Lo que se guarda es el contenido ya interpretado,
 * no el archivo.
 */
export async function importarArcaDesdeTexto(
  archivoNombre: string,
  contenidoBase64: string,
): Promise<ResumenImportacion> {
  // Llega en base64 y no como texto porque el XLSX es binario (2026-10-10).
  // Un server action puede recibir bytes, pero base64 evita depender de
  // como serializa cada version los tipados de array.
  const datos = Buffer.from(contenidoBase64, 'base64')
  const resumen = await conTransaccion((tx) => importarArcaEn(tx, archivoNombre, datos))
  revalidatePath('/conciliacion')
  return resumen
}
