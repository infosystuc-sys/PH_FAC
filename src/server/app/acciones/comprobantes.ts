'use server'

// Server actions del ciclo de un comprobante: importar, editar, confirmar, registrar, observar, borrar, revalidar y las vistas previas.

import sql from 'mssql'
import { revalidatePath } from 'next/cache'
import { getPool } from '../../db/pool'
import { conTransaccion } from '../../db/tx'
import { borrarPdf } from '../archivos'
import { auditarEn, guardarCampoEn, obtenerDetalleEn } from '../detalle'
import { despertarWorker, importarComprobanteEn } from '../cola'
import {
  calcularFechaContableEn,
  resolverProveedorEn,
  resolverCondicionCompraEn,
  marcarExistenteEnTangoEn,
} from '../completarLectura'
import { aprenderLecturaEn } from '../aprenderLectura'
import { usuarioActual } from '@/lib/usuario'
import {
  MOTIVOS_OBSERVACION,
  MOTIVO_PROVEEDOR_INEXISTENTE,
  MOTIVO_SIN_CONCEPTO,
} from '@/lib/observacion'
import { esTipoFactura, vaContraOc } from '@/lib/tipoFactura'
import { campoPorClave } from '@/lib/campos'
import { validarComprobante } from '@/server/app/validaciones'
import { registrarComprobante as registrarComprobanteTango } from '@/server/tango/comprobantes'
import { tipoPorContenido, NOMBRES_ADMITIDOS } from '@/lib/tipoArchivo'
import { buscarConceptoProveedor } from '@/server/tango/conceptos'
import { recalcularAVincularEn, actualizarPendientesOcEn } from '../ordenCompra'
import { previsualizarAsiento, type AsientoPreview } from '@/server/tango/asiento'
import { previsualizarCuotas, type CuotasPreview } from '@/server/tango/cuotas'
import { actualizarCantidadesRemitoEn } from './remitos'

export type { AsientoPreview, LineaAsiento } from '@/server/tango/asiento'
export type { CuotasPreview, CuotaPreview } from '@/server/tango/cuotas'

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
  //
  // El tipo se decide por CONTENIDO (los primeros bytes), no por el MIME
  // que informa el navegador ni por la extension: ninguno de los dos es de
  // fiar, y el modelo rechaza un bloque `document` que no sea PDF de
  // verdad. Desde el 2026-09-16 se admiten tambien JPG y PNG (pedido del
  // usuario) -- ver src/lib/tipoArchivo.ts.
  const leidos: { archivo: File; datos: Buffer }[] = []
  for (const archivo of archivos) {
    if (archivo.size > MAX_BYTES) {
      throw new Error(`${archivo.name} supera los 10 MB.`)
    }
    const datos = Buffer.from(await archivo.arrayBuffer())
    if (tipoPorContenido(datos) === null) {
      throw new Error(`${archivo.name} no es un archivo ${NOMBRES_ADMITIDOS}.`)
    }
    leidos.push({ archivo, datos })
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
  for (const { archivo, datos } of leidos) {
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

  // El tope del catálogo, del lado del servidor: el input ya lo aplica, pero
  // el que manda es éste. Un campo más largo que su columna de Tango se
  // recortaría recién al grabar, dentro del ERP, donde el operador ya no lo
  // ve -- ver `maxLargo` en campos.ts.
  const max = campoPorClave(clave)?.maxLargo
  const recortado = max ? valor.slice(0, max) : valor

  await guardarCampoEn(pool, id, clave, recortado.trim() === '' ? null : recortado)
  // Mismo criterio que el MERGE de guardarCampoEn: si el comprobante ya
  // esta `registrado`, guardarCampoEn fue un no-op, y esta UPDATE no puede
  // dejar registrado que un usuario "modifico" algo que en los hechos no
  // cambio.
  await pool.request().input('id', sql.Int, id).input('u', sql.NVarChar(60), usuarioActual())
    .query(`
      UPDATE PHF_COMPROBANTE SET FECHA_MODIF = SYSDATETIME(), USUARIO_MODIF = @u
      WHERE ID = @id AND ESTADO <> 'registrado'
    `)

  // La fecha contable se deriva de la de emisión y del cierre de Tango, así
  // que corregir una obliga a recalcular la otra. Se hace acá, del lado del
  // servidor, porque el cierre vive en CPA10 y el formulario no lo conoce;
  // `revalidatePath` es lo que hace que la pantalla muestre la nueva sin que
  // el operador recargue.
  if (clave === 'fecha') {
    await conTransaccion((tx) => calcularFechaContableEn(tx, id, valor))
    revalidatePath(`/comprobantes/${id}`)
  }

  // El concepto elegido para este comprobante gana sobre la ficha del
  // proveedor sin tocarla (2026-09-17). Queda en el historial porque es una
  // decision que no se ve en Tango --la ficha sigue igual-- y el panel y la
  // vista previa del asiento lo resuelven en el servidor, asi que hay que
  // revalidar para que muestren el nuevo.
  if (clave === 'concepto') {
    const elegido = valor.trim()
    await conTransaccion((tx) =>
      auditarEn(
        tx,
        id,
        elegido
          ? `Concepto elegido solo para este comprobante: ${elegido} (la ficha del proveedor no cambia)`
          : 'Concepto: vuelve a valer el de la ficha del proveedor',
      ),
    )
    revalidatePath(`/comprobantes/${id}`)
  }

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

/** Lo que cambió al revalidar, para el aviso y el historial. */
export type ResultadoRevalidacion = { cambios: string[] }

/**
 * Vuelve a correr contra Tango todo lo que la lectura resolvió con datos del
 * ERP, SIN volver a leer el PDF con la IA (2026-10-30, pedido del usuario).
 * Es para cuando la revisión marcó algo que se arregla en Tango --el
 * proveedor no existía, el artículo no estaba, la OC no tenía pendiente, el
 * proveedor no tenía concepto--: una vez corregido allá, el operador
 * revalida acá y no pierde lo que ya corrigió a mano, que es lo que pasa con
 * "Reprocesar" (borra PHF_CAMPO y lee de nuevo).
 *
 * Las validaciones de la pantalla ya se calculan en vivo al cargarla (ver
 * page.tsx). Lo que hace falta rehacer es lo que la lectura dejó GUARDADO:
 *
 *   - el proveedor por CUIT, solo si no hay ninguno (uno elegido o resuelto
 *     no se pisa);
 *   - la condición de compra aprendida, solo si está vacía;
 *   - la forma de leer del proveedor y el contador de renglones a vincular;
 *   - las fotos de Tango: lo pendiente de cada renglón de OC y lo entregado
 *     de cada remito;
 *   - las observaciones que puso la app por un dato que faltaba en Tango, que
 *     se levantan si el dato ya está;
 *   - si mientras tanto el comprobante se cargó en Tango, pasa a existente.
 *
 * El CUIT es el del formulario (`valorFinal`), así que también sirve después
 * de que el operador corrigió un CUIT mal leído.
 */
export async function revalidarContraTangoEn(e: Ejecutor, id: number): Promise<ResultadoRevalidacion> {
  const fila = await e
    .request()
    .input('id', sql.Int, id)
    .query(`SELECT ESTADO, MOTIVO_OBSERVACION, RENGLONES_A_VINCULAR FROM PHF_COMPROBANTE WHERE ID = @id`)
  if (fila.recordset.length === 0) throw new Error('El comprobante no existe.')
  const { ESTADO: estado, MOTIVO_OBSERVACION: motivo } = fila.recordset[0] as {
    ESTADO: string
    MOTIVO_OBSERVACION: string | null
  }
  const aVincularAntes = Number(fila.recordset[0].RENGLONES_A_VINCULAR ?? 0)
  if (estado === 'registrado' || estado === 'existente') {
    throw new Error('El comprobante ya está en Tango: no hay nada que revalidar.')
  }
  if (estado === 'procesando' || estado === 'error') {
    throw new Error('El comprobante no tiene una lectura terminada. Usá "Reprocesar".')
  }

  const detalle = await obtenerDetalleEn(e, id)
  const valores: Record<string, string | null> = Object.fromEntries(
    detalle.campos.map((c) => [c.clave, c.valorFinal]),
  )
  const tipo = valores.tipoFactura ?? null
  const cambios: string[] = []

  let cod = (valores.codprovee ?? '').trim() || null
  if (!cod) {
    cod = await resolverProveedorEn(e, id, valores.cuit ?? null)
    if (cod) cambios.push(`proveedor resuelto por CUIT (${cod})`)
  }
  await resolverCondicionCompraEn(e, id, cod, valores.condpago ?? null)

  if (vaContraOc(tipo)) {
    await aprenderLecturaEn(e, id, cod)
    const aVincular = await recalcularAVincularEn(e, id, cod)
    if (aVincular !== aVincularAntes) {
      cambios.push(`renglones a vincular: ${aVincularAntes} → ${aVincular}`)
    }
  }

  const pendientes = await actualizarPendientesOcEn(e, id)
  if (pendientes > 0) cambios.push(`pendiente de OC actualizado en ${pendientes} renglón(es)`)
  const remitos = await actualizarCantidadesRemitoEn(e, id)
  if (remitos > 0) cambios.push(`cantidad de remito actualizada en ${remitos} renglón(es)`)

  // Solo las observaciones por un dato que faltaba en Tango y que ahora
  // está. Las demás las puso el operador por algo que ve en el papel, y no
  // es la app la que puede decir que se resolvieron.
  if (estado === 'observacion') {
    const resuelta =
      (motivo === MOTIVO_PROVEEDOR_INEXISTENTE && cod !== null) ||
      (motivo === MOTIVO_SIN_CONCEPTO && cod !== null && (await buscarConceptoProveedor(cod)) !== null)
    if (resuelta) {
      await e.request().input('id', sql.Int, id).query(`
        UPDATE PHF_COMPROBANTE
        SET ESTADO = 'leido', MOTIVO_OBSERVACION = NULL, NOTA_OBSERVACION = NULL,
            FECHA_MODIF = SYSDATETIME()
        WHERE ID = @id
      `)
      cambios.push(`sale de observación (${motivo})`)
    }
  }

  if (await marcarExistenteEnTangoEn(e, id, cod, valores)) {
    cambios.push('ya está cargado en Tango: pasa a existente')
  }

  await auditarEn(
    e,
    id,
    cambios.length > 0
      ? `Revalidado contra Tango, sin IA — ${cambios.join('; ')}`
      : 'Revalidado contra Tango, sin IA — sin cambios',
  )
  return { cambios }
}

export async function revalidarContraTango(id: number): Promise<ResultadoRevalidacion> {
  const r = await conTransaccion((tx) => revalidarContraTangoEn(tx, id))
  revalidatePath('/comprobantes')
  revalidatePath(`/comprobantes/${id}`)
  return r
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
