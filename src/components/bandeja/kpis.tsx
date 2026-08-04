import type { Kpis } from '@/server/app/comprobantes'
import { formatMoneda } from '@/lib/formato'
import styles from './kpis.module.css'

export function FilaKpis({ kpis }: { kpis: Kpis }) {
  const tarjetas = [
    { label: 'Pendientes de revisión', valor: String(kpis.pendientes) },
    { label: 'En observación', valor: String(kpis.enObservacion), color: '#8a5a00' },
    { label: 'Registrados hoy', valor: String(kpis.registradosHoy) },
    { label: 'Importe pendiente', valor: formatMoneda(kpis.importePendiente) },
  ]

  return (
    <div className={styles.grid}>
      {tarjetas.map((t) => (
        <div key={t.label} className={styles.tarjeta}>
          <div className={styles.label}>{t.label}</div>
          <div className={styles.valor} style={t.color ? { color: t.color } : undefined}>
            {t.valor}
          </div>
        </div>
      ))}
    </div>
  )
}
