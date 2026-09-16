/**
 * Qué archivos acepta la app como comprobante, y cómo se reconoce cada uno.
 *
 * Nació con PDF solamente. El 2026-09-16 el usuario pidió JPG: hay
 * comprobantes que llegan como foto o como escaneo en imagen, no como PDF.
 * Se admite también PNG porque cuesta exactamente lo mismo -- la API de
 * Claude recibe los dos como bloque `image` -- y un escáner puede sacar
 * cualquiera de los dos.
 *
 * Es la fuente única: de acá salen el `accept` del diálogo de importación,
 * el filtro del escaneo de carpetas, la validación del server action, la
 * extensión con la que se guarda en disco, el Content-Type con el que se
 * sirve y el tipo de bloque que se le manda al modelo.
 */
export type TipoArchivo = 'pdf' | 'jpeg' | 'png'

export const TIPOS_ARCHIVO: Record<
  TipoArchivo,
  { mediaType: 'application/pdf' | 'image/jpeg' | 'image/png'; extensiones: string[] }
> = {
  pdf: { mediaType: 'application/pdf', extensiones: ['.pdf'] },
  jpeg: { mediaType: 'image/jpeg', extensiones: ['.jpg', '.jpeg'] },
  png: { mediaType: 'image/png', extensiones: ['.png'] },
}

/** Lo que va en el `accept` del input de archivos. */
export const ACCEPT_ARCHIVOS = Object.values(TIPOS_ARCHIVO)
  .flatMap((t) => [t.mediaType, ...t.extensiones])
  .join(',')

/** Para mensajes: "PDF, JPG o PNG". */
export const NOMBRES_ADMITIDOS = 'PDF, JPG o PNG'

/**
 * El tipo según la extensión del nombre, o `null` si no es uno admitido.
 * Se usa cuando no hay bytes a mano (el escaneo de carpetas lista nombres
 * antes de leer nada) y como respaldo cuando el navegador no informa el
 * MIME -- pasa con archivos arrastrados desde algunos exploradores.
 */
export function tipoPorNombre(nombre: string): TipoArchivo | null {
  const n = nombre.toLowerCase()
  for (const [tipo, def] of Object.entries(TIPOS_ARCHIVO) as [TipoArchivo, (typeof TIPOS_ARCHIVO)[TipoArchivo]][]) {
    if (def.extensiones.some((e) => n.endsWith(e))) return tipo
  }
  return null
}

/** El tipo según el MIME que informa el navegador, o `null`. */
export function tipoPorMime(mime: string): TipoArchivo | null {
  for (const [tipo, def] of Object.entries(TIPOS_ARCHIVO) as [TipoArchivo, (typeof TIPOS_ARCHIVO)[TipoArchivo]][]) {
    if (def.mediaType === mime) return tipo
  }
  return null
}

/**
 * El tipo según los primeros bytes del archivo. Es el que manda cuando hay
 * bytes: ni el nombre ni el MIME del navegador son de fiar (un ".pdf" que
 * es una imagen renombrada existe), y el modelo rechaza un bloque
 * `document` que no sea PDF de verdad.
 */
export function tipoPorContenido(datos: Uint8Array): TipoArchivo | null {
  if (datos.length < 8) return null
  // %PDF
  if (datos[0] === 0x25 && datos[1] === 0x50 && datos[2] === 0x44 && datos[3] === 0x46) return 'pdf'
  // FF D8 FF
  if (datos[0] === 0xff && datos[1] === 0xd8 && datos[2] === 0xff) return 'jpeg'
  // 89 50 4E 47 0D 0A 1A 0A
  if (
    datos[0] === 0x89 && datos[1] === 0x50 && datos[2] === 0x4e && datos[3] === 0x47 &&
    datos[4] === 0x0d && datos[5] === 0x0a && datos[6] === 0x1a && datos[7] === 0x0a
  ) {
    return 'png'
  }
  return null
}

export function esImagen(tipo: TipoArchivo): boolean {
  return tipo !== 'pdf'
}
