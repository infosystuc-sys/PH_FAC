'use server'

import sql from 'mssql'
import { revalidatePath } from 'next/cache'
import { getPool } from '../db/pool'
import { conTransaccion } from '../db/tx'
import { borrarPdf } from './archivos'
import { auditarEn, guardarCampoEn, obtenerDetalleEn } from './detalle'
import { despertarWorker, importarComprobanteEn, recalcularNetoDeCargosEn } from './cola'
import { usuarioActual } from '@/lib/usuario'
import { MOTIVOS_OBSERVACION } from '@/lib/observacion'
import { esTipoFactura } from '@/lib/tipoFactura'
import { buscarProveedoresPorRazonSocial, type Proveedor } from '@/server/tango/proveedores'
import { validarComprobante } from '@/server/app/validaciones'
import { registrarComprobante as registrarComprobanteTango } from '@/server/tango/comprobantes'
import {
  buscarArticulos,
  asociarArticuloProveedor,
  type ArticuloTango,
} from '@/server/tango/articulos'
import {
  listarConceptos,
  asignarConceptoProveedor,
  type ConceptoProveedor,
} from '@/server/tango/conceptos'
import { renglonesDelRemitoInterno } from '@/server/tango/remitos'
import { previsualizarAsiento, type AsientoPreview } from '@/server/tango/asiento'
import { previsualizarCuotas, type CuotasPreview } from '@/server/tango/cuotas'
import { aprenderImpuesto, type TipoAprendizaje } from './aprendizajeImpuestos'
import {
  leerConfiguracionCarpetasEn,
  guardarConfiguracionCarpetasEn,
  escanearCarpetasAhora,
  type ConfiguracionCarpetas,
} from './carpetas'

export type { AsientoPreview, LineaAsiento } from '@/server/tango/asiento'
export type { CuotasPreview, CuotaPreview } from '@/server/tango/cuotas'
export type { ConfiguracionCarpetas } from './carpetas'

type Ejecutor = { request(): sql.Request }

const MAX_BYTES = 10 * 1024 * 1024
const MAX_ARCHIVOS = 50

export async function importarComprobantes(fd: FormData): Promise<{ importados: number }> {
  const archivos = fd.getAll('archivos').filter((x): x is File => x instanceof File)
  if (archivos.length === 0) return { importados: 0 }
  if (archivos.length > MAX_ARCHIVOS) {
    throw new Error(`No se pueden importar más de ${MAX_ARCHIVOS} archivos por vez.`)
  }


  // Se valida todo el lote antes de tocar disco o base. Si se validara
  // adentro del loop de importación, un archivo invalido a mitad de lote
  // dejaria a los anteriores ya commiteados en 'procesando' sin que el
  // operador se entere: el mensaje de error no dice nada de ellos, la
  // bandeja no se refresca porque revalidatePath no llega a correr, y si
  // el operador reintenta todo el lote esos ya importados se duplican.
  for (const archivo of archivos) {
    if (archivo.type !== 'application/pdf') {
      throw new Error(`${archivo.name} no es un PDF.`)
    }
    if (archivo.size > MAX_BYTES) {
      throw new Error(`${archivo.name} supera los 10 MB.`)
    }
  }

  // Después de validar los archivos y antes de escribir nada: el tipo
  // decide con qué prompt lee la IA el lote entero, así que no se cae al
  // default en silencio -- un lote de resúmenes de tarjeta leído como
  // facturas de conceptos sale mal completo y el operador no tendría cómo
  // notarlo salvo revisando uno por uno. Va segundo porque un archivo
  // inválido es el error que el operador realmente encuentra (el tipo sale
  // de un selector que siempre trae valor), y decirle "elegí el tipo"
  // cuando lo que falla es un PDF lo manda a buscar donde no está.
  const tipoFactura = fd.get('tipoFactura')
  if (typeof tipoFactura !== 'string' || !esTipoFactura(tipoFactura)) {
    throw new Error('Elegí el tipo de comprobante antes de importar.')
  }

  let importados = 0
  for (const archivo of archivos) {
    const datos = Buffer.from(await archivo.arrayBuffer())
    await conTransaccion((tx) => importarComprobanteEn(tx, archivo.name, datos, tipoFactura))
    importados += 1
  }

  // La extraccion no espera al intervalo del worker.
  despertarWorker()
  revalidatePath('/comprobantes')
  return { importados }
}

export async function guardarCampo(id: number, clave: string, valor: string): Promise<void> {
  const pool = await getPool()
  await guardarCampoEn(pool, id, clave, valor.trim() === '' ? null : valor)
  // Mismo criterio que el MERGE de guardarCampoEn: si el comprobante ya
  // esta `registrado`, guardarCampoEn fue un no-op, y esta UPDATE no puede
  // dejar registrado que un usuario "modifico" algo que en los hechos no
  // cambio.
  await pool.request().input('id', sql.Int, id).input('u', sql.NVarChar(60), usuarioActual())
    .query(`
      UPDATE PHF_COMPROBANTE SET FECHA_MODIF = SYSDATETIME(), USUARIO_MODIF = @u
      WHERE ID = @id AND ESTADO <> 'registrado'
    `)

  // El tipo de factura vive en dos lados a propósito: el campo es lo que
  // ve y edita el operador, la columna es lo que lee la cola para elegir
  // el prompt. Si el operador reclasifica el comprobante y después lo
  // reprocesa, el reproceso tiene que leerlo con el prompt del tipo nuevo
  // -- sin este UPDATE volvería a usar el que se eligió al importar.
  if (clave === 'tipoFactura' && esTipoFactura(valor)) {
    await pool
      .request()
      .input('id', sql.Int, id)
      .input('tipo', sql.VarChar(20), valor)
      .query(`
        UPDATE PHF_COMPROBANTE SET TIPO_FACTURA = @tipo
        WHERE ID = @id AND ESTADO <> 'registrado'
      `)
  }
}

export async function confirmarComprobante(id: number): Promise<void> {
  const validaciones = await validarComprobante(id)
  if (validaciones.bloqueante) {
    throw new Error('Hay validaciones bloqueantes sin resolver.')
  }

  await conTransaccion(async (tx) => {
    // Solo desde `leido` u `observacion`. El WHERE es lo que evita que dos
    // pestañas abiertas confirmen dos veces o que se confirme algo ya
    // registrado, que es terminal.
    const r = await tx.request().input('id', sql.Int, id).query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO = 'confirmado', FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id AND ESTADO IN ('leido', 'observacion')
    `)
    if (r.rowsAffected[0] === 0) {
      throw new Error('El comprobante no está en un estado que permita confirmarlo.')
    }
    await auditarEn(tx, id, 'Datos confirmados por el operador')
  })

  revalidatePath('/comprobantes')
  revalidatePath(`/comprobantes/${id}`)
}

/**
 * Wrapper delgado sobre la unica funcion de escritura del ERP
 * (src/server/tango/comprobantes.ts). El estado y las validaciones
 * bloqueantes se vuelven a chequear server-side dentro de la propia
 * transaccion de `registrarComprobanteTango` -- este wrapper solo agrega el
 * chequeo de estado (que sea `confirmado`) antes de intentarlo, para dar un
 * mensaje mas claro que dejar que la transaccion falle mas adentro.
 */
export async function registrarComprobante(id: number): Promise<void> {
  const pool = await getPool()
  const fila = await pool.request().input('id', sql.Int, id).query(`SELECT ESTADO FROM PHF_COMPROBANTE WHERE ID=@id`)
  if (fila.recordset.length === 0) throw new Error('El comprobante no existe.')
  if (fila.recordset[0].ESTADO !== 'confirmado') {
    throw new Error('Solo se puede registrar un comprobante confirmado.')
  }

  await registrarComprobanteTango(id)

  revalidatePath('/comprobantes')
  revalidatePath(`/comprobantes/${id}`)
}

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
 * resolverProveedorEn en cola.ts.
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
}

export async function reprocesarComprobante(id: number): Promise<void> {
  await conTransaccion(async (tx) => {
    const r = await tx.request().input('id', sql.Int, id).query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO = 'procesando', INTENTOS = 0, ERROR_MENSAJE = NULL,
          FECHA_MODIF = NULL
      WHERE ID = @id AND ESTADO <> 'registrado'
    `)
    if (r.rowsAffected[0] === 0) {
      throw new Error('Un comprobante registrado en Tango no se puede reprocesar.')
    }
    await auditarEn(tx, id, 'Reproceso pedido por el operador')
  })

  despertarWorker()
  revalidatePath('/comprobantes')
  revalidatePath(`/comprobantes/${id}`)
}

/**
 * Separada en `_En`/wrapper (mismo patrón que `guardarCampoEn`/`guardarCampo`
 * en detalle.ts) para que los tests puedan ejercitarla dentro de la misma
 * transacción que insertó el comprobante de prueba: si el test insertara con
 * `tx` y esta función abriera su propia conexión de pool, el `UPDATE` (y el
 * `INSERT` en PHF_AUDITORIA, que tiene FK a PHF_COMPROBANTE) quedarían
 * esperando el lock de una transacción que no comitea hasta que el propio
 * test termina -- un deadlock por diseño del test, no una carrera real.
 */
export async function marcarObservacionEn(
  e: Ejecutor,
  id: number,
  motivo: string,
  nota: string,
): Promise<void> {
  if (!MOTIVOS_OBSERVACION.includes(motivo as (typeof MOTIVOS_OBSERVACION)[number])) {
    throw new Error('Motivo de observación inválido.')
  }

  const r = await e
    .request()
    .input('id', sql.Int, id)
    .input('motivo', sql.NVarChar(60), motivo)
    .input('nota', sql.NVarChar(1000), nota.trim() === '' ? null : nota.trim())
    .query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO = 'observacion', MOTIVO_OBSERVACION = @motivo, NOTA_OBSERVACION = @nota,
          FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id AND ESTADO IN ('leido', 'observacion')
    `)
  if (r.rowsAffected[0] === 0) {
    throw new Error('El comprobante no está en un estado que permita marcarlo en observación.')
  }
  await auditarEn(e, id, `En observación: ${motivo}`)
}

export async function marcarObservacion(id: number, motivo: string, nota: string): Promise<void> {
  await conTransaccion(async (tx) => {
    await marcarObservacionEn(tx, id, motivo, nota)
  })

  revalidatePath('/comprobantes')
  revalidatePath(`/comprobantes/${id}`)
}

/**
 * Datos que necesita la pantalla para preguntar antes de eliminar: sin el
 * estado no se puede advertir que el comprobante ya está en Tango.
 */
export type ComprobanteEliminado = {
  id: number
  estado: string
  /** El asiento que queda en Tango, si llegó a registrarse. */
  tangoNComp: string | null
}

/** Busca en el maestro de artículos de Tango, para corregir a mano. */
export async function buscarArticulosTango(
  texto: string,
  codProvee?: string | null,
): Promise<ArticuloTango[]> {
  return buscarArticulos(texto, codProvee)
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
      `Código del proveedor asociado en Tango: "${codSinoni}" = ${codArticu}`,
    ),
  )

  revalidatePath(`/comprobantes/${comprobanteId}`)
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
  const unicos = [...new Map(pares.map((p) => [`${p.codArticu} ${p.codSinoni}`, p])).values()]
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

export async function aprenderImpuestoTango(
  comprobanteId: number,
  codProvee: string,
  tipo: TipoAprendizaje,
  descripcion: string,
  codTango: string,
): Promise<void> {
  await aprenderImpuesto(codProvee, tipo, descripcion, codTango)

  const mensaje =
    tipo === 'iva'
      ? `Impuesto aprendido para el proveedor: IVA ${descripcion}% → código ${codTango}`
      : tipo === 'percepcion'
        ? `Impuesto aprendido para el proveedor: IIBB "${descripcion}" → código ${codTango}`
        : tipo === 'varios'
          ? `Impuesto aprendido para el proveedor: "${descripcion}" → código ${codTango}`
          : `Condición de compra aprendida para el proveedor: "${descripcion}" → código ${codTango}`
  await conTransaccion((tx) => auditarEn(tx, comprobanteId, mensaje))
}

/** Todo el maestro de conceptos, para que el operador elija uno a mano. */
export async function listarConceptosTango(): Promise<ConceptoProveedor[]> {
  return listarConceptos()
}

/**
 * El operador asocia a mano el concepto de un proveedor que no tenía
 * ninguno, para no tener que salir a Tango a cargarlo. Mismo criterio que
 * `asociarCodigoProveedor`: es una escritura sobre dato maestro del ERP, no
 * sobre el comprobante, así que va explícita y la decide el operador.
 *
 * No toca el estado del comprobante: si estaba en observación por falta de
 * concepto, sigue así hasta que el operador confirme -- mismo criterio que
 * `elegirProveedor`, que tampoco saca de observación por su cuenta.
 */
export async function asignarConcepto(
  comprobanteId: number,
  codProvee: string,
  codConcepto: string,
  descripcion: string,
): Promise<void> {
  await asignarConceptoProveedor(codProvee, codConcepto)

  await conTransaccion((tx) =>
    auditarEn(
      tx,
      comprobanteId,
      `Concepto asociado al proveedor en Tango: ${codConcepto} — ${descripcion}`,
    ),
  )

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

/**
 * Elimina un comprobante de la app. Definitivo: las FK de PHF_CAMPO,
 * PHF_RENGLON y PHF_AUDITORIA son ON DELETE CASCADE, así que la fila de
 * PHF_COMPROBANTE se lleva todo lo suyo, y después se borra el PDF del
 * disco.
 *
 * NO borra nada de Tango. Un comprobante ya registrado dejó su asiento en
 * CPA04 y en las tablas que cuelgan de ella, y eso queda tal cual: dar de
 * baja un comprobante de compras es una operación contable que se hace en
 * Tango, con su circuito y sus controles, no desde acá. Por eso la pantalla
 * advierte antes de eliminar uno registrado -- lo que desaparece es el
 * registro de trabajo de la app, no el asiento.
 *
 * El efecto práctico de eliminarlo es que deja de contar como duplicado
 * interno, así que el mismo PDF se puede volver a importar. Si además
 * estaba registrado, el chequeo de duplicados contra CPA04 lo va a seguir
 * encontrando -- y está bien que lo haga.
 */
export async function eliminarComprobanteEn(
  e: Ejecutor,
  id: number,
): Promise<ComprobanteEliminado & { archivoRuta: string }> {
  // El DELETE devuelve la fila borrada en vez de leerla antes: una sola ida
  // a la base, y el OUTPUT solo trae algo si realmente borró.
  const r = await e
    .request()
    .input('id', sql.Int, id)
    .query(`
      DELETE FROM PHF_COMPROBANTE
      OUTPUT DELETED.ID, DELETED.ESTADO, DELETED.ARCHIVO_RUTA, DELETED.TANGO_N_COMP
      WHERE ID = @id
    `)

  if (r.recordset.length === 0) {
    throw new Error('El comprobante no existe o ya fue eliminado.')
  }

  const fila = r.recordset[0]
  return {
    id: Number(fila.ID),
    estado: String(fila.ESTADO),
    tangoNComp: fila.TANGO_N_COMP === null ? null : String(fila.TANGO_N_COMP),
    archivoRuta: String(fila.ARCHIVO_RUTA),
  }
}

export async function eliminarComprobante(id: number): Promise<ComprobanteEliminado> {
  const eliminado = await conTransaccion((tx) => eliminarComprobanteEn(tx, id))

  // Después de commitear, no adentro de la transacción: borrar un archivo
  // no se deshace con un rollback, así que si la transacción fallara después
  // quedaría el comprobante en la base apuntando a un PDF que ya no está. Al
  // revés -- un archivo huérfano si esto falla -- es recuperable.
  await borrarPdf(eliminado.archivoRuta)

  revalidatePath('/comprobantes')
  revalidatePath(`/comprobantes/${id}`)

  return { id: eliminado.id, estado: eliminado.estado, tangoNComp: eliminado.tangoNComp }
}

/**
 * Selección múltiple desde la bandeja: elimina cada uno por separado
 * reusando `eliminarComprobante` sin cambios -- mismo PDF borrado, mismo
 * `revalidatePath`, mismas garantías -- en vez de reinventar el borrado en
 * lote a nivel SQL. Que uno falle (por ejemplo, otra pestaña ya lo borró)
 * no corta el resto: se cuenta como fallido y se sigue con el próximo.
 */
export async function eliminarComprobantesEnLote(
  ids: number[],
): Promise<{ eliminados: number; fallidos: number }> {
  let eliminados = 0
  let fallidos = 0
  for (const id of ids) {
    try {
      await eliminarComprobante(id)
      eliminados += 1
    } catch {
      fallidos += 1
    }
  }
  return { eliminados, fallidos }
}

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
 * `guardarRenglonesFacturadosEn` en cola.ts). Si alguien corrige el remito
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

/**
 * Vista previa de solo lectura del asiento contable. No escribe nada --
 * a diferencia del resto de las acciones de este archivo, no hace falta
 * revalidatePath ni entrada de auditoria.
 */
export async function verAsiento(comprobanteId: number): Promise<AsientoPreview> {
  return previsualizarAsiento(comprobanteId)
}

/**
 * Vista previa de solo lectura de las cuotas de la cuenta corriente
 * (CPA54) que se grabarian segun la condicion de compra. Mismo criterio
 * que verAsiento: no escribe nada.
 */
export async function verCuotas(comprobanteId: number): Promise<CuotasPreview> {
  return previsualizarCuotas(comprobanteId)
}

export async function leerConfiguracionCarpetas(): Promise<ConfiguracionCarpetas> {
  return leerConfiguracionCarpetasEn(await getPool())
}

export async function guardarConfiguracionCarpetas(
  carpetaRaiz: string | null,
  intervaloMinutos: number,
): Promise<void> {
  await guardarConfiguracionCarpetasEn(await getPool(), carpetaRaiz, intervaloMinutos)
  revalidatePath('/configuracion')
}

/** Botón "Escanear ahora": dispara el escaneo sin esperar al ciclo. No espera el resultado. */
export async function dispararEscaneoCarpetas(): Promise<void> {
  escanearCarpetasAhora()
}
