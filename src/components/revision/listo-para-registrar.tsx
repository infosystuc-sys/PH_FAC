import type { ResultadoListoParaRegistrar } from '@/server/app/validaciones'
import styles from './listo-para-registrar.module.css'

const GLIFO = { ok: '✓', advertencia: '!', error: '✕' } as const

export function ListoParaRegistrar({ resultado }: { resultado: ResultadoListoParaRegistrar }) {
  const items = [
    resultado.condCompra,
    resultado.percepcionIibb,
    resultado.percepcionIva3,
    resultado.formatoComp,
  ]

  return (
    <section className={styles.tarjeta}>
      <h3 className={styles.titulo}>Listo para registrar</h3>
      <div className={styles.lista}>
        {items.map((r, i) => (
          <div key={i} className={styles.item}>
            <div className={styles.fila}>
              <span className={`${styles.punto} ${styles[r.estado]}`}>{GLIFO[r.estado]}</span>
              <span className={styles.mensaje}>{r.mensaje}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
