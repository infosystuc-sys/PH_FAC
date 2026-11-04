'use server'

// Server actions para buscar y elegir el proveedor de un comprobante.

import sql from 'mssql'
import { revalidatePath } from 'next/cache'
import { getPool } from '../../db/pool'
import { auditarEn, guardarCampoEn } from '../detalle'
import { buscarProveedoresPorRazonSocial, type Proveedor } from '@/server/tango/proveedores'
import { recalcularAVincularEn } from '../ordenCompra'

type Ejecutor = { request(): sql.Request }

/**
 * Wrapper delgado: un client component no puede llamar directo a
 * src/server/tango/ (esa capa no es 'use server'), asi que el buscador de
 * proveedores del selector manual pasa por este server action.
 */
export async function buscarProveedores(texto: string): Promise<Proveedor[]> {
  return buscarProveedoresPorRazonSocial(texto)
}

/**
 * El operador elige un proveedor a mano -- porque el CUIT no matcheo
 * ninguno, o matcheo varios. `corregido` distingue los dos casos: si vino
 * de desambiguar un CUIT que ya matcheaba (el sistema tenia la respuesta,
 * solo faltaba elegir cual), no es una correccion real y no debe
 * contaminar CORREGIDO_POR_USUARIO; si vino de buscar por razon social
 * porque el CUIT no encontro nada, si lo es. Mismo criterio que
 * resolverProveedorEn en completarLectura.ts.
 *
 * Separada en `_En`/wrapper (mismo patrón que `guardarCampoEn`/`guardarCampo`
 * en detalle.ts) para que los tests puedan ejercitarla dentro de la misma
 * transacción que insertó el comprobante de prueba: si el test insertara con
 * `tx` y esta función abriera su propia conexión de pool, el `UPDATE` (y el
 * `INSERT` en PHF_AUDITORIA, que tiene FK a PHF_COMPROBANTE) quedarían
 * esperando el lock de una transacción que no comitea hasta que el propio
 * test termina -- un deadlock por diseño del test, no una carrera real.
 */
export async function elegirProveedorEn(
  e: Ejecutor,
  id: number,
  codProvee: string,
  razonSocial: string,
  corregido: boolean,
): Promise<void> {
  await guardarCampoEn(e, id, 'codprovee', codProvee, { corregidoPorUsuario: corregido })
  await e
    .request()
    .input('id', sql.Int, id)
    .input('cod', sql.VarChar(20), codProvee)
    .input('razon', sql.NVarChar(200), razonSocial)
    .query(`UPDATE PHF_COMPROBANTE SET COD_PROVEE = @cod, RAZON_SOCIAL = @razon WHERE ID = @id`)
  await auditarEn(e, id, `Proveedor elegido a mano: ${codProvee} — ${razonSocial}`)

  // Lo aprendido por descripcion es POR PROVEEDOR: cambiarlo cambia que
  // renglones resuelven solos y cuales quedan por vincular. Sin esto el
  // contador quedaba con el del proveedor anterior --o con ninguno, si al
  // leer el CUIT no resolvio-- y el comprobante seguia en la pestaña "A
  // vincular" con las descripciones ya enseñadas. Lo reporto el usuario con
  // RED DEL INTERIOR (2026-09-22).
  await recalcularAVincularEn(e, id, codProvee)
}

export async function elegirProveedor(
  id: number,
  codProvee: string,
  razonSocial: string,
  corregido: boolean,
): Promise<void> {
  const pool = await getPool()
  await elegirProveedorEn(pool, id, codProvee, razonSocial, corregido)
  revalidatePath(`/comprobantes/${id}`)
  // La bandeja muestra la pestaña "A vincular", que depende del contador.
  revalidatePath('/comprobantes')
}
