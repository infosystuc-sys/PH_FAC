import sql from 'mssql'
import { getPool } from '../db/pool'
import { obtenerDetalleEn } from './detalle'
import { buscarProveedoresPorCuit, type Proveedor } from '@/server/tango/proveedores'
import { buscarFacturaEnCpa04 } from '@/server/tango/comprobantes'
import {
  letraComprobante,
  nComp as armarNComp,
  validarProveedor,
  validarDuplicado,
  validarTotales,
  validarCae,
  type ResultadoValidacion,
} from '@/lib/validaciones'

type Ejecutor = { request(): sql.Request }

export type Validaciones = {
  proveedor: ResultadoValidacion
  duplicado: ResultadoValidacion
  totales: ResultadoValidacion
  cae: ResultadoValidacion
  candidatosProveedor: Proveedor[]
  bloqueante: boolean
}

export async function validarComprobanteEn(e: Ejecutor, id: number): Promise<Validaciones> {
  const detalle = await obtenerDetalleEn(e, id)
  const valores: Record<string, string | null> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const cuit = valores.cuit ?? ''
  const candidatosProveedor = cuit ? await buscarProveedoresPorCuit(cuit) : []
  const proveedor = validarProveedor(candidatosProveedor.length)

  let hayDuplicado = false
  let referenciaDuplicado: string | null = null

  if (candidatosProveedor.length === 1) {
    const codProvee = candidatosProveedor[0].codProvee
    const letra = letraComprobante(valores.tipo ?? '')
    const ptovta = valores.ptovta ?? ''
    const nro = valores.nro ?? ''

    if (letra && ptovta && nro) {
      const candidato = armarNComp(letra, ptovta, nro)

      const enTango = await buscarFacturaEnCpa04(codProvee, candidato)
      if (enTango) {
        hayDuplicado = true
        referenciaDuplicado = `factura ${enTango.nComp} ya registrada en Tango`
      } else {
        const enApp = await e
          .request()
          .input('id', sql.Int, id)
          .input('cp', sql.VarChar(20), codProvee)
          .input('tipo', sql.VarChar(10), valores.tipo?.slice(0, 10) ?? null)
          .input('pv', sql.VarChar(10), ptovta)
          .input('nro', sql.VarChar(20), nro)
          .query(`
            SELECT TOP 1 ID FROM PHF_COMPROBANTE
            WHERE ID <> @id AND COD_PROVEE = @cp AND TIPO = @tipo
              AND PUNTO_VENTA = @pv AND NUMERO = @nro
          `)
        if (enApp.recordset.length > 0) {
          hayDuplicado = true
          referenciaDuplicado = `comprobante interno ${enApp.recordset[0].ID}`
        }
      }
    }
  }

  const duplicado = validarDuplicado(hayDuplicado, referenciaDuplicado)
  const totales = validarTotales(valores)
  const cae = validarCae(valores.cae, valores.vtocae, new Date())

  return {
    proveedor,
    duplicado,
    totales,
    cae,
    candidatosProveedor,
    bloqueante: proveedor.estado === 'error' || duplicado.estado === 'error',
  }
}

export async function validarComprobante(id: number): Promise<Validaciones> {
  return validarComprobanteEn(await getPool(), id)
}
