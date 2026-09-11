/**
 * Norma de registración para las líneas de Ingresos Brutos: los únicos
 * cinco códigos de CPA14 que la app admite. Es la fuente única: de acá
 * salen el prompt de extracción, la resolución de la jurisdicción leída
 * del PDF y la validación server-side.
 *
 * La lista es una decisión de registración, no una deducción de cómo se
 * cargaron los comprobantes históricos: los movimientos anteriores de
 * CPA18 no la justifican ni la amplían. Nada se agrega acá sin que lo
 * defina el usuario.
 *
 * El 64 y el 66 figuran en CPA14 como retención (PERCEPCION = 0,
 * TIPO_ALI = 'OT') y aun así entran: la norma los trata como línea de
 * Ingresos Brutos del comprobante.
 *
 * **La percepción se identifica por jurisdicción, nunca por porcentaje.**
 * Verificado contra CPA14: el 60 (Tucumán) y el 61 (Salta) son ambos
 * 2,5%, y el 64 y el 66 son ambos 0%. El porcentaje no distingue, así que
 * no se usa para resolver -- a diferencia de las alícuotas de IVA, donde
 * sí es el dato que identifica.
 */
export type CodigoIibb = {
  codigo: string
  /** Etiqueta canónica de la jurisdicción. */
  jurisdiccion: string
  /**
   * Cómo puede aparecer escrita en el PDF. Se comparan normalizadas (sin
   * acentos, en minúsculas), y alcanza con que el texto leído contenga
   * alguna: los comprobantes escriben "Perc. IIBB TUC", "Ret. IIBB
   * Tucumán RG 22/18" y variantes por el estilo.
   */
  alias: string[]
  /** Qué tiene que encontrar la IA en el PDF para sugerir este código. */
  criterio: string
}

export const JURISDICCIONES_IIBB: CodigoIibb[] = [
  {
    codigo: '60',
    jurisdiccion: 'Tucumán',
    alias: ['tucuman', 'tuc'],
    criterio: 'una línea de Ingresos Brutos de Tucumán',
  },
  {
    codigo: '61',
    jurisdiccion: 'Salta',
    alias: ['salta', 'salt'],
    criterio: 'una línea de Ingresos Brutos de Salta',
  },
  {
    codigo: '62',
    jurisdiccion: 'CABA',
    alias: ['caba', 'ciudad autonoma de buenos aires', 'capital federal'],
    criterio: 'una línea de Ingresos Brutos de CABA o Ciudad Autónoma de Buenos Aires',
  },
  {
    codigo: '66',
    jurisdiccion: 'SIRCREB',
    alias: ['sircreb'],
    criterio: 'que la línea mencione SIRCREB, en cualquier variante',
  },
  {
    codigo: '64',
    jurisdiccion: 'Bancarias',
    alias: ['bancaria', 'bancarias', 'bancario', 'bancarios', 'banco'],
    criterio:
      'una línea de Ingresos Brutos bancaria -- típica de resúmenes de banco y ' +
      'liquidaciones de tarjeta -- que NO mencione SIRCREB',
  },
]

/**
 * Sin acentos y en minúsculas, para comparar lo del PDF contra los alias.
 * Exportada porque `aprendizajeImpuestos.ts` la usa para guardar la
 * jurisdicción con la misma normalización con la que después se busca --
 * si no coincidieran, una fila aprendida nunca haría match.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Colapsar espacios se agrego al empezar a usar esta funcion tambien
    // para el rotulo de los impuestos varios (2026-09-04): esos vienen del
    // pie del comprobante con espaciado irregular --el propio modelo
    // contable de esta empresa tiene un "PERCEPCION  10 %" con dos
    // espacios-- y sin colapsar, dos escrituras del mismo impuesto no
    // matchean. Es la misma regla que ya aplicaba normalizarTextoCondicion:
    // las dos normalizaciones quedan alineadas en vez de diferir por un
    // detalle.
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * El código de Tango al que va una línea de percepción, ya resuelto.
 *
 * Es un subconjunto de `CodigoIibb` a propósito: desde el 2026-09-09 el
 * operador puede elegir cualquier código de CPA14, así que también puede ser
 * uno que no es una jurisdicción. Ahí `jurisdiccion` lleva la descripción de
 * Tango, que es lo que se muestra. Los consumidores solo usan estos dos
 * campos.
 */
export type CodigoPercepcion = { codigo: string; jurisdiccion: string }

/** Un código de CPA14 tal como lo devuelve `listarCodigosImpuesto`. */
type CodigoTango = { codigo: number; descripcion: string }

/**
 * El código que este proveedor ya enseñó para este rótulo.
 *
 * Se busca primero entre las jurisdicciones, para conservar su etiqueta
 * propia ("Tucumán" y no "PERCEPCION IIBB TUC"), y después en todo CPA14.
 * Sin lo segundo, aprender un código que no es una de las cinco --que desde
 * el 2026-09-09 se puede elegir-- no hacía nada: la fila quedaba guardada en
 * `PHF_ALICUOTA_PROVEEDOR` y la resolución la descartaba en silencio. Pasó
 * de verdad con "bancarias" → 63 del proveedor 010108.
 */
function aprendidoPara(
  t: string,
  aprendidos?: Record<string, string>,
  codigosImpuesto?: CodigoTango[],
): CodigoPercepcion | null {
  const cod = aprendidos?.[t]
  if (!cod) return null

  const jurisdiccion = JURISDICCIONES_IIBB.find((j) => j.codigo === cod)
  if (jurisdiccion) return jurisdiccion

  const enTango = codigosImpuesto?.find((c) => String(c.codigo) === cod)
  return enTango ? { codigo: String(enTango.codigo), jurisdiccion: enTango.descripcion } : null
}

/**
 * Resuelve la jurisdicción leída del PDF al código de CPA14.
 *
 * SIRCREB se evalúa antes que "bancarias" porque también es bancaria: sin
 * ese orden, un "Ret. IIBB SIRCREB bancaria" caería en el 64. El orden
 * del array ya lo garantiza (el 66 va antes que el 64), y este comentario
 * está para que nadie lo reordene por prolijidad.
 *
 * `aprendidos` es lo que un proveedor puntual ya le enseñó a la app
 * (`PHF_ALICUOTA_PROVEEDOR`, vía `aprendizajeImpuestos.ts`): el código que
 * el operador eligió a mano una vez para este rótulo y este proveedor.
 *
 * **Se consulta PRIMERO**, antes que la lista fija -- cambio del 2026-09-09,
 * pedido del usuario. Hasta entonces iba último, con el argumento de que una
 * jurisdicción real (Tucumán, CABA...) tiene que resolver por su cuenta sin
 * depender de que alguna vez se haya aprendido algo. El argumento sigue en
 * pie para el caso normal --sin nada aprendido, la lista fija resuelve
 * igual-- pero convertía el aprendizaje en letra muerta justo donde el
 * operador lo necesitaba: si el rótulo ya resolvía por alias, la corrección
 * se guardaba y no se aplicaba nunca. Es la misma precedencia que ya tenían
 * los impuestos varios (ver `resolverCodigoVarios`): lo que el operador
 * enseñó para ESE proveedor es más específico que una regla para todos.
 */
export function resolverPercepcionIibb(
  texto: string | null | undefined,
  aprendidos?: Record<string, string>,
  codigosImpuesto?: CodigoTango[],
): CodigoPercepcion | null {
  const t = normalizar(texto ?? '')
  if (t === '') return null

  const aprendido = aprendidoPara(t, aprendidos, codigosImpuesto)
  if (aprendido) return aprendido

  // Si escribieron el código directo ("60"), vale igual: el operador que
  // sabe el código no tiene por qué buscar cómo se llama la jurisdicción.
  const porCodigo = JURISDICCIONES_IIBB.find((j) => j.codigo === t)
  if (porCodigo) return porCodigo

  return JURISDICCIONES_IIBB.find((j) => j.alias.some((a) => t.includes(a))) ?? null
}

/**
 * El codigo de IIBB que corresponde a una linea segun el tipo de
 * comprobante.
 *
 * En conceptos y articulos manda la jurisdiccion leida (ver
 * `resolverPercepcionIibb`): ahi el rotulo nombra la provincia y la lista
 * curada la resuelve.
 *
 * **En tarjeta no se adivina nada.** Resuelve unicamente lo que ese emisor
 * ya tiene aprendido para ese rotulo, que es donde vive la tabla de
 * imputacion del usuario (`scripts/cargar-imputacion-tarjetas.ts`: 48 filas
 * que mapean CUIT + rotulo impreso al codigo de Tango). Un rotulo que no
 * este en la tabla deja la linea en `sin-codigo`, la elige el operador, y
 * esa eleccion se aprende -- `aprenderImpuestoTango` en `acciones.ts` -- y
 * pasa a ser la regla para ese emisor. Decision del usuario del 2026-09-11:
 * "solo debes respetar las equivalencias que te subi; si no coincide debes
 * dejar que el usuario elija la alicuota y escribe la regla para esa
 * alicuota".
 *
 * Hasta ese dia habia dos reglas generales aca, y las dos contradecian la
 * tabla:
 *
 * - Toda linea de IIBB de una tarjeta iba al 64 ("RET IIBB BANCARIOS"),
 *   decision del 2026-08-17. La tabla manda el IIBB de Tucuman al 63 y
 *   reserva el 64 para el SIRTAC, asi que esa regla imputaba la retencion de
 *   Tucuman al codigo del SIRTAC. Es el error que reporto el usuario.
 * - Sacada esa, quedaba la resolucion por alias, que manda "Tucuman" al 60
 *   -- tambien distinto del 63 de la tabla.
 *
 * Ninguna de las dos se puede conservar sin volver a contradecirla: en una
 * liquidacion de tarjeta la imputacion la define el emisor, no la
 * jurisdiccion que nombre el rotulo. El SIRCREB tampoco queda exceptuado
 * (tenia el 66 fijo): no figura en la tabla, asi que la primera liquidacion
 * que lo traiga la imputa el operador y de ahi en mas sale sola.
 */
export function resolverIibbPorTipo(
  texto: string,
  tipoFactura: string | null | undefined,
  aprendidos?: Record<string, string>,
  codigosImpuesto?: CodigoTango[],
): CodigoPercepcion | null {
  const aprendido = aprendidoPara(normalizar(texto ?? ''), aprendidos, codigosImpuesto)
  if (aprendido) return aprendido

  if (tipoFactura === 'tarjeta') return null

  return resolverPercepcionIibb(texto)
}
