import sql from 'mssql'
import { getPool } from '../db/pool'
import { obtenerDetalleEn, type Detalle } from './detalle'
import { buscarProveedoresPorCuit, type Proveedor } from '@/server/tango/proveedores'
import { buscarFacturaEnCpa04 } from '@/server/tango/comprobantes'
import {
  letraComprobante,
  nComp as armarNComp,
  validarProveedor,
  validarDuplicado,
  validarTotales,
  validarCae,
  validarFormatoNComp,
  validarCondCompra,
  validarPercepcionIva,
  validarTipoFactura,
  type ResultadoValidacion,
} from '@/lib/validaciones'
import { buscarConceptoProveedor } from '@/server/tango/conceptos'

type Ejecutor = { request(): sql.Request }

export type Validaciones = {
  proveedor: ResultadoValidacion
  duplicado: ResultadoValidacion
  totales: ResultadoValidacion
  cae: ResultadoValidacion
  candidatosProveedor: Proveedor[]
  bloqueante: boolean
}

/**
 * `detallePrevio` evita un segundo round-trip a PHF_CAMPO/PHF_RENGLON/
 * PHF_AUDITORIA cuando quien llama (la pantalla de revisión) ya lo leyó
 * para renderizar el formulario. Si no se pasa, se lee acá como antes --
 * `confirmarComprobante`, por ejemplo, no tiene un detalle a mano.
 */
export async function validarComprobanteEn(
  e: Ejecutor,
  id: number,
  detallePrevio?: Detalle,
): Promise<Validaciones> {
  const detalle = detallePrevio ?? (await obtenerDetalleEn(e, id))
  const valores: Record<string, string | null> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const cuit = valores.cuit ?? ''
  const candidatosProveedor = cuit ? await buscarProveedoresPorCuit(cuit) : []

  // `codprovee` gana sobre el CUIT: lo escribe `elegirProveedorEn` cuando el
  // operador resuelve a mano un CUIT sin match o con 2+ matches, y tambien
  // `resolverProveedorEn` cuando el CUIT matchea a uno solo. Si se siguiera
  // revalidando solo contra `candidatosProveedor.length`, un CUIT duplicado
  // (2+ matches) quedaria bloqueante para siempre aunque el operador ya
  // hubiera elegido: `validarProveedor` volveria a contar los mismos 2+
  // matches del CUIT en vez de mirar la eleccion ya hecha.
  const codProveeElegido = valores.codprovee?.trim() || null
  const proveedor = codProveeElegido ? validarProveedor(1) : validarProveedor(candidatosProveedor.length)

  // Codigo de proveedor a usar para el chequeo de duplicados: el elegido a
  // mano si existe, si no el unico candidato por CUIT (si hay exactamente
  // uno). Con 0 o 2+ candidatos y sin eleccion manual no hay con que
  // consultar CPA04 -- el chequeo no corre, y eso se refleja como
  // "advertencia", no como un falso "ok".
  const codProveeParaDuplicado =
    codProveeElegido ?? (candidatosProveedor.length === 1 ? candidatosProveedor[0].codProvee : null)

  let hayDuplicado = false
  let referenciaDuplicado: string | null = null
  let duplicadoNoVerificado: string | null = null

  if (codProveeParaDuplicado) {
    const letra = letraComprobante(valores.tipo ?? '')
    const ptovta = valores.ptovta ?? ''
    const nro = valores.nro ?? ''

    if (letra && ptovta && nro) {
      const candidato = armarNComp(letra, ptovta, nro)

      const enTango = await buscarFacturaEnCpa04(codProveeParaDuplicado, candidato)
      if (enTango) {
        hayDuplicado = true
        referenciaDuplicado = `factura ${enTango.nComp} ya registrada en Tango`
      } else {
        const enApp = await e
          .request()
          .input('id', sql.Int, id)
          .input('cp', sql.VarChar(20), codProveeParaDuplicado)
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
    } else {
      duplicadoNoVerificado = 'No se pudo verificar duplicados: falta tipo, punto de venta o número.'
    }
  } else {
    duplicadoNoVerificado = 'No se pudo verificar duplicados: falta resolver el proveedor.'
  }

  const duplicado: ResultadoValidacion = duplicadoNoVerificado
    ? { estado: 'advertencia', mensaje: duplicadoNoVerificado }
    : validarDuplicado(hayDuplicado, referenciaDuplicado)
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

export async function validarComprobante(id: number, detallePrevio?: Detalle): Promise<Validaciones> {
  return validarComprobanteEn(await getPool(), id, detallePrevio)
}

export type ResultadoListoParaRegistrar = {
  condCompra: ResultadoValidacion
  percepcionIibb: ResultadoValidacion
  percepcionIva3: ResultadoValidacion
  formatoComp: ResultadoValidacion
  tipoFactura: ResultadoValidacion
  concepto: ResultadoValidacion
  bloqueante: boolean
}

/**
 * Gate de la transicion confirmado -> registrado, distinto del de Fase 3
 * (leido/observacion -> confirmado). Las 4 validaciones de Fase 3 ya
 * bloquearon esa primera transicion y se vuelven a chequear server-side
 * dentro de la propia transaccion de registro -- no se repiten aca.
 */
export async function validarListoParaRegistrarEn(
  e: Ejecutor,
  id: number,
  detallePrevio?: Detalle,
): Promise<ResultadoListoParaRegistrar> {
  const detalle = detallePrevio ?? (await obtenerDetalleEn(e, id))
  const valores: Record<string, string | null | undefined> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const condCompra = validarCondCompra(valores.condcompra)
  const percepcionIibb = validarPercepcionIva('IIBB', valores.perciibb, valores.codpercibb)
  // El 3% no vive en un slot fijo: verificado en vivo contra un comprobante
  // real (AMX ARGENTINA, factura 1340-00147868) que lo trae en porciva3/
  // impiva3, no en el slot 2 que asumia una version anterior de este
  // codigo. Se escanean los 5 slots y se usa el importe del que tenga
  // porcentaje 3 -- si ninguno lo tiene, no aplica (ok, no bloqueante).
  const slotIva3 = [1, 2, 3, 4, 5].find((i) => Number(valores[`porciva${i}`]) === 3)
  const importeIva3 = slotIva3 ? valores[`impiva${slotIva3}`] : null
  const percepcionIva3 = validarPercepcionIva('IVA3', importeIva3, valores.codpercepiva)
  const formatoComp = validarFormatoNComp(valores.ptovta, valores.nro)
  const tipoFactura = validarTipoFactura(valores.tipoFactura)

  // El concepto solo aplica si se eligio "por conceptos" -- igual criterio
  // que percepcionIva3 cuando no hay slot al 3%: 'ok'/"No aplica." en vez de
  // forzar un chequeo que no corresponde.
  let concepto: ResultadoValidacion = { estado: 'ok', mensaje: 'No aplica.' }
  if (valores.tipoFactura === 'conceptos') {
    const codProvee = (valores.codprovee ?? '').trim()
    const encontrado = codProvee ? await buscarConceptoProveedor(codProvee) : null
    concepto = encontrado
      ? { estado: 'ok', mensaje: `Concepto: ${encontrado.codConcepto} — ${encontrado.descripcion}.` }
      : { estado: 'error', mensaje: 'Este proveedor no tiene un concepto configurado en Tango.' }
  }

  const bloqueante = [condCompra, percepcionIibb, percepcionIva3, formatoComp, tipoFactura, concepto].some(
    (v) => v.estado === 'error',
  )

  return { condCompra, percepcionIibb, percepcionIva3, formatoComp, tipoFactura, concepto, bloqueante }
}

export async function validarListoParaRegistrar(
  id: number,
  detallePrevio?: Detalle,
): Promise<ResultadoListoParaRegistrar> {
  return validarListoParaRegistrarEn(await getPool(), id, detallePrevio)
}
