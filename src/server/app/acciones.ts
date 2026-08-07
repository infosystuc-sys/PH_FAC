'use server'

import sql from 'mssql'
import { revalidatePath } from 'next/cache'
import { getPool } from '../db/pool'
import { conTransaccion } from '../db/tx'
import { guardarPdf } from './archivos'
import { auditarEn, guardarCampoEn } from './detalle'
import { despertarWorker } from './cola'
import { usuarioActual } from '@/lib/usuario'

type Ejecutor = { request(): sql.Request }

const MAX_BYTES = 10 * 1024 * 1024
const MAX_ARCHIVOS = 50

export async function importarComprobanteEn(
  e: Ejecutor,
  nombre: string,
  datos: Buffer,
): Promise<number> {
  const { ruta, hash } = await guardarPdf(nombre, datos)

  const r = await e
    .request()
    .input('nombre', sql.NVarChar(260), nombre.slice(0, 260))
    .input('ruta', sql.NVarChar(500), ruta)
    .input('hash', sql.Char(64), hash)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      INSERT INTO PHF_COMPROBANTE
        (ARCHIVO_NOMBRE, ARCHIVO_RUTA, ARCHIVO_HASH, ESTADO, USUARIO_ALTA)
      OUTPUT INSERTED.ID
      VALUES (@nombre, @ruta, @hash, 'procesando', @usuario)
    `)

  const id = Number(r.recordset[0].ID)
  await auditarEn(e, id, 'PDF importado desde carga manual')
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

  let importados = 0
  for (const archivo of archivos) {
    const datos = Buffer.from(await archivo.arrayBuffer())
    await conTransaccion((tx) => importarComprobanteEn(tx, archivo.name, datos))
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
}

export async function confirmarComprobante(id: number): Promise<void> {
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
