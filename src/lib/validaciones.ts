import { totalImputado, parsearImporte } from './formato'

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

function parsearFechaArg(f: string): Date | null {
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
