import { totalImputado, parsearImporte } from './formato'
import { formatPorcentaje, esIvaSobreLaBase, type LineaAlicuota } from './alicuotas'
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

/**
 * En una liquidación de tarjeta el "total" impreso en el resumen sale por
 * diferencia -- arrastra saldo anterior, pagos y otros movimientos que la
 * app no captura -- así que no sirve como total del comprobante. Se
 * registra siempre el subtotal (el monto del concepto) más IVA más
 * impuestos, calculado por `totalImputado`. Esta validación nunca compara
 * contra `valores.total` en tarjeta: lo dice en vez de advertir sobre una
 * diferencia esperada. Mismo criterio y misma función usa
 * `registrarComprobanteEn` (`src/server/tango/comprobantes.ts`) y
 * `previsualizarAsientoEn` (`src/server/tango/asiento.ts`) para el importe
 * que de verdad se graba, así que este mensaje nunca puede divergir de lo
 * que termina en Tango.
 */
export function validarTotales(
  valores: Record<string, string | null | undefined>,
  tipoFactura?: string | null,
): ResultadoValidacion {
  const imputado = totalImputado(valores)
  const fmt = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  if (tipoFactura === 'tarjeta') {
    return {
      estado: 'ok',
      mensaje:
        `Total del comprobante: $ ${fmt.format(imputado)} (subtotal + IVA + impuestos -- ` +
        `no el importe leído del resumen, que sale por diferencia).`,
    }
  }

  const total = parsearImporte(valores.total)
  const diferencia = Math.abs(imputado - total)
  if (diferencia <= TOLERANCIA_CENTAVOS) {
    return { estado: 'ok', mensaje: 'Los importes cierran contra el total.' }
  }
  return {
    estado: 'advertencia',
    mensaje: `La suma de los importes difiere en $ ${fmt.format(diferencia)} del total leído.`,
  }
}

/**
 * Cuanto puede diferir el neto declarado del que implica el IVA impreso
 * antes de considerarlo un error. Es relativa y no de centavos a proposito:
 * las liquidaciones reales calculan el IVA por transaccion y despues suman,
 * asi que el redondeo se acumula -- en el resumen de Banco Macro el IVA
 * impreso difiere 13 centavos del 21% exacto del neto impreso, sobre
 * $182.759, y esta bien. Un componente faltante, que es lo que esta
 * validacion busca, nunca es el 0,5%: en el caso real que la motivo era el
 * 50% del neto.
 */
const TOLERANCIA_NETO_IVA = 0.005
const TOLERANCIA_NETO_IVA_MINIMA = 1

/**
 * Coteja el neto gravado contra el que implica el IVA impreso: si una
 * factura declara $914,74 de IVA al 21%, su base tiene que ser $4.355,90.
 *
 * Existe por un problema real de las liquidaciones de tarjeta: ahi el neto
 * gravado no viene impreso en ningun renglon, es la SUMA de varios cargos
 * (arancel, comision, costo financiero, cargo de transferencia...) que cada
 * procesadora rotula distinto, y encima todas traen alguna linea que parece
 * la respuesta y no lo es -- el resumen de Tarjeta Sol tiene un renglon
 * literalmente llamado "Importe neto" que es lo acreditado, no la base.
 * Leyendo el mismo PDF dos veces, la IA devolvio dos bases distintas
 * (4.355,94 y 2.177,97, o sea un componente de menos) y en la equivocada
 * subio la confianza de 0,55 a 0,88: la confianza no sirve como alarma.
 *
 * El IVA si es un dato firme -- viene impreso, rotulado y sin ambiguedad --
 * asi que sirve de verificador independiente del dato que no lo es.
 */
export function validarNetoContraIva(
  lineas: LineaAlicuota[],
  netoDeclarado: string | null | undefined,
  tipoFactura?: string | null,
): ResultadoValidacion {
  let baseSegunIva = 0
  let cuantas = 0
  for (const l of lineas) {
    // Solo el IVA que grava la base. Una percepcion o una retencion viven
    // en estos mismos slots (ver esIvaSobreLaBase) y su importe dividido por
    // su porcentaje no es base gravada: sumarlas inventaria neto. Es lo que
    // le permite al operador destrabar el caso real que motivo esto --
    // corrige a mano el codigo de la linea mal leida y el cotejo cierra.
    if (!esIvaSobreLaBase(l.alicuota)) continue
    // El 0% no dice nada de la base, y ademas dividiria por cero.
    if (l.porcentaje <= 0 || l.importe <= 0) continue
    baseSegunIva += l.importe / (l.porcentaje / 100)
    cuantas += 1
  }

  if (cuantas === 0) {
    return { estado: 'ok', mensaje: 'Sin líneas de IVA para cotejar contra el neto.' }
  }

  const fmt = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const neto = parsearImporte(netoDeclarado)
  const esperado = Math.round(baseSegunIva * 100) / 100
  const diferencia = Math.abs(esperado - neto)
  const tolerancia = Math.max(TOLERANCIA_NETO_IVA_MINIMA, esperado * TOLERANCIA_NETO_IVA)

  if (diferencia <= tolerancia) {
    return { estado: 'ok', mensaje: `El neto cierra con el IVA declarado ($ ${fmt.format(esperado)}).` }
  }

  return {
    // Bloqueante solo en tarjeta, que es donde el neto no viene impreso y
    // hay que componerlo: ahi una diferencia es casi siempre un cargo que
    // falta, y el neto arrastra al total y al asiento entero. En los otros
    // tipos el neto SI viene impreso, asi que una diferencia es mas probable
    // que sea un caso legitimo (una linea que el proveedor no desglosa) que
    // un error -- se avisa, no se frena.
    estado: tipoFactura === 'tarjeta' ? 'error' : 'advertencia',
    // No se le echa la culpa al neto: el desvío puede estar de cualquiera de
    // los dos lados, y decidirlo es del operador. En el caso real que
    // motivó esto pasaron las dos cosas -- en una liquidación faltaba un
    // cargo en el neto, y en otra el que estaba mal era el IVA (una
    // percepción del 3% leída como alícuota del 21%).
    mensaje:
      `El neto y el IVA no cierran: las alícuotas implican un neto de ` +
      `$ ${fmt.format(esperado)} y está declarado $ ${fmt.format(neto)} ` +
      `(difieren $ ${fmt.format(diferencia)}). Revisá si al neto le falta un cargo ` +
      `o si alguna línea de IVA tiene mal el porcentaje.`,
  }
}

const RE_CAE = /^\d{14}$/

/**
 * Acepta dd/mm/yyyy, dd.mm.yyyy y dd-mm-yyyy: la IA transcribe la fecha tal
 * como está impresa en el comprobante, y no todos los proveedores usan la
 * barra (ej. Topper imprime "30.07.2026"). Bug real, encontrado registrando
 * un comprobante real: antes solo aceptaba la barra, así que una fecha con
 * puntos no matcheaba, `parsearFechaArg` devolvía `null`, y el llamador
 * hacía `?? new Date()` -- la factura quedaba grabada en Tango con la
 * fecha de HOY en vez de la fecha real, en silencio, sin ningún error.
 */
export function parsearFechaArg(f: string): Date | null {
  const m = /^(\d{2})[/.-](\d{2})[/.-](\d{4})$/.exec(f.trim())
  if (!m) return null
  const dia = Number(m[1])
  const mes = Number(m[2])
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null
  const d = new Date(Number(m[3]), mes - 1, dia)
  // new Date() no rechaza dia=31 en un mes de 30: reindexa al mes
  // siguiente en vez de fallar. Detectarlo comparando el dia de vuelta.
  if (d.getDate() !== dia) return null
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

/**
 * La fecha de emisión no tiene otro chequeo en "Listo para registrar" --
 * sin este, una fecha ilegible pasaba desapercibida hasta el momento de
 * grabar, donde el registro la reemplazaba en silencio por la fecha de
 * hoy (ver el comentario en `parsearFechaArg`).
 */
export function validarFecha(fecha: string | null | undefined): ResultadoValidacion {
  const f = (fecha ?? '').trim()
  if (!f) return { estado: 'error', mensaje: 'Falta la fecha de emisión.' }
  if (!parsearFechaArg(f)) {
    return { estado: 'error', mensaje: `No se pudo interpretar la fecha de emisión "${f}".` }
  }
  return { estado: 'ok', mensaje: 'Fecha de emisión válida.' }
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

