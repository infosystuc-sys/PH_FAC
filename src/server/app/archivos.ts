import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

/**
 * Los PDFs no van a la base: inflarian los backups del ERP. Van a una
 * carpeta en disco, que ya esta en .gitignore.
 */
export function directorioStorage(): string {
  return path.resolve(process.env.STORAGE_DIR || path.join(process.cwd(), 'storage'))
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
  return limpio.toLowerCase().endsWith('.pdf') ? limpio : `${limpio}.pdf`
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

export async function leerPdf(ruta: string): Promise<Buffer> {
  const resuelta = path.resolve(ruta)
  const dir = directorioStorage()
  // Defensa en profundidad: la ruta sale de la base, pero si alguna vez
  // llegara manipulada, esto la corta antes de leer.
  if (resuelta !== dir && !resuelta.startsWith(dir + path.sep)) {
    throw new Error('Ruta de archivo fuera del directorio de comprobantes.')
  }
  return readFile(resuelta)
}
