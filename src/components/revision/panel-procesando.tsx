import { RefrescoProcesando } from './refresco-procesando'
import styles from './panel-procesando.module.css'

export function PanelProcesando() {
  return (
    <div className={styles.envoltura}>
      <div className={styles.caja}>
        <div className={styles.icono}>✦</div>
        <div className={styles.titulo}>Procesando con IA</div>
        <p className={styles.detalle}>
          Claude está leyendo el comprobante. Esta pantalla se actualiza sola cuando termina.
        </p>
      </div>
      <RefrescoProcesando />
    </div>
  )
}
