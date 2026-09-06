import { parsearImporte } from './formato'
import { normalizar } from './percepcionIibb'

/**
 * Una percepción de IVA NO es un "impuesto vario".
 *
 * En CPA14 los códigos de percepción de IVA -- el 15 ("PERCEPCION
 * R.G.3337") y el 16 ("PERCEP. DE IVA") -- tienen TIPO_ALI = 'IV', igual
 * que las alícuotas 1 a 4: van en los slots COD_IVA de la cabecera
 * (CPA04), no en CPA18. Por eso `listarCodigosImpuesto` no los devuelve y
 * la lista de "Impuestos varios" no los ofrece: si el modelo mete ahí una
 * percepción de IVA, el operador queda sin ninguna opción correcta que
 * elegir y el comprobante no se puede registrar.
 *
 * Pasó de verdad con la liquidación 00208179 de Banco Macro (AMEX): la
 * línea "Percep./Retenc.AFIP - DGI" de $97,21 quedó en `varios2` con el
 * desplegable en rojo y sin salida posible.
 *
 * Este módulo detecta esas líneas por el rótulo impreso y las manda al par
 * porcivaN/impivaN que les corresponde. Ahí `resolverAlicuotas` ya sabe
 * qué hacer con ellas: un importe sin porcentaje impreso resuelve al
 * código 15, la norma que definió el usuario el 2026-08-21.
 */

/**
 * Los rótulos que delatan una percepción de IVA. Se pide que la línea diga
 * que es una PERCEPCIÓN y además que sea de IVA, por sigla o por número de
 * régimen -- las dos condiciones, no una.
 *
 * Que haga falta el "perc" deja afuera a propósito la retención de IVA
 * (CPA14 17, "RETENCION IVA"): también es TIPO_ALI = 'IV' y también
 * debería viajar en estos slots, pero resolvería al 15 -- una percepción
 * -- y quedaría mal imputada. Preferimos que una retención de IVA siga
 * quedando visible sin código antes que moverla a un código equivocado.
 */
const DICE_PERCEPCION = /\bperc/
const DICE_IVA = /\biva\b|\bafip\b|\bdgi\b|\b2408\b|\b3337\b/

/**
 * Lo que a pesar de nombrar a la AFIP no es percepción de IVA. Va primero
 * que todo: en un resumen de tarjeta conviven cuatro o cinco líneas de
 * impuestos en el mismo pie y varias mencionan al organismo.
 *
 * `\bib\b` cubre "Ret.IB SIRTAC", que es como Banco Macro imprime el
 * SIRTAC en la misma liquidación que motivó esto.
 */
const NO_ES_IVA =
  /ingresos brutos|iibb|\bib\b|sircreb|sirtac|ganancias|municipal|\btem\b|debito|credito/

/** Si el rótulo impreso de una línea de impuesto es una percepción de IVA. */
export function esPercepcionDeIva(texto: string | null | undefined): boolean {
  const t = normalizar(texto ?? '')
  if (t === '') return false
  if (NO_ES_IVA.test(t)) return false
  return DICE_PERCEPCION.test(t) && DICE_IVA.test(t)
}

export type EscrituraCampo = { clave: string; valor: string | null }

export type PlanPercepcionIva = {
  /** Los campos a reescribir. Vacío cuando no hay nada que mudar. */
  escrituras: EscrituraCampo[]
  /** Los rótulos que se mudan, para dejarlos en la auditoría. */
  mudados: string[]
  /** Cuántas se reconocieron pero no entraron por falta de slot de IVA libre. */
  sinLugar: number
}

const VACIO: PlanPercepcionIva = { escrituras: [], mudados: [], sinLugar: 0 }

/**
 * Arma la mudanza de las percepciones de IVA que quedaron en los slots de
 * impuestos varios.
 *
 * `slotsIva` y `slotsVarios` son los slots que ese tipo de comprobante
 * analiza, en orden. No son fijos: tarjeta cede los pares 4 y 5 de IVA para
 * hacerle lugar al array de cargos (`SLOTS_LIBERADOS_TARJETA`), así que
 * mudar a `impiva4` en una liquidación escribiría un campo que el
 * formulario no muestra y que nadie podría corregir.
 *
 * Dos condiciones para mover una línea, las dos por precedencia del
 * operador sobre el sistema, que es la regla de toda la app:
 *
 * - Solo si NO tiene código elegido a mano (`codvariosN`). Si el operador
 *   ya resolvió esa línea, eligió que fuera un impuesto vario y esa
 *   decisión gana.
 * - Solo si hay un par de IVA libre. Pisar un importe de IVA que el
 *   comprobante sí trae sería perder un dato real para salvar otro.
 *
 * Los slots de varios que sobreviven se compactan desde el 1, para no
 * dejar un hueco en el medio del formulario.
 */
export function planificarPercepcionIva(
  valores: Record<string, string | null | undefined>,
  slotsIva: number[],
  slotsVarios: number[],
): PlanPercepcionIva {
  // Se conservan también las líneas sin importe: no se registran, pero el
  // rótulo puede ser lo único que quedó de algo que la IA leyó a medias y
  // borrarlo al compactar sería perderlo sin avisar.
  const lineas = slotsVarios
    .map((slot) => ({
      slot,
      texto: (valores[`varios${slot}`] ?? '').trim(),
      codigo: (valores[`codvarios${slot}`] ?? '').trim(),
      importe: (valores[`impvarios${slot}`] ?? '').trim(),
    }))
    .filter((l) => l.texto !== '' || l.importe !== '')

  const aMudar = lineas.filter(
    (l) => !l.codigo && parsearImporte(l.importe) > 0 && esPercepcionDeIva(l.texto),
  )
  if (aMudar.length === 0) return VACIO

  const libres = slotsIva.filter((n) => parsearImporte(valores[`impiva${n}`]) <= 0)
  const mudan = aMudar.slice(0, libres.length)
  const sinLugar = aMudar.length - mudan.length
  if (mudan.length === 0) return { ...VACIO, sinLugar }

  const quedan = lineas.filter((l) => !mudan.includes(l))
  const escrituras: EscrituraCampo[] = []

  mudan.forEach((linea, i) => {
    const slot = libres[i]
    escrituras.push({ clave: `impiva${slot}`, valor: linea.importe })
    // El porcentaje se deja vacío a propósito, no en "0": son cosas
    // distintas para `resolverAlicuotas`. Vacío es "el comprobante no
    // imprime tasa" y resuelve al código preferido; "0" es una alícuota
    // real de tasa cero y se omite del registro.
    escrituras.push({ clave: `porciva${slot}`, valor: null })
    escrituras.push({ clave: `codiva${slot}`, valor: null })
  })

  slotsVarios.forEach((slot, i) => {
    const linea = quedan[i]
    escrituras.push({ clave: `varios${slot}`, valor: linea ? linea.texto : null })
    escrituras.push({ clave: `impvarios${slot}`, valor: linea ? linea.importe : null })
    escrituras.push({ clave: `codvarios${slot}`, valor: linea?.codigo || null })
  })

  return { escrituras, mudados: mudan.map((l) => l.texto), sinLugar }
}
