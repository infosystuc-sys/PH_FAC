import sql from 'mssql'
import { extraerDnrpa } from '@/server/ia/dnrpa'
import { filasDeSeriesEn, grabarDnrpaEn } from '@/server/tango/dnrpa'
import {
  clasificarDnrpa,
  deduplicarDnrpa,
  normalizarChasis,
  normalizarDnrpa,
  type EstadoDnrpa,
} from '@/lib/dnrpa'
import { tipoPorContenido, NOMBRES_ADMITIDOS } from '@/lib/tipoArchivo'

/**
 * Importar el DNRPA desde el mail del proveedor (2026-11-18, pedido del
 * usuario). Dos pasos, sin nada guardado entre uno y otro:
 *
 * 1. `vistaPreviaDnrpaEn`: la IA lee la tabla del archivo (PDF o imagen) y
 *    cada fila se clasifica contra las series de Tango. No escribe.
 * 2. `aplicarDnrpaEn`: con el OK del operador, graba las que quedaron en
 *    "se carga", releyendo y reclasificando dentro de la transacción.
 */

type Ejecutor = { request(): sql.Request }

export type FilaVistaDnrpa = {
  modelo: string
  motor: string
  chasis: string
  dnrpa: string
  estado: EstadoDnrpa
  codArticu: string | null
  comentarioActual: string | null
  /** Filas de STA06 + STA07 que se actualizarían. */
  filas: number
}

export type VistaPreviaDnrpa = { archivo: string; filas: FilaVistaDnrpa[] }

const MAX_BYTES = 10 * 1024 * 1024

export async function vistaPreviaDnrpaEn(e: Ejecutor, archivo: string, datos: Buffer): Promise<VistaPreviaDnrpa> {
  if (datos.length === 0) throw new Error('El archivo está vacío.')
  if (datos.length > MAX_BYTES) throw new Error('El archivo pasa de 10 MB.')
  if (!tipoPorContenido(datos)) throw new Error(`El archivo tiene que ser ${NOMBRES_ADMITIDOS}.`)

  const lectura = await extraerDnrpa(datos)
  if (!lectura.ok) throw new Error(`No se pudo leer el archivo: ${lectura.error}`)
  if (lectura.filas.length === 0) throw new Error('No se encontró ninguna fila con chasis y DNRPA en el archivo.')

  const leidas = lectura.filas.map((f) => ({ ...f, chasis: normalizarChasis(f.chasis), dnrpa: normalizarDnrpa(f.dnrpa) }))
  const unicas = deduplicarDnrpa(leidas)
  const tango = await filasDeSeriesEn(e, unicas.map((u) => u.fila.chasis))

  return {
    archivo,
    filas: unicas.map(({ fila, repetidaConOtro }) => {
      const c = clasificarDnrpa(fila.chasis, fila.dnrpa, tango.get(fila.chasis) ?? [])
      return {
        ...fila,
        estado: repetidaConOtro && c.estado !== 'invalida' ? 'repetida' : c.estado,
        codArticu: c.codArticu,
        comentarioActual: c.comentarioActual,
        filas: repetidaConOtro ? 0 : c.filas,
      }
    }),
  }
}

export type ResumenDnrpa = {
  cargadas: number
  filasSta06: number
  filasSta07: number
  /** Las que en la vista previa iban y al grabar ya no (alguien las tocó en el medio). */
  cambiaron: { chasis: string; estado: EstadoDnrpa }[]
}

/** Graba las filas que el operador confirmó. Solo las que siguen en "se carga". */
export async function aplicarDnrpaEn(
  tx: sql.Transaction,
  filas: { chasis: string; dnrpa: string }[],
): Promise<ResumenDnrpa> {
  const items = deduplicarDnrpa(
    filas.map((f) => ({ chasis: normalizarChasis(f.chasis), dnrpa: normalizarDnrpa(f.dnrpa) })),
  )
    .filter((x) => !x.repetidaConOtro)
    .map((x) => x.fila)
  if (items.length === 0) throw new Error('No hay ninguna serie para cargar.')

  const r = await grabarDnrpaEn(tx, items)
  const cargadas = r.filter((x) => x.sta06 + x.sta07 > 0)
  return {
    cargadas: cargadas.length,
    filasSta06: r.reduce((t, x) => t + x.sta06, 0),
    filasSta07: r.reduce((t, x) => t + x.sta07, 0),
    cambiaron: r
      .filter((x) => x.clasificacion.estado !== 'cargar')
      .map((x) => ({ chasis: x.chasis, estado: x.clasificacion.estado })),
  }
}
