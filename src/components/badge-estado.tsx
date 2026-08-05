import { ESTADOS, type Estado } from '@/lib/estados'
import styles from './badge-estado.module.css'

export function BadgeEstado({ estado }: { estado: Estado }) {
  const e = ESTADOS[estado]
  return (
    <span className={styles.badge} style={{ background: e.fondo, color: e.texto }}>
      {e.label}
    </span>
  )
}
