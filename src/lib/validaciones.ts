import { totalImputado, parsearImporte } from './formato'
import { formatPorcentaje, type LineaAlicuota } from './alicuotas'
import type { LineaPercepcion, LineaVarios } from './percepciones'

export type ResultadoValidacion = {
  estado: 'ok' | 'advertencia' | 'error'
  mensaje: string
}

const LETRAS_VALIDAS = ['A', 'B', 'C', 'E', 'M', 'T']
const RE_LETRA = /\b([ABCEMT])\b/i

/**
 * El campo `tipo` lo devuelve la IA en texto libre ("FAC A", "FACTURA A
 * 0011-00063576", "C"...) porque el prompt no le fuerza un formato exacto.
 * Se busca una letra de comprobante valida como palabra suelta en vez de
 * asumir que siempre esta al final o al principio.
 */
export function letraComprobante(tipo: string): string | null {
  const m = RE_LETRA.exec(tipo.toUpperCase())
  return m && LETRAS_VALIDAS.includes(m[1]) ? m[1] : null
}

/**
 * Reconstruye el N_COMP tal como Tango lo guarda en CPA04: letra + punto
 * de venta a 5 digitos + numero a 8 digitos (verificado contra 5 años de
 * facturas reales de un mismo proveedor, ver plan Task 2). Si ptovta o
 * nro ya vienen mas largos que el padding no se truncan -- un dato mas
 * largo que lo esperado tiene que fallar el match, no esconderse.
 */
export function nComp(letra: string, ptovta: string, nro: string): string {
  return `${letra}${ptovta.padStart(5, '0')}${nro.padStart(8, '0')}`
}

export function validarProveedor(cantidadMatches: number): ResultadoValidacion {
  if (cantidadMatches === 1) return { estado: 'ok', mensaje: 'Proveedor resuelto.' }
  if (cantidadMatches === 0) {
    return { estado: 'error', mensaje: 'Sin coincidencia por CUIT. Elegí el proveedor manualmente.' }
  }
  return {
    estado: 'error',
    mensaje: `Hay ${cantidadMatches} proveedores con este CUIT. Elegí cuál corresponde.`,
  }
}

export function validarDuplicado(hayDuplicado: boolean, referencia: string | null): ResultadoValidacion {
  if (!hayDuplicado) return { estado: 'ok', mensaje: 'Sin duplicados.' }
  return {
    estado: 'error',
    mensaje: `Ya existe un comprobante igual: ${referencia ?? 'referencia no disponible'}.`,
  }
}

const TOLERANCIA_CENTAVOS = 0.01

export function validarTotales(valores: Record<string, string | null | undefined>): ResultadoValidacion {
  const imputado = totalImputado(valores)
  const total = parsearImporte(valores.total)
  const diferencia = Math.abs(imputado - total)
  if (diferencia <= TOLERANCIA_CENTAVOS) {
    return { estado: 'ok', mensaje: 'Los importes cierran contra el total.' }
  }
  const fmt = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return {
    estado: 'advertencia',
    mensaje: `La suma de los importes difiere en $ ${fmt.format(diferencia)} del total leído.`,
  }
}

const RE_CAE = /^\d{14}$/

export function parsearFechaArg(f: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(f.trim())
  if (!m) return null
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
  return Number.isNaN(d.getTime()) ? null : d
}

export function validarCae(
  cae: string | null | undefined,
  vtocae: string | null | undefined,
  hoy: Date,
): ResultadoValidacion {
  const c = (cae ?? '').trim()
  if (!RE_CAE.test(c)) {
    return { estado: 'advertencia', mensaje: 'CAE con formato inválido: debe tener 14 dígitos.' }
  }
  const vto = parsearFechaArg((vtocae ?? '').trim())
  if (vto && vto < new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())) {
    return { estado: 'advertencia', mensaje: `CAE vencido el ${vtocae}.` }
  }
  return { estado: 'ok', mensaje: 'CAE válido.' }
}

export function validarFormatoNComp(
  ptovta: string | null | undefined,
  nro: string | null | undefined,
): ResultadoValidacion {
  const pv = (ptovta ?? '').trim()
  const n = (nro ?? '').trim()

  if (!pv || !n) {
    return { estado: 'error', mensaje: 'Falta punto de venta o número de comprobante.' }
  }
  if (!/^\d+$/.test(pv) || !/^\d+$/.test(n)) {
    return { estado: 'error', mensaje: 'El punto de venta y el número tienen que ser numéricos.' }
  }
  if (pv.length > 5) {
    return { estado: 'error', mensaje: `El punto de venta tiene ${pv.length} dígitos, el máximo son 5.` }
  }
  if (n.length > 8) {
    return { estado: 'error', mensaje: `El número tiene ${n.length} dígitos, el máximo son 8.` }
  }
  return { estado: 'ok', mensaje: 'Formato de comprobante correcto.' }
}

export function validarCondCompra(condcompra: string | null | undefined): ResultadoValidacion {
  const v = (condcompra ?? '').trim()
  if (!v) {
    return { estado: 'error', mensaje: 'Elegí una condición de compra antes de registrar.' }
  }
  return { estado: 'ok', mensaje: 'Condición de compra elegida.' }
}

/**
 * Muestra, ya en la revisión, a qué alícuota de Tango va a ir cada par
 * porcivaN/impivaN -- antes se resolvía recién al apretar "Registrar en
 * Tango", así que un porcentaje que Tango no tiene se descubría en el
 * peor momento y sin señal previa en la pantalla.
 */
export function validarAlicuotas(lineas: LineaAlicuota[]): ResultadoValidacion {
  if (lineas.length === 0) {
    return { estado: 'ok', mensaje: 'No aplica.' }
  }

  const sinCodigo = lineas.filter((l) => l.estado === 'sin-codigo')
  if (sinCodigo.length > 0) {
    const detalle = sinCodigo
      .map((l) => `${formatPorcentaje(l.porcentaje)} (alícuota ${l.slot})`)
      .join(', ')
    return {
      estado: 'error',
      mensaje: `Tango no tiene una alícuota de IVA para ${detalle}. Corregí el porcentaje.`,
    }
  }

  const omitidas = lineas.filter((l) => l.estado === 'omitida')
  const registran = lineas.filter((l) => l.estado === 'registra')

  const partes = registran.map(
    (l) => `${formatPorcentaje(l.porcentaje)} → ${l.alicuota!.descripcion} (cód. ${l.alicuota!.codigo})`,
  )

  // Una alícuota 0% con importe no se registra, pero su importe sí cuenta
  // en el total imputado: si no se avisara, el operador vería un total que
  // cierra y un comprobante que en Tango entra por menos.
  if (omitidas.length > 0) {
    const cuales = omitidas.map((l) => `alícuota ${l.slot}`).join(', ')
    const aviso = `La ${cuales} es 0% y no se registra.`
    return {
      estado: 'advertencia',
      mensaje: partes.length > 0 ? `${aviso} Se registra: ${partes.join('; ')}.` : aviso,
    }
  }

  return { estado: 'ok', mensaje: `IVA: ${partes.join('; ')}.` }
}

export function validarTipoFactura(tipoFactura: string | null | undefined): ResultadoValidacion {
  const v = (tipoFactura ?? '').trim()
  if (!v) {
    return { estado: 'error', mensaje: 'Elegí el tipo de factura antes de registrar.' }
  }
  return { estado: 'ok', mensaje: 'Tipo de factura elegido.' }
}

/**
 * La percepción de IVA del 3% no pasa por acá: va en los slots de IVA,
 * resuelta siempre al código 15 (ver resolverCodigoIva). Acá quedan las
 * líneas de Ingresos Brutos, que se identifican por jurisdicción.
 */
export function validarPercepciones(lineas: LineaPercepcion[]): ResultadoValidacion {
  if (lineas.length === 0) return { estado: 'ok', mensaje: 'No aplica.' }

  // La jurisdiccion la escribe la IA leyendo el comprobante, y el prompt es
  // una instruccion, no una garantia. Una que no se reconoce no puede
  // llegar a CPA18: ahi se grabaria con un codigo vacio.
  const sinCodigo = lineas.filter((l) => l.estado === 'sin-codigo')
  if (sinCodigo.length > 0) {
    const detalle = sinCodigo
      .map((l) => (l.texto ? `"${l.texto}" (percepción ${l.slot})` : `percepción ${l.slot}`))
      .join(', ')
    return {
      estado: 'error',
      mensaje: `No se reconoce la jurisdicción de ${detalle}. Corregila para poder registrar.`,
    }
  }

  const partes = lineas.map((l) => `${l.codigo!.jurisdiccion} → ${l.codigo!.codigo}`)
  return { estado: 'ok', mensaje: `Percepciones IIBB: ${partes.join('; ')}.` }
}

export function validarVarios(lineas: LineaVarios[]): ResultadoValidacion {
  if (lineas.length === 0) return { estado: 'ok', mensaje: 'No aplica.' }

  const sinCodigo = lineas.filter((l) => l.estado === 'sin-codigo')
  if (sinCodigo.length > 0) {
    const detalle = sinCodigo.map((l) => `impuesto vario ${l.slot}`).join(', ')
    return {
      estado: 'error',
      mensaje: `Elegí el código de Tango de ${detalle} antes de registrar.`,
    }
  }

  const partes = lineas.map((l) => `${l.codigo} — ${l.descripcion}`)
  return { estado: 'ok', mensaje: `Impuestos varios: ${partes.join('; ')}.` }
}

