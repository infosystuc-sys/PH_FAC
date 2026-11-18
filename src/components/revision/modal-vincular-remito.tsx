'use client'

import styles from './modal-vincular-remito.module.css'

/**
 * La confirmación antes de registrar una factura cuya orden de compra ya
 * tiene el remito (2026-11-18, pedido del usuario: "mostrás un aviso de que
 * vas a vincular al remito ... y continuás si te dan el ok"). Las cantidades
 * ya se controlaron en "Listo para registrar": si no coincidieran, el botón
 * de registrar ni estaría habilitado.
 */
export function ModalVincularRemito({
  abierto,
  remitos,
  onCancelar,
  onConfirmar,
}: {
  abierto: boolean
  remitos: string[]
  onCancelar: () => void
  onConfirmar: () => void
}) {
  if (!abierto) return null
  return (
    <div className={styles.overlay} onClick={onCancelar}>
      <div className={styles.caja} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.titulo}>
          Vincular {remitos.length === 1 ? 'al remito' : 'a los remitos'}
        </h2>
        <p className={styles.subtitulo}>
          La orden de compra de esta factura ya tiene {remitos.length === 1 ? 'un remito' : 'remitos'} sin
          facturar, con las mismas cantidades. Al registrar, la factura se vincula{' '}
          {remitos.length === 1 ? 'a este remito' : 'a estos remitos'} y{' '}
          {remitos.length === 1 ? 'queda facturado' : 'quedan facturados'}:
        </p>
        <ul className={styles.remitos}>
          {remitos.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className={styles.acciones}>
          <button type="button" className={styles.cancelar} onClick={onCancelar}>
            Cancelar
          </button>
          <button type="button" className={styles.confirmar} onClick={onConfirmar} autoFocus>
            Vincular y registrar
          </button>
        </div>
      </div>
    </div>
  )
}
