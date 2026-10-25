export type NivelConfianza = {
  fondo: string
  texto: string
}

const BAJO: NivelConfianza = { fondo: 'var(--danger-soft)', texto: 'var(--danger)' }
const MEDIO: NivelConfianza = { fondo: 'var(--warning-soft)', texto: 'var(--warning)' }
const ALTO: NivelConfianza = { fondo: 'var(--bg-sunken)', texto: 'var(--text-muted)' }

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
