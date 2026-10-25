import { RefrescoProcesando } from './refresco-procesando'
import styles from './panel-procesando.module.css'
import { Icono } from '@/components/icono'

export function PanelProcesando() {
  return (
    <div className={styles.envoltura}>
      <div className={styles.caja}>
        <div className={styles.icono}>
          <Icono nombre="sparkles" size={18} />
        </div>
        <div className={styles.titulo}>Procesando con IA</div>
        <p className={styles.detalle}>
          Claude está leyendo el comprobante. Esta pantalla se actualiza sola cuando termina.
        </p>
      </div>
      <RefrescoProcesando />
    </div>
  )
}
