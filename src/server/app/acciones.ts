'use server'

import sql from 'mssql'
import { revalidatePath } from 'next/cache'
import { getPool } from '../db/pool'
import { conTransaccion } from '../db/tx'
import { borrarPdf, guardarPdf } from './archivos'
import { auditarEn, guardarCampoEn } from './detalle'
import { despertarWorker } from './cola'
import { usuarioActual } from '@/lib/usuario'
import { MOTIVOS_OBSERVACION } from '@/lib/observacion'
import {
  TIPOS_FACTURA,
  TIPO_FACTURA_DEFAULT,
  esTipoFactura,
  type TipoFactura,
} from '@/lib/tipoFactura'
import { buscarProveedoresPorRazonSocial, type Proveedor } from '@/server/tango/proveedores'
import { validarComprobante } from '@/server/app/validaciones'
import { registrarComprobante as registrarComprobanteTango } from '@/server/tango/comprobantes'
import {
  buscarArticulos,
  asociarArticuloProveedor,
  type ArticuloTango,
} from '@/server/tango/articulos'

type Ejecutor = { request(): sql.Request }

const MAX_BYTES = 10 * 1024 * 1024
const MAX_ARCHIVOS = 50

export async function importarComprobanteEn(
  e: Ejecutor,
  nombre: string,
  datos: Buffer,
  tipoFactura: TipoFactura = TIPO_FACTURA_DEFAULT,
): Promise<number> {
  const { ruta, hash } = await guardarPdf(nombre, datos)

  const r = await e
    .request()
    .input('nombre', sql.NVarChar(260), nombre.slice(0, 260))
    .input('ruta', sql.NVarChar(500), ruta)
    .input('hash', sql.Char(64), hash)
    .input('tipoFactura', sql.VarChar(20), tipoFactura)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      INSERT INTO PHF_COMPROBANTE
        (ARCHIVO_NOMBRE, ARCHIVO_RUTA, ARCHIVO_HASH, ESTADO, TIPO_FACTURA, USUARIO_ALTA)
      OUTPUT INSERTED.ID
      VALUES (@nombre, @ruta, @hash, 'procesando', @tipoFactura, @usuario)
    `)

  const id = Number(r.recordset[0].ID)
  const etiqueta = TIPOS_FACTURA.find((t) => t.clave === tipoFactura)?.label ?? tipoFactura
  await auditarEn(e, id, `PDF importado desde carga manual — ${etiqueta}`)
  return id
}

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
