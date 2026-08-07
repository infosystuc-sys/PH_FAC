import type { Validaciones } from '@/server/app/validaciones'
import { SelectorProveedor } from './selector-proveedor'
import styles from './validaciones.module.css'

const GLIFO = { ok: '✓', advertencia: '!', error: '✕' } as const

function Item({
  estado,
  mensaje,
  extra,
}: {
  estado: 'ok' | 'advertencia' | 'error'
  mensaje: string
  extra?: React.ReactNode
}) {
  return (
    <div className={styles.item}>
      <div className={styles.fila}>
        <span className={`${styles.punto} ${styles[estado]}`}>{GLIFO[estado]}</span>
        <span className={styles.mensaje}>{mensaje}</span>
      </div>
      {extra}
    </div>
  )
}

export function PanelValidaciones({
  comprobanteId,
  validaciones,
}: {
  comprobanteId: number
  validaciones: Validaciones
}) {
  return (
    <section className={styles.tarjeta}>
      <h3 className={styles.titulo}>Validaciones</h3>
      <div className={styles.lista}>
        <Item
          estado={validaciones.proveedor.estado}
          mensaje={validaciones.proveedor.mensaje}
          extra={
            validaciones.proveedor.estado === 'error' ? (
              <SelectorProveedor comprobanteId={comprobanteId} candidatos={validaciones.candidatosProveedor} />
            ) : undefined
          }
        />
        <Item estado={validaciones.duplicado.estado} mensaje={validaciones.duplicado.mensaje} />
        <Item estado={validaciones.totales.estado} mensaje={validaciones.totales.mensaje} />
        <Item estado={validaciones.cae.estado} mensaje={validaciones.cae.mensaje} />
      </div>
    </section>
  )
}
