import type { RenglonGuardado } from '@/server/app/detalle'
import { formatMoneda, formatCantidad } from '@/lib/formato'
import styles from './renglones.module.css'

/**
 * PHF_RENGLON guarda cantidad, precio e importe como DECIMAL: vuelven acá
 * como `"80745.57"`, no como el `"80.745,57"` que muestra el PDF. Se
 * convierten a número con `Number()` -- no con `parsearImporte`, que está
 * pensado para texto ambiguo leído por la IA (mezcla "," y "." en el mismo
 * PDF) y rompería con una cantidad de más de dos decimales como "12.3456"
 * (la interpretaría como separador de miles) -- y se muestran con
 * `formatMoneda`/`formatCantidad` (mismo separador es-AR) para que los
 * dígitos alineen en columna, como pide la regla tipográfica central del
 * diseño. La cantidad usa `formatCantidad`, sin el signo `$`: no es un
 * importe.
 */
function num(v: string | null): number | null {
  return v === null ? null : Number(v)
}

export function Renglones({ renglones }: { renglones: RenglonGuardado[] }) {
  // El 77% de los comprobantes vienen solo con cabecera: una tarjeta vacía
  // sería ruido permanente en la pantalla donde el operador pasa el 90%
  // del tiempo.
  if (renglones.length === 0) return null

  return (
    <section className={styles.tarjeta}>
      <h3 className={styles.titulo}>Renglones detectados</h3>

      <div className={styles.header}>
        <span>Código</span>
        <span>Descripción</span>
        <span className={styles.derecha}>Cant.</span>
        <span className={styles.derecha}>P. unitario</span>
        <span className={styles.derecha}>Importe</span>
      </div>

      {renglones.map((r) => (
        <div key={r.orden} className={styles.fila}>
          <span className={styles.mono}>{r.codigo ?? '—'}</span>
          <span className={styles.descripcion}>{r.descripcion ?? '—'}</span>
          <span className={styles.monoDerecha}>{formatCantidad(num(r.cantidad))}</span>
          <span className={styles.monoDerecha}>{formatMoneda(num(r.precioUnitario))}</span>
          <span className={styles.importe}>{formatMoneda(num(r.importe))}</span>
        </div>
      ))}
    </section>
  )
}
