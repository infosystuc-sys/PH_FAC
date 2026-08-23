import sql from 'mssql'
import { getPool } from '../db/pool'
import { usuarioActual } from '@/lib/usuario'
import { parsearImporte } from '@/lib/formato'
import { normalizar as normalizarJurisdiccion } from '@/lib/percepcionIibb'

type Ejecutor = { request(): sql.Request }

/**
 * Los dos tipos de impuesto que hoy pueden aprenderse por proveedor. Las
 * alícuotas de IVA se identifican por porcentaje y las percepciones de
 * Ingresos Brutos por jurisdicción -- ver el comentario de
 * `PHF_ALICUOTA_PROVEEDOR` en `scripts/migrate.ts`. Los impuestos varios
 * quedan afuera: hoy la IA no captura un texto propio para esa línea, solo
 * el código que ya elige el operador de una lista -- no hay "cómo lo
 * escribe la factura" que guardar todavía.
 */
export type TipoAprendizaje = 'iva' | 'percepcion'

/**
 * Deja la `DESCRIPCION` de la tabla en la misma forma con la que después
 * se busca (`resolverCodigoIva`/`resolverPercepcionIibb`), para que una
 * fila aprendida con una grafía de la factura ("21,00%", "Tucumán ") haga
 * match con la próxima aunque venga escrita distinto.
 */
function normalizarDescripcion(tipo: TipoAprendizaje, descripcion: string): string {
  if (tipo === 'iva') return String(parsearImporte(descripcion))
  return normalizarJurisdiccion(descripcion)
}

/**
 * Graba (o actualiza) que el proveedor `codProvee` identifica el impuesto
 * `descripcion` con el código de Tango `codTango`. Es la contraparte de
 * `cargarAprendidosEn`: entre las dos arman la memoria que la resolución
 * de IVA/IIBB consulta cuando el porcentaje o la jurisdicción no le
 * alcanzan.
 *
 * `MERGE` por `(COD_PROVEE, TIPO, DESCRIPCION)`, la misma clave que el
 * índice único de la tabla: una segunda corrección para el mismo texto
 * reemplaza a la primera, no agrega una fila nueva -- si el proveedor
 * cambió de la vez pasada, se queda con lo último que dijo el operador.
 */
export async function aprenderImpuestoEn(
  e: Ejecutor,
  codProvee: string,
  tipo: TipoAprendizaje,
  descripcion: string,
  codTango: string,
): Promise<void> {
  const prov = codProvee.trim()
  const cod = codTango.trim()
  // Se chequea la descripcion cruda antes de normalizar: "" normaliza a
  // "0" en 'iva' (parsearImporte('') es 0), un string no vacio que
  // pasaria el chequeo si se mirara despues de normalizar.
  if (!prov || !descripcion.trim() || !cod) return
  const desc = normalizarDescripcion(tipo, descripcion)
  if (!desc) return

  await e
    .request()
    .input('prov', sql.VarChar(20), prov)
    .input('tipo', sql.VarChar(20), tipo)
    .input('desc', sql.NVarChar(200), desc)
    .input('cod', sql.VarChar(10), cod)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      MERGE PHF_ALICUOTA_PROVEEDOR WITH (HOLDLOCK) AS destino
      USING (SELECT @prov AS COD_PROVEE, @tipo AS TIPO, @desc AS DESCRIPCION) AS origen
        ON destino.COD_PROVEE = origen.COD_PROVEE
       AND destino.TIPO = origen.TIPO
       AND destino.DESCRIPCION = origen.DESCRIPCION
      WHEN MATCHED THEN
        UPDATE SET COD_TANGO = @cod, FECHA_MODIF = SYSDATETIME(), USUARIO = @usuario
      WHEN NOT MATCHED THEN
        INSERT (COD_PROVEE, TIPO, DESCRIPCION, COD_TANGO, USUARIO)
        VALUES (@prov, @tipo, @desc, @cod, @usuario);
    `)
}

export async function aprenderImpuesto(
  codProvee: string,
  tipo: TipoAprendizaje,
  descripcion: string,
  codTango: string,
): Promise<void> {
  await aprenderImpuestoEn(await getPool(), codProvee, tipo, descripcion, codTango)
}

/**
 * Todo lo que este proveedor ya enseñó para `tipo`, como
 * `{ descripcionNormalizada: codTango }`. Un objeto plano y no un `Map`
 * porque cruza la frontera server/client component (los props de un
 * Server Component no pueden llevar `Map`), y porque `resolverCodigoIva`/
 * `resolverPercepcionIibb` ya reciben `valores` de la misma forma.
 */
export async function cargarAprendidosEn(
  e: Ejecutor,
  codProvee: string,
  tipo: TipoAprendizaje,
): Promise<Record<string, string>> {
  const prov = codProvee.trim()
  const mapa: Record<string, string> = {}
  if (!prov) return mapa

  const r = await e
    .request()
    .input('prov', sql.VarChar(20), prov)
    .input('tipo', sql.VarChar(20), tipo)
    .query<Record<string, unknown>>(`
      SELECT DESCRIPCION, COD_TANGO FROM PHF_ALICUOTA_PROVEEDOR
      WHERE COD_PROVEE = @prov AND TIPO = @tipo
    `)
  for (const f of r.recordset) {
    mapa[String(f.DESCRIPCION)] = String(f.COD_TANGO).trim()
  }
  return mapa
}

export async function cargarAprendidos(
  codProvee: string,
  tipo: TipoAprendizaje,
): Promise<Record<string, string>> {
  return cargarAprendidosEn(await getPool(), codProvee, tipo)
}
