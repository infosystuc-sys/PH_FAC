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

const ETIQUETA_PERCEPCION: Record<'IIBB' | 'IVA3', string> = {
  IIBB: 'la percepción de IIBB',
  IVA3: 'la percepción de IVA del 3%',
}

export function validarPercepcionIva(
  clave: 'IIBB' | 'IVA3',
  importe: string | null | undefined,
  codigo: string | null | undefined,
): ResultadoValidacion {
  const imp = (importe ?? '').trim()
  if (!imp) {
    return { estado: 'ok', mensaje: 'No aplica.' }
  }
  const cod = (codigo ?? '').trim()
  if (!cod) {
    return {
      estado: 'error',
      mensaje: `Elegí el código de ${ETIQUETA_PERCEPCION[clave]} antes de registrar.`,
    }
  }
  return { estado: 'ok', mensaje: 'Código elegido.' }
}
