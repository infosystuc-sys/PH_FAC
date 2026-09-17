import sql from 'mssql'
import { getPool } from '../db/pool'
import { usuarioActual } from '@/lib/usuario'
import { normalizarDescripcionArticulo } from '@/lib/matchOc'

type Ejecutor = { request(): sql.Request }

/**
 * Qué artículo nuestro es cada descripción que imprime un proveedor que no
 * imprime código de artículo (2026-09-17, pedido del usuario).
 *
 * Es la contraparte de `CPA15.COD_SINONI` para el caso sin código, y vive
 * en una tabla propia (`PHF_ARTICULO_PROVEEDOR`) y no en CPA15 porque ahí
 * no entra: `COD_SINONI` es varchar(15), y una descripción es "40PFD6920/77
 * SMART TV 40\" FHD PHILIPS". Tampoco corresponde llenar una tabla de Tango
 * con textos que Tango no va a usar.
 *
 * Mismo mecanismo que `aprendizajeImpuestos.ts`: MERGE por
 * (proveedor, descripción normalizada), la última elección del operador
 * reemplaza a la anterior.
 */
export async function aprenderArticuloEn(
  e: Ejecutor,
  codProvee: string,
  descripcion: string,
  codArticu: string,
): Promise<void> {
  const prov = codProvee.trim()
  const desc = normalizarDescripcionArticulo(descripcion)
  const art = codArticu.trim()
  if (!prov || !desc || !art) return

  await e
    .request()
    .input('prov', sql.VarChar(20), prov)
    .input('desc', sql.NVarChar(300), desc.slice(0, 300))
    .input('art', sql.VarChar(20), art)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      MERGE PHF_ARTICULO_PROVEEDOR WITH (HOLDLOCK) AS destino
      USING (SELECT @prov AS COD_PROVEE, @desc AS DESCRIPCION) AS origen
        ON destino.COD_PROVEE = origen.COD_PROVEE
       AND destino.DESCRIPCION = origen.DESCRIPCION
      WHEN MATCHED THEN
        UPDATE SET COD_ARTICU = @art, FECHA_MODIF = SYSDATETIME(), USUARIO = @usuario
      WHEN NOT MATCHED THEN
        INSERT (COD_PROVEE, DESCRIPCION, COD_ARTICU, USUARIO)
        VALUES (@prov, @desc, @art, @usuario);
    `)
}

export async function aprenderArticulo(
  codProvee: string,
  descripcion: string,
  codArticu: string,
): Promise<void> {
  await aprenderArticuloEn(await getPool(), codProvee, descripcion, codArticu)
}

/**
 * Todo lo que este proveedor ya enseñó: descripción normalizada → nuestro
 * código. Un objeto plano y no un `Map` por el mismo motivo que
 * `cargarAprendidosEn`: cruza la frontera server/client.
 */
export async function articulosPorDescripcionEn(
  e: Ejecutor,
  codProvee: string | null | undefined,
): Promise<Record<string, string>> {
  const prov = (codProvee ?? '').trim()
  const mapa: Record<string, string> = {}
  if (!prov) return mapa

  const r = await e
    .request()
    .input('prov', sql.VarChar(20), prov)
    .query<Record<string, unknown>>(`
      SELECT DESCRIPCION, COD_ARTICU FROM PHF_ARTICULO_PROVEEDOR WHERE COD_PROVEE = @prov
    `)
  for (const f of r.recordset) mapa[String(f.DESCRIPCION)] = String(f.COD_ARTICU).trim()
  return mapa
}

export async function articulosPorDescripcion(
  codProvee: string | null | undefined,
): Promise<Record<string, string>> {
  return articulosPorDescripcionEn(await getPool(), codProvee)
}
