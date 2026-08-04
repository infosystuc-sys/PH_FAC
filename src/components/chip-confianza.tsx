import styles from './chip-confianza.module.css'

const NIVELES = [
  { max: 0.8,  fondo: '#fae7e3', texto: '#a03526' },
  { max: 0.93, fondo: '#fbf0dc', texto: '#8a5a00' },
  { max: 1.01, fondo: '#eef0f2', texto: '#6b7078' },
]

export function ChipConfianza({ valor }: { valor: number | null | undefined }) {
  if (valor === null || valor === undefined || valor >= 1) return null
  const nivel = NIVELES.find((n) => valor < n.max) ?? NIVELES[2]
  return (
    <span className={styles.chip} style={{ background: nivel.fondo, color: nivel.texto }}>
      {Math.round(valor * 100)}%
    </span>
  )
}
