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

/** Sin acentos y en minúsculas, para comparar lo del PDF contra los alias. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

/**
 * Resuelve la jurisdicción leída del PDF al código de CPA14.
 *
 * SIRCREB se evalúa antes que "bancarias" porque también es bancaria: sin
 * ese orden, un "Ret. IIBB SIRCREB bancaria" caería en el 64. El orden
 * del array ya lo garantiza (el 66 va antes que el 64), y este comentario
 * está para que nadie lo reordene por prolijidad.
 */
export function resolverPercepcionIibb(texto: string | null | undefined): CodigoIibb | null {
  const t = normalizar(texto ?? '')
  if (t === '') return null

  // Si escribieron el código directo ("60"), vale igual: el operador que
  // sabe el código no tiene por qué buscar cómo se llama la jurisdicción.
  const porCodigo = JURISDICCIONES_IIBB.find((j) => j.codigo === t)
  if (porCodigo) return porCodigo

  return JURISDICCIONES_IIBB.find((j) => j.alias.some((a) => t.includes(a))) ?? null
}
