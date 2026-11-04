'use server'

// Server actions del circuito de remito: asignar un remito y refrescar sus cantidades.

import sql from 'mssql'
import { revalidatePath } from 'next/cache'
import { getPool } from '../../db/pool'
import { conTransaccion } from '../../db/tx'
import { auditarEn } from '../detalle'
import { renglonesDelRemitoInterno } from '@/server/tango/remitos'

type Ejecutor = { request(): sql.Request }

export async function asignarRemitoEn(
  e: Ejecutor,
  renglonId: number,
  remitoNcompInS: string | null,
  remitoNRenglS: number | null,
  // El numero impreso (N_COMP) y la cantidad entregada son solo para
  // mostrarlos en pantalla: los trae el propio selector, que ya los tiene de
  // buscarRemitosPendientes, asi que no hace falta otra consulta a Tango
  // para reconstruirlos aca.
  remitoNumero: string | null = null,
  cantidadRemito: number | null = null,
): Promise<void> {
  await e.request()
    .input('id', sql.Int, renglonId)
    .input('ncompInS', sql.VarChar(8), remitoNcompInS)
    .input('nRenglS', sql.Int, remitoNRenglS)
    .input('numero', sql.VarChar(20), remitoNumero)
    .input('cantRemito', sql.Decimal(19, 4), cantidadRemito)
    .query(`
      UPDATE PHF_RENGLON
      SET REMITO_NCOMP_IN_S=@ncompInS, REMITO_N_RENGL_S=@nRenglS, REMITO_NUMERO=@numero,
          CANTIDAD_REMITO=@cantRemito,
          -- El articulo lo define el renglon del remito. Una correccion
          -- manual anterior apuntaba a otro renglon, asi que se descarta:
          -- dejarla pegada mostraria un articulo que no es el del remito
          -- recien elegido, que es el error mas silencioso de los dos.
          CODIGO_FINAL = NULL
      WHERE ID=@id
    `)
}

export async function asignarRemito(
  comprobanteId: number,
  renglonId: number,
  remitoNcompInS: string | null,
  remitoNRenglS: number | null,
  remitoNumero: string | null = null,
  cantidadRemito: number | null = null,
): Promise<void> {
  const pool = await getPool()
  await asignarRemitoEn(pool, renglonId, remitoNcompInS, remitoNRenglS, remitoNumero, cantidadRemito)
  revalidatePath(`/comprobantes/${comprobanteId}`)
}

/**
 * Vuelve a leer, para cada renglón que tiene un remito asignado, cuánto
 * entregó ese renglón SEGÚN TANGO HOY, y pisa `CANTIDAD_REMITO` si cambió.
 *
 * Hace falta porque esa columna es una foto: la segunda pasada de IA la
 * escribe una sola vez, al leer la factura (ver el comentario de
 * `guardarRenglonesFacturadosEn` en remitosLectura.ts). Si alguien corrige el remito
 * en Tango después -- un conteo de depósito mal cargado, por ejemplo -- esta
 * app no se entera sola. Es una acción explícita del operador, no algo
 * automático: la lectura de la factura tiene que quedar estable mientras se
 * revisa, no recalcularse cada vez que carga la pantalla.
 *
 * Devuelve cuántos renglones cambiaron.
 */
export async function actualizarCantidadesRemitoEn(
  e: Ejecutor,
  comprobanteId: number,
): Promise<number> {
  const r = await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .query(`
      SELECT ID, REMITO_NCOMP_IN_S, REMITO_N_RENGL_S, CANTIDAD_REMITO
      FROM PHF_RENGLON
      WHERE COMPROBANTE_ID = @id AND REMITO_NCOMP_IN_S IS NOT NULL
    `)

  const filas = r.recordset as {
    ID: number
    REMITO_NCOMP_IN_S: string
    REMITO_N_RENGL_S: number
    CANTIDAD_REMITO: string | null
  }[]
  if (filas.length === 0) return 0

  // Varios renglones de la factura suelen apuntar al mismo remito (un talle
  // por linea): se agrupa para no repetir la consulta a Tango por cada uno.
  const porRemito = new Map<string, typeof filas>()
  for (const f of filas) {
    const ncompInS = String(f.REMITO_NCOMP_IN_S).trim()
    const lista = porRemito.get(ncompInS) ?? []
    lista.push(f)
    porRemito.set(ncompInS, lista)
  }

  let actualizados = 0
  for (const [ncompInS, lista] of porRemito) {
    const vivos = await renglonesDelRemitoInterno(ncompInS)
    const cantidadPorRenglon = new Map(vivos.map((v) => [v.nRenglon, v.cantidad]))

    for (const f of lista) {
      const cantidadViva = cantidadPorRenglon.get(Number(f.REMITO_N_RENGL_S))
      // Si el renglon ya no existe en Tango no se toca: mejor dejar la
      // ultima foto conocida que borrar un dato por una consulta que no
      // encontro nada.
      if (cantidadViva === undefined) continue

      const actual = f.CANTIDAD_REMITO === null ? null : Number(f.CANTIDAD_REMITO)
      if (actual !== null && Math.abs(actual - cantidadViva) < 0.00005) continue

      await e
        .request()
        .input('id', sql.Int, f.ID)
        .input('cant', sql.Decimal(19, 4), cantidadViva)
        .query('UPDATE PHF_RENGLON SET CANTIDAD_REMITO = @cant WHERE ID = @id')
      actualizados += 1
    }
  }

  return actualizados
}

export async function actualizarCantidadesRemito(comprobanteId: number): Promise<number> {
  const actualizados = await conTransaccion((tx) =>
    actualizarCantidadesRemitoEn(tx, comprobanteId),
  )

  await conTransaccion((tx) =>
    auditarEn(
      tx,
      comprobanteId,
      actualizados > 0
        ? `Cantidades del remito actualizadas contra Tango — ${actualizados} renglón(es) cambiaron`
        : 'Cantidades del remito revisadas contra Tango — sin cambios',
    ),
  )

  revalidatePath(`/comprobantes/${comprobanteId}`)
  return actualizados
}
