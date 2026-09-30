import sql from 'mssql'
import { obtenerDetalleEn, auditarEn } from './detalle'
import { guardarReglaEn } from './lecturaProveedor'
import { deducirRegla } from '@/lib/lecturaProveedor'
import { ETIQUETA_ESCALA } from '@/lib/lecturaProveedor'
import { describirArticulos } from '@/server/tango/articulos'
import { normalizarCodigo } from '@/lib/cotejoOc'

type Ejecutor = { request(): sql.Request }

/**
 * Deduce de lo que se acaba de leer cómo arma este proveedor los códigos de
 * los artículos con escala, y lo guarda (2026-09-30, pedido del usuario).
 *
 * Corre al terminar de leer una factura de artículos, ya con el proveedor
 * resuelto. La señal que busca es una de dos: que algún renglón traiga el
 * desglose por talle, o que algún código impreso resulte ser un artículo
 * BASE del maestro -- que es exactamente lo que significa que al código le
 * falte el sufijo de color.
 *
 * No lanza: una regla que no se pudo aprender no puede tumbar la lectura de
 * un comprobante que salió bien. Es información que mejora la próxima
 * factura, no un requisito de ésta.
 */
export async function aprenderLecturaEn(
  e: Ejecutor,
  comprobanteId: number,
  codProvee: string | null,
): Promise<void> {
  const prov = (codProvee ?? '').trim()
  if (!prov) return

  try {
    const detalle = await obtenerDetalleEn(e, comprobanteId)
    const lineas = detalle.renglonesPdf.map((r) => ({
      codigo: r.codigo,
      descripcion: r.descripcion,
    }))
    if (lineas.length === 0) return

    // Qué papel juega en la escala cada código impreso. Se consulta el
    // maestro una sola vez con todos.
    const enMaestro = await describirArticulos(lineas.map((l) => l.codigo ?? ''))
    const bases = new Set<string>()
    const variantes = new Set<string>()
    for (const [clave, a] of enMaestro) {
      if (a.escala === 'base') bases.add(clave)
      else if (a.escala === 'variante') variantes.add(clave)
    }

    const regla = deducirRegla(lineas, { bases, variantes })
    if (!regla) return

    const guardada = await guardarReglaEn(e, prov, regla)
    // Solo se anota en el historial la primera vez que se ve: repetirlo en
    // cada factura del proveedor llenaría la auditoría de ruido.
    if (guardada && guardada.comprobantes === 1) {
      await auditarEn(
        e,
        comprobanteId,
        `Forma de leer aprendida para el proveedor ${prov}: ${ETIQUETA_ESCALA[regla]}`,
      )
    }
  } catch (err) {
    console.error(`aprenderLecturaEn[${comprobanteId}]: no se pudo aprender la regla:`, err)
  }
}

/** Los códigos impresos de un comprobante que son artículos BASE de Tango. */
export async function codigosBaseDe(codigos: (string | null)[]): Promise<Set<string>> {
  const enMaestro = await describirArticulos(codigos.map((c) => c ?? ''))
  return new Set(
    [...enMaestro.entries()]
      .filter(([, a]) => a.escala === 'base')
      .map(([clave]) => normalizarCodigo(clave)),
  )
}
