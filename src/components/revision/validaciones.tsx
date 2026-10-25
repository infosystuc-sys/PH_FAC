import type { Validaciones } from '@/server/app/validaciones'
import { SelectorProveedor } from './selector-proveedor'
import styles from './validaciones.module.css'
import { Icono } from '@/components/icono'

// Los iconos de estado del sistema visual: ok, warn y error (seccion 6).
const GLIFO = { ok: 'ok', advertencia: 'warn', error: 'error' } as const

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
        <span className={`${styles.punto} ${styles[estado]}`}>
          <Icono nombre={GLIFO[estado]} size={15} />
        </span>
        <span className={styles.mensaje}>{mensaje}</span>
      </div>
      {extra}
    </div>
  )
}

export function PanelValidaciones({
  comprobanteId,
  validaciones,
  ocultarOk = false,
}: {
  comprobanteId: number
  validaciones: Validaciones
  /**
   * Esconde las validaciones que dieron OK (2026-10-08, pedido del
   * usuario): en un comprobante sano son todas, y lo que el operador
   * necesita ver es lo que NO esta bien.
   */
  ocultarOk?: boolean
}) {
  // El proveedor es la unica que lleva algo adentro --el buscador, cuando
  // falla--, asi que no entra en la lista generica.
  const resto = [validaciones.duplicado, validaciones.totales, validaciones.cae].filter(
    (v): v is NonNullable<typeof v> => v != null,
  )
  const proveedorOculto = ocultarOk && validaciones.proveedor.estado === 'ok'
  const visibles = ocultarOk ? resto.filter((v) => v.estado !== 'ok') : resto
  const enOrden =
    (proveedorOculto ? 1 : 0) + (ocultarOk ? resto.length - visibles.length : 0)

  return (
    <section className={styles.tarjeta}>
      <h3 className={styles.titulo}>Validaciones</h3>
      <div className={styles.lista}>
        {!proveedorOculto && (
          <Item
            estado={validaciones.proveedor.estado}
            mensaje={validaciones.proveedor.mensaje}
            extra={
              validaciones.proveedor.estado === 'error' ? (
                <SelectorProveedor comprobanteId={comprobanteId} candidatos={validaciones.candidatosProveedor} />
              ) : undefined
            }
          />
        )}
        {visibles.map((v, i) => (
          <Item key={i} estado={v.estado} mensaje={v.mensaje} />
        ))}
        {/* Lo que se escondio se CUENTA. Sacarlo sin dejar rastro haria
            creer que no se verifico. */}
        {enOrden > 0 && (
          <p className={styles.enOrden}>
            {enOrden === 1 ? '1 validación en orden' : `${enOrden} validaciones en orden`}
          </p>
        )}
      </div>
    </section>
  )
}
