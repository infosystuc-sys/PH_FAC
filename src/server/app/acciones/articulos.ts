'use server'

// Server actions de artículos: buscar en Tango, vincular códigos y descripciones (CPA15), cargos y renglones sin OC.

import sql from 'mssql'
import { revalidatePath } from 'next/cache'
import { getPool } from '../../db/pool'
import { conTransaccion } from '../../db/tx'
import { auditarEn, obtenerDetalleEn } from '../detalle'
import { recalcularNetoDeCargosEn } from '../completarLectura'
import {
  buscarArticulos,
  asociarArticuloProveedor,
  describirArticulos,
  type ArticuloTango,
} from '@/server/tango/articulos'
import { type ArticuloDescripto } from '@/server/tango/articulos'
import { reglaDeProveedorEn } from '../lecturaProveedor'
import { parsearDesgloseTalles } from '@/lib/talles'
import { normalizarCodigo } from '@/lib/cotejoOc'
import { aprenderArticuloEn, marcarSinOcEn } from '../articulosProveedor'
import { recalcularAVincularEn, sincronizarCargosEn } from '../ordenCompra'
import { aprenderImpuesto } from '../aprendizajeImpuestos'
import { codigoParaSinonimo } from '@/lib/codigoProveedor'

type Ejecutor = { request(): sql.Request }

/** Busca en el maestro de artículos de Tango, para corregir a mano. */
export async function buscarArticulosTango(
  texto: string,
  codProvee?: string | null,
): Promise<ArticuloTango[]> {
  return buscarArticulos(texto, codProvee)
}

/**
 * Resuelve un codigo que el operador ESCRIBIO a mano, para el campo que
 * tienen al lado de la descripcion (2026-10-08, pedido del usuario).
 *
 * Devuelve el articulo con el codigo TAL COMO ESTA en el maestro, que puede
 * no ser lo tecleado: la comparacion ignora mayusculas, puntuacion, espacios
 * interiores y ceros de adelante (ver normalizarCodigo), asi que quien
 * escribe "26459 001 35" encuentra "26459  001 35". Lo que se graba es
 * siempre el del maestro.
 *
 * `null` si no existe. No se adivina el mas parecido: un codigo tecleado
 * mal tiene que fallar y no resolver a otro articulo.
 */
export async function buscarArticuloPorCodigo(
  codigo: string,
): Promise<ArticuloDescripto | null> {
  const c = codigo.trim()
  if (c === '') return null
  const encontrados = await describirArticulos([c])
  return encontrados.get(normalizarCodigo(c)) ?? null
}

/**
 * Le enseña a Tango cómo llama este proveedor a un artículo, escribiendo
 * `CPA15.COD_SINONI`. Es la única escritura de la app sobre datos maestros
 * del ERP: todo lo demás que escribe son comprobantes.
 *
 * Va explícita y no automática al corregir un renglón. Corregir es decir
 * "este renglón es este artículo"; asociar el código es decir "de ahora en
 * más, cada vez que este proveedor escriba esto, es este artículo". Lo
 * segundo afecta a las facturas que vengan y a cualquiera que use Tango,
 * así que lo decide el operador.
 */
export async function asociarCodigoProveedor(
  comprobanteId: number,
  codProvee: string,
  codArticu: string,
  codSinoni: string,
): Promise<void> {
  await asociarArticuloProveedor(codProvee, codArticu, codSinoni)

  await conTransaccion((tx) =>
    auditarEn(
      tx,
      comprobanteId,
      `Código del proveedor asociado en Tango: "${codigoParaSinonimo(codProvee, codSinoni)}" = ${codArticu}`,
    ),
  )

  revalidatePath(`/comprobantes/${comprobanteId}`)
}

/**
 * El operador vincula la DESCRIPCION de un renglon sin codigo con un
 * articulo nuestro (2026-09-17, pedido del usuario). Se aprende para el
 * proveedor (PHF_ARTICULO_PROVEEDOR), se recalcula cuantos renglones
 * quedan por vincular --es lo que saca al comprobante de la pestaña "A
 * vincular" cuando llega a cero-- y se deja constancia en el historial.
 * Es la contraparte de `asociarCodigoProveedor` para cuando no hay codigo.
 */
/**
 * Un comprobante que ya no se modifica: registrado por la app, o detectado
 * como ya existente en Tango. Es el mismo criterio con el que la pantalla
 * se pone de solo lectura (ver comprobantes/[id]/page.tsx); si cambia uno,
 * tiene que cambiar el otro.
 */
export async function comprobanteCerradoEn(
  e: { request(): sql.Request },
  comprobanteId: number,
): Promise<boolean> {
  const r = await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .query<{ ESTADO: string }>('SELECT ESTADO FROM PHF_COMPROBANTE WHERE ID = @id')
  const estado = r.recordset[0]?.ESTADO
  return estado === 'registrado' || estado === 'existente'
}

export async function vincularDescripcionArticulo(
  comprobanteId: number,
  codProvee: string,
  descripcion: string,
  codArticu: string,
  sinOc = false,
): Promise<{ quedan: number }> {
  const desc = descripcion.trim()
  const art = codArticu.trim()
  if (!codProvee.trim() || !desc || !art) throw new Error('Faltan datos para vincular el artículo.')

  const quedan = await conTransaccion((tx) =>
    vincularDescripcionArticuloEn(tx, comprobanteId, codProvee, desc, art, sinOc),
  )

  revalidatePath(`/comprobantes/${comprobanteId}`)
  revalidatePath('/comprobantes')
  return { quedan }
}

/**
 * Separada en `_En`/wrapper, mismo patron que `marcarObservacionEn`: asi
 * los tests pueden ejercitarla dentro de la misma transaccion que inserto
 * el comprobante de prueba, y sin `revalidatePath`, que fuera del runtime
 * de Next lanza.
 */
export async function vincularDescripcionArticuloEn(
  tx: { request(): sql.Request },
  comprobanteId: number,
  codProvee: string,
  desc: string,
  art: string,
  sinOc: boolean,
): Promise<number> {
  {
    // Una descripcion con desglose de talles NO se aprende. Dos motivos, y
    // los dos se vieron en la misma linea de TOPPER (2026-10-13):
    //
    // 1. Son VARIOS articulos. "WAVE ... 380: 4 390: 6 400: 12 415: 12
    //    430: 8" son cinco, y quedo guardada la descripcion entera --WAVE
    //    incluido-- apuntando a uno solo.
    // 2. El desglose lleva las CANTIDADES adentro, que cambian de factura
    //    en factura, asi que esa clave no volveria a emparejar nunca.
    //
    // Se exige el antecedente del proveedor para no rechazar de mas: sin
    // el, un "Lote : 3" suelto en una descripcion cualquiera bloquearia un
    // vinculo legitimo.
    const reglaProv = await reglaDeProveedorEn(tx, codProvee)
    if (reglaProv?.escala === 'desglose-talle' && parsearDesgloseTalles(desc, 1).length > 0) {
      throw new Error(
        'Ese renglón viene desglosado por talle: son varios artículos, no uno. ' +
          'Se resuelven imputando la orden de compra.',
      )
    }

    await aprenderArticuloEn(tx, codProvee, desc, art, sinOc)
    await auditarEn(
      tx,
      comprobanteId,
      `Descripción vinculada a un artículo para el proveedor: "${desc}" = ${art}` +
        (sinOc ? ' — cargo del proveedor, se registra sin orden de compra' : ''),
    )

    // Un comprobante cerrado --registrado en Tango por la app, o que ya
    // estaba en Tango-- NO se toca (2026-10-07, decision del usuario). Lo
    // que se guarda arriba es conocimiento DEL PROVEEDOR y vale para las
    // facturas que vengan; los renglones de este comprobante, en cambio,
    // son el registro de lo que se mando a Tango y rehacerlos lo
    // corromperia. Sin esto, ensenar una descripcion desde un comprobante
    // registrado le borraba y recreaba los renglones de cargo.
    //
    // Hace falta poder ensenar desde ahi porque si no hay un circulo: los
    // proveedores que todavia se cargan a mano en Tango dejan todos sus
    // comprobantes en 'existente', y la app no puede aprender justamente
    // porque todavia no se la usa para registrar.
    if (!(await comprobanteCerradoEn(tx, comprobanteId))) {
      await sincronizarCargosEn(tx, comprobanteId, codProvee)
    }
    return recalcularAVincularEn(tx, comprobanteId, codProvee)
  }
}

/**
 * El operador marca un renglon como CARGO del proveedor: se registra en la
 * factura y en el asiento, pero sin orden de compra (2026-09-22, pedido del
 * usuario). Se recuerda por proveedor+descripcion, asi que la proxima
 * factura del mismo proveedor ya lo trata igual.
 *
 * Requiere que la descripcion ya este vinculada a un articulo: un cargo sin
 * articulo no se puede grabar en CPA46.
 */
export async function marcarRenglonSinOc(
  comprobanteId: number,
  codProvee: string,
  descripcion: string,
  sinOc: boolean,
): Promise<void> {
  const desc = descripcion.trim()
  if (!codProvee.trim() || !desc) throw new Error('Faltan datos para marcar el renglón.')

  await conTransaccion(async (tx) => {
    await marcarSinOcEn(tx, codProvee, desc, sinOc)
    await auditarEn(
      tx,
      comprobanteId,
      sinOc
        ? `"${desc}" marcado como cargo del proveedor: se registra sin orden de compra`
        : `"${desc}" vuelve a ir contra una orden de compra`,
    )
    await sincronizarCargosEn(tx, comprobanteId, codProvee)
  })

  revalidatePath(`/comprobantes/${comprobanteId}`)
  revalidatePath('/comprobantes')
}

/**
 * "Vincular todos": la version en lote de `asociarCodigoProveedor` -- el
 * mismo UPSERT en CPA15, pero para todos los renglones que ya tienen los
 * dos códigos resueltos de una sola vez, en vez de que el operador
 * clickee "Vincular con Tango" renglón por renglón. Los pares vienen del
 * cliente (`renglones.tsx` ya sabe cuáles renglones califican, con el
 * mismo criterio que la visibilidad del botón individual) para no
 * duplicar esa regla del lado del servidor.
 *
 * `asociarArticuloProveedor` usa `getPool()` y no una transacción propia
 * -- cada UPSERT toma su propia conexión del pool -- así que lanzarlos en
 * paralelo es seguro (a diferencia de un `sql.Transaction` compartido, que
 * cuelga con dos pedidos en vuelo; ver el comentario en asiento.ts).
 */
export async function asociarCodigosProveedorEnLote(
  comprobanteId: number,
  codProvee: string,
  pares: { codArticu: string; codSinoni: string }[],
): Promise<number> {
  // Varios renglones de la factura (distintos talles, por ejemplo) suelen
  // apuntar al mismo artículo con el mismo código de proveedor -- se
  // dedupe para no pegarle a la misma fila de CPA15 más de una vez.
  const unicos = [...new Map(pares.map((p) => [`${p.codArticu}\u0000${p.codSinoni}`, p])).values()]
  if (unicos.length === 0) return 0

  await Promise.all(unicos.map((p) => asociarArticuloProveedor(codProvee, p.codArticu, p.codSinoni)))

  await conTransaccion((tx) =>
    auditarEn(
      tx,
      comprobanteId,
      `Códigos del proveedor vinculados en lote con Tango — ${unicos.length} artículo(s)`,
    ),
  )

  revalidatePath(`/comprobantes/${comprobanteId}`)
  return unicos.length
}

/**
 * El operador corrige a mano a qué código de Tango va un porcentaje de IVA
 * o una jurisdicción de IIBB que no se pudo resolver solo, y esa
 * corrección se aprende para este proveedor (`PHF_ALICUOTA_PROVEEDOR`): la
 * próxima factura con el mismo texto ya no va a necesitar la corrección de
 * nuevo. `descripcion` es el dato crudo tal como lo leyó la IA (el
 * porcentaje o la jurisdicción) -- `aprenderImpuesto` lo normaliza antes
 * de guardarlo.
 *
 * A propósito sin `revalidatePath`: se dispara en cada corrección, igual
 * que `guardarCampo`, y la celda ya refleja el código elegido con el
 * estado local del formulario -- forzar un refresh acá interrumpiría al
 * operador si está editando otro campo al mismo tiempo.
 */
/**
 * El operador marca o desmarca si un cargo de una liquidación suma al neto
 * gravado. Recalcula el neto con la suma nueva y, si el proveedor está
 * resuelto, aprende la decisión por rótulo: la próxima liquidación de esa
 * misma procesadora ya va a venir bien sin que toque nada.
 *
 * Con `revalidatePath`, a diferencia de `aprenderImpuestoTango`: acá el
 * cambio mueve el neto, que se muestra en el formulario y alimenta el
 * cotejo contra el IVA y el total. Dejar la pantalla con el neto viejo
 * después de destildar un cargo sería mostrar un número que ya no es.
 */
export async function marcarCargoGravado(
  comprobanteId: number,
  cargoId: number,
  gravado: boolean,
): Promise<void> {
  const pool = await getPool()

  const r = await pool
    .request()
    .input('id', sql.Int, cargoId)
    .input('comp', sql.Int, comprobanteId)
    .input('g', sql.Bit, gravado)
    .query<{ CONCEPTO: string | null }>(`
      UPDATE PHF_CARGO SET GRAVADO = @g
      OUTPUT INSERTED.CONCEPTO
      WHERE ID = @id AND COMPROBANTE_ID = @comp
    `)
  if (r.recordset.length === 0) return

  const neto = await recalcularNetoDeCargosEn(pool, comprobanteId)
  const concepto = r.recordset[0].CONCEPTO

  await conTransaccion((tx) =>
    auditarEn(
      tx,
      comprobanteId,
      `Cargo "${concepto ?? '(sin rótulo)'}" marcado como ${gravado ? 'gravado' : 'NO gravado'}` +
        (neto === null ? '' : ` — neto recalculado en ${neto.toFixed(2)}`),
    ),
  )

  const detalle = await obtenerDetalleEn(pool, comprobanteId)
  const codProvee = (detalle.campos.find((c) => c.clave === 'codprovee')?.valorFinal ?? '').trim()
  if (codProvee && concepto) {
    await aprenderImpuesto(codProvee, 'gravado', concepto, gravado ? 'S' : 'N')
  }

  revalidatePath(`/comprobantes/${comprobanteId}`)
}

/**
 * El operador corrige a mano el artículo de un renglón, porque el
 * emparejamiento automático contra el remito se equivocó.
 *
 * Se escribe en CODIGO_FINAL y NO se pisa CODIGO_IA: el mismo criterio que
 * VALOR_IA/VALOR_FINAL en PHF_CAMPO. Lo que resolvió el sistema queda
 * intacto, o se perdería la medición de qué tan bien empareja -- que es
 * justamente el dato que dice si hace falta mejorar el prompt.
 *
 * `null` borra la corrección y devuelve el renglón a lo automático.
 */
export async function elegirArticuloEn(
  e: Ejecutor,
  renglonId: number,
  codArticu: string | null,
): Promise<void> {
  const cod = codArticu?.trim() || null
  await e
    .request()
    .input('id', sql.Int, renglonId)
    .input('cod', sql.NVarChar(60), cod)
    .query('UPDATE PHF_RENGLON SET CODIGO_FINAL = @cod WHERE ID = @id')
}

export async function elegirArticulo(
  comprobanteId: number,
  renglonId: number,
  codArticu: string | null,
): Promise<void> {
  const pool = await getPool()
  await elegirArticuloEn(pool, renglonId, codArticu)

  await conTransaccion((tx) =>
    auditarEn(
      tx,
      comprobanteId,
      codArticu
        ? `Artículo corregido a mano en un renglón: ${codArticu}`
        : 'Corrección de artículo descartada en un renglón',
    ),
  )

  revalidatePath(`/comprobantes/${comprobanteId}`)
}
