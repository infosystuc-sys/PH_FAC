import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { tipoPorNombre } from '@/lib/tipoArchivo'

/**
 * Los PDFs no van a la base: inflarian los backups del ERP. Van a una
 * carpeta en disco, que ya esta en .gitignore.
 */
export function directorioStorage(): string {
  return path.resolve(
    process.env.PHF_STORAGE_DIR || process.env.STORAGE_DIR || path.join(process.cwd(), 'storage'),
  )
}

/**
 * Se queda solo con el nombre base y le saca todo lo que no sea seguro en
 * un nombre de archivo de Windows. `nombre` viene del navegador: es dato
 * de usuario, y sin esto un "../../algo" escribiria fuera del directorio.
 */
function nombreSeguro(nombre: string): string {
  const base = path.basename(nombre).replace(/[^A-Za-z0-9._-]/g, '_')
  const limpio = base.replace(/^\.+/, '').slice(0, 120)
  if (limpio === '') return 'comprobante.pdf'

  // La extension se conserva si es una admitida (.pdf, .jpg, .jpeg, .png):
  // es lo que despues le dice al visor y a la API como servir el archivo.
  // Sin extension admitida se asume PDF, que es lo que siempre fue.
  const tipo = tipoPorNombre(limpio)
  const ext = tipo ? limpio.slice(limpio.lastIndexOf('.')) : '.pdf'
  const stem = tipo ? limpio.slice(0, -ext.length) : limpio

  // Nombres de dispositivo reservados en Windows: no se pueden crear ni escribir
  const reservados = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
  const nuevoStem = reservados.test(stem) ? 'comprobante' : stem

  return `${nuevoStem}${ext}`
}

export async function guardarPdf(
  nombre: string,
  datos: Buffer,
): Promise<{ ruta: string; hash: string }> {
  const dir = directorioStorage()
  await mkdir(dir, { recursive: true })

  // El prefijo unico evita que dos comprobantes con el mismo nombre de
  // archivo se pisen -- pasa seguido: "factura.pdf" de dos proveedores.
  const ruta = path.join(dir, `${randomUUID()}-${nombreSeguro(nombre)}`)
  await writeFile(ruta, datos)

  return { ruta, hash: createHash('sha256').update(datos).digest('hex') }
}

/**
 * Corta cualquier ruta que no viva adentro del directorio de comprobantes.
 * Defensa en profundidad: las rutas salen de la base, pero si alguna vez
 * llegara una manipulada, esto la para antes de tocar el disco.
 */
function rutaAdentroDelStorage(ruta: string): string {
  const resuelta = path.resolve(ruta)
  const dir = directorioStorage()
  if (resuelta !== dir && !resuelta.startsWith(dir + path.sep)) {
    throw new Error('Ruta de archivo fuera del directorio de comprobantes.')
  }
  return resuelta
}

export async function leerPdf(ruta: string): Promise<Buffer> {
  return readFile(rutaAdentroDelStorage(ruta))
}

/**
 * Borra el PDF de un comprobante eliminado. No lanza si el archivo ya no
 * está: el borrado del comprobante en la base es lo que importa, y dejar
 * que un archivo faltante haga fallar la operación entera obligaría al
 * operador a resolver a mano un problema que ya está resuelto. Sí lanza si
 * la ruta apunta fuera del storage -- eso no es un archivo faltante, es una
 * ruta que no deberíamos estar borrando.
 */
export async function borrarPdf(ruta: string): Promise<void> {
  const resuelta = rutaAdentroDelStorage(ruta)
  try {
    await unlink(resuelta)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
  }
}
