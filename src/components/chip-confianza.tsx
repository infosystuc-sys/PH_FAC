import { nivelConfianza } from '@/lib/confianza'
import styles from './chip-confianza.module.css'

export function ChipConfianza({ valor }: { valor: number | null | undefined }) {
  if (valor === null || valor === undefined || valor >= 1) return null
  const nivel = nivelConfianza(valor)
  return (
    <span className={styles.chip} style={{ background: nivel.fondo, color: nivel.texto }}>
      {Math.round(valor * 100)}%
    </span>
  )
}
