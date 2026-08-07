import type { EntradaAuditoria } from '@/server/app/detalle'
import styles from './historial.module.css'

/**
 * "dd/mm hh:mm" alcanza para distinguir entradas del mismo día sin
 * desperdiciar el ancho fijo de 104px que pide el README §2 — un
 * timestamp completo con año y segundos no entraría en mono a 11.5px.
 */
function formatTimestamp(fecha: Date): string {
  const dd = String(fecha.getDate()).padStart(2, '0')
  const mm = String(fecha.getMonth() + 1).padStart(2, '0')
  const hh = String(fecha.getHours()).padStart(2, '0')
  const mi = String(fecha.getMinutes()).padStart(2, '0')
  return `${dd}/${mm} ${hh}:${mi}`
}

export function Historial({ entradas }: { entradas: EntradaAuditoria[] }) {
  return (
    <section className={styles.tarjeta}>
      <h3 className={styles.titulo}>Historial</h3>
      {entradas.map((entrada, i) => (
        <div key={i} className={styles.fila}>
          <span className={styles.timestamp}>{formatTimestamp(entrada.fecha)}</span>
          <span className={styles.texto}>{entrada.texto}</span>
          <span className={styles.usuario}>{entrada.usuario}</span>
        </div>
      ))}
    </section>
  )
}
