'use server'

// Server actions para buscar y elegir el proveedor de un comprobante.

import sql from 'mssql'
import { revalidatePath } from 'next/cache'
import { getPool } from '../../db/pool'
import { auditarEn, guardarCampoEn, obtenerDetalleEn } from '../detalle'
import { marcarExistenteEnTangoEn } from '../completarLectura'
import { archivarExistente } from '../carpetas'
import { buscarProveedoresPorRazonSocial, type Proveedor } from '@/server/tango/proveedores'
import { recalcularAVincularEn } from '../ordenCompra'
import { leerSeriesSiFaltan } from '../cola'

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
  // Con el proveedor ya elegido se puede saber si el comprobante ya esta
  // en Tango: si esta, pasa a existente y el archivo va a error/, en vez de
  // quedar pendiente de revision (2026-11-17, pedido del usuario). Pasa con
  // los CUIT de varios proveedores, que la lectura no resuelve.
  const estado = await pool.request().input('id', sql.Int, id)
    .query('SELECT ESTADO FROM PHF_COMPROBANTE WHERE ID = @id')
  if (['leido', 'observacion', 'confirmado'].includes(estado.recordset[0]?.ESTADO)) {
    const detalle = await obtenerDetalleEn(pool, id)
    const valores = Object.fromEntries(detalle.campos.map((c) => [c.clave, c.valorFinal]))
    if (await marcarExistenteEnTangoEn(pool, id, codProvee, valores)) {
      await archivarExistente(id)
      revalidatePath(`/comprobantes/${id}`)
      revalidatePath('/comprobantes')
      return
    }
  }
  // Un remito de un proveedor con regla de series (NEWSAN, IMSA) cuyo
  // proveedor no salio del CUIT: las series se leen ahora (2026-11-16).
  // Afuera de elegirProveedorEn: es un llamado a la IA, no va en una
  // transaccion. No lanza.
  await leerSeriesSiFaltan(id)
  revalidatePath(`/comprobantes/${id}`)
  // La bandeja muestra la pestaña "A vincular", que depende del contador.
  revalidatePath('/comprobantes')
}
