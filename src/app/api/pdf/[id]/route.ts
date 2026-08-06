import sql from 'mssql'
import { getPool } from '@/server/db/pool'
import { leerPdf } from '@/server/app/archivos'

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
        'Content-Disposition': `inline; filename="${String(r.recordset[0].ARCHIVO_NOMBRE).replace(/"/g, '')}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return new Response('El archivo no está disponible', { status: 404 })
  }
}
