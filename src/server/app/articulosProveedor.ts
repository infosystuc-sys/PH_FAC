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
  sinOc = false,
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
    .input('sinOc', sql.Bit, sinOc)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      MERGE PHF_ARTICULO_PROVEEDOR WITH (HOLDLOCK) AS destino
      USING (SELECT @prov AS COD_PROVEE, @desc AS DESCRIPCION) AS origen
        ON destino.COD_PROVEE = origen.COD_PROVEE
       AND destino.DESCRIPCION = origen.DESCRIPCION
      WHEN MATCHED THEN
        UPDATE SET COD_ARTICU = @art, SIN_OC = @sinOc, FECHA_MODIF = SYSDATETIME(), USUARIO = @usuario
      WHEN NOT MATCHED THEN
        INSERT (COD_PROVEE, DESCRIPCION, COD_ARTICU, SIN_OC, USUARIO)
        VALUES (@prov, @desc, @art, @sinOc, @usuario);
    `)
}

export async function aprenderArticulo(
  codProvee: string,
  descripcion: string,
  codArticu: string,
  sinOc = false,
): Promise<void> {
  await aprenderArticuloEn(await getPool(), codProvee, descripcion, codArticu, sinOc)
}

/**
 * Marca (o desmarca) una descripcion ya aprendida como cargo del proveedor:
 * se registra sin orden de compra. No toca el articulo.
 */
export async function marcarSinOcEn(
  e: Ejecutor,
  codProvee: string,
  descripcion: string,
  sinOc: boolean,
): Promise<void> {
  const prov = codProvee.trim()
  const desc = normalizarDescripcionArticulo(descripcion)
  if (!prov || !desc) return
  await e
    .request()
    .input('prov', sql.VarChar(20), prov)
    .input('desc', sql.NVarChar(300), desc.slice(0, 300))
    .input('sinOc', sql.Bit, sinOc)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      UPDATE PHF_ARTICULO_PROVEEDOR
      SET SIN_OC = @sinOc, FECHA_MODIF = SYSDATETIME(), USUARIO = @usuario
      WHERE COD_PROVEE = @prov AND DESCRIPCION = @desc
    `)
}

/**
 * Todo lo que este proveedor ya enseñó: descripción normalizada → nuestro
 * código y si ese renglón va sin orden de compra. Un objeto plano y no un
 * `Map` por el mismo motivo que `cargarAprendidosEn`: cruza la frontera
 * server/client.
 */
export type ArticuloAprendido = { codArticu: string; sinOc: boolean }

export async function articulosPorDescripcionEn(
  e: Ejecutor,
  codProvee: string | null | undefined,
): Promise<Record<string, ArticuloAprendido>> {
  const prov = (codProvee ?? '').trim()
  const mapa: Record<string, ArticuloAprendido> = {}
  if (!prov) return mapa

  const r = await e
    .request()
    .input('prov', sql.VarChar(20), prov)
    .query<Record<string, unknown>>(`
      SELECT DESCRIPCION, COD_ARTICU, SIN_OC FROM PHF_ARTICULO_PROVEEDOR WHERE COD_PROVEE = @prov
    `)
  for (const f of r.recordset) {
    mapa[String(f.DESCRIPCION)] = {
      codArticu: String(f.COD_ARTICU).trim(),
      sinOc: Boolean(f.SIN_OC),
    }
  }
  return mapa
}

export async function articulosPorDescripcion(
  codProvee: string | null | undefined,
): Promise<Record<string, ArticuloAprendido>> {
  return articulosPorDescripcionEn(await getPool(), codProvee)
}
