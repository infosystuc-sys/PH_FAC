import styles from './panel-observacion.module.css'

/**
 * Por que este comprobante esta en observacion, arriba de todo en el panel
 * de revision.
 *
 * A diferencia de `PanelError`, no reemplaza la pantalla: un comprobante en
 * observacion se sigue revisando y corrigiendo, solo que salio de la fila
 * de trabajo. Por eso es una banda y no una pagina.
 *
 * Hacia falta porque MOTIVO_OBSERVACION y NOTA_OBSERVACION se venian
 * guardando desde siempre sin que ninguna pantalla los mostrara: el
 * operador veia el badge "En observación" y no tenia como saber por que,
 * ni siquiera si lo habia marcado el mismo la semana pasada.
 */
export function PanelObservacion({ motivo, nota }: { motivo: string | null; nota: string | null }) {
  // Sin motivo no hay nada que decir. Pasa con los comprobantes que se
  // pusieron en observacion antes de que existiera este panel.
  if (!motivo) return null

  return (
    <div className={styles.banda}>
      <div className={styles.icono}>!</div>
      <div className={styles.texto}>
        <div className={styles.motivo}>{motivo}</div>
        {nota && <p className={styles.nota}>{nota}</p>}
      </div>
    </div>
  )
}
