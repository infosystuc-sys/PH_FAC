export type NivelConfianza = {
  fondo: string
  texto: string
}

const BAJO: NivelConfianza = { fondo: '#fae7e3', texto: '#a03526' }
const MEDIO: NivelConfianza = { fondo: '#fbf0dc', texto: '#8a5a00' }
const ALTO: NivelConfianza = { fondo: '#eef0f2', texto: '#6b7078' }

/**
 * Determina el nivel visual del chip de confianza según el valor (0..1).
 *
 * Rangos (asimétricos a propósito, ver design/README.md):
 * - `valor < 0.80` → rojo (bajo)
 * - `0.80 <= valor <= 0.93` → ámbar (medio)
 * - `valor > 0.93` → gris (alto)
 */
export function nivelConfianza(valor: number): NivelConfianza {
  if (valor < 0.8) return BAJO
  if (valor <= 0.93) return MEDIO
  return ALTO
}
