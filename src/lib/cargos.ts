/**
 * Un cargo de una liquidación de tarjeta tal como lo devuelve la IA: el
 * rótulo con el que la procesadora lo imprime y su importe, los dos sin
 * interpretar. El parseo a número vive en `formato.ts`, igual que con los
 * campos y los renglones.
 *
 * Por qué existe: en una liquidación el neto gravado no viene impreso en
 * ningún renglón. Es la suma de varios cargos --arancel, comisión, costo
 * financiero, cargo de transferencia, promociones-- que cada procesadora
 * rotula distinto y que aparecen en cantidad variable: Valle Fértil trae
 * dos, Tarjeta Sol cinco. Pedirle al modelo el total ya sumado lo obliga a
 * hacer una cuenta de memoria, y ahí se equivoca: leyendo el mismo PDF dos
 * veces devolvió dos bases distintas, una con un cargo de menos.
 *
 * Pidiéndole que transcriba cada cargo por separado, la suma la hace la app
 * -- que no se equivoca -- y de paso el operador puede ver de dónde salió
 * cada peso en vez de recibir un número sin explicación.
 */
export type CargoExtraido = {
  /** El rótulo tal como lo imprime la procesadora ("Arancel de ley"). */
  concepto: string | null
  importe: string | null
}

export const CLAVES_CARGO = ['concepto', 'importe'] as const
