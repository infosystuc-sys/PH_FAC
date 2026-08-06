import sql from 'mssql'
import { getPool } from '@/server/db/pool'
import { leerPdf } from '@/server/app/archivos'

/**
 * ARCHIVO_NOMBRE guarda el nombre tal como lo mandó el navegador al
 * importar: `guardarPdf` sanea el nombre que va a disco, pero la columna
 * conserva el original. Si ese original trae un salto de línea u otro
 * caracter de control, interpolarlo crudo en el header rompe el `Response`
 * (el runtime rechaza CR/LF en headers) y el operador ve "El archivo no
 * está disponible" para un PDF que en realidad se lee perfectamente. Se
 * sanea antes de armar el header, no solo se le sacan las comillas.
 */
function nombreParaHeader(nombre: string): string {
  // eslint-disable-next-line no-control-regex
  const limpio = nombre.replace(/[\x00-\x1f\x7f"]/g, '').trim()
  return limpio === '' ? 'comprobante.pdf' : limpio
}

/**
 * Sirve el PDF de un comprobante. No va en `public/`: los comprobantes
 * son documentos comerciales de la empresa, no archivos publicos. La ruta
 * en disco se lee de la base y nunca llega desde el cliente.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) {
    return new Response('Id inválido', { status: 400 })
  }

  const pool = await getPool()
  const r = await pool
    .request()
    .input('id', sql.Int, n)
    .query('SELECT ARCHIVO_RUTA, ARCHIVO_NOMBRE FROM PHF_COMPROBANTE WHERE ID = @id')

  if (r.recordset.length === 0) return new Response('No encontrado', { status: 404 })

  try {
    const pdf = await leerPdf(String(r.recordset[0].ARCHIVO_RUTA))
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${nombreParaHeader(String(r.recordset[0].ARCHIVO_NOMBRE))}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return new Response('El archivo no está disponible', { status: 404 })
  }
}
