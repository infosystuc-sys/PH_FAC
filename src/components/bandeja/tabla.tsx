import Link from 'next/link'
import type { FilaBandeja } from '@/server/app/comprobantes'
import type { ClaveTab } from '@/lib/estados'
import { BadgeEstado } from '@/components/badge-estado'
import { AccionesFila } from './acciones-fila'
import { ChipConfianza } from '@/components/chip-confianza'
import { formatMoneda, formatFecha, formatCuit } from '@/lib/formato'
import styles from './tabla.module.css'

export function Tabla({ filas, filtro, query }: { filas: FilaBandeja[]; filtro: ClaveTab; query: string }) {
  if (filas.length === 0) {
    return (
      <div className={styles.contenedor}>
        <div className={styles.vacio}>No hay comprobantes con este filtro.</div>
      </div>
    )
  }

  // El link a la revision conserva el filtro/busqueda activos: la
  // navegacion J/K de la pantalla de revision (ver atajos.ts) necesita el
  // mismo contexto para calcular anterior/siguiente dentro de esta misma
  // vista, no de la bandeja completa.
  const qs = new URLSearchParams()
  if (filtro !== 'todos') qs.set('filtro', filtro)
  if (query) qs.set('q', query)
  const sufijo = qs.toString() ? `?${qs.toString()}` : ''

  return (
    <div className={styles.contenedor}>
      <div className={styles.scroll}>
        <div className={styles.header}>
          <span>Estado</span>
          <span>Tipo</span>
          <span>Comprobante</span>
          <span>Fecha</span>
          <span>Proveedor</span>
          <span>CUIT</span>
          <span className={styles.derecha}>Total</span>
          <span className={styles.centro}>Confianza</span>
          <span />
          <span />
        </div>

        {filas.map((f) => (
          // La fila es un div y no un Link porque tiene adentro un boton
          // (eliminar), y un boton dentro de un <a> no es HTML valido ni
          // se puede clickear sin que el link se lo lleve. El link pasa a
          // ser una capa que cubre la fila entera; la celda de acciones va
          // por encima. La grilla no cambia.
          <div key={f.id} className={styles.fila}>
            <Link
              href={`/comprobantes/${f.id}${sufijo}`}
              className={styles.enlace}
              aria-label={`Abrir ${f.numero ?? 'comprobante'}`}
            />
            <span><BadgeEstado estado={f.estado} /></span>
            <span className={styles.tipo}>{f.tipo ?? '—'}</span>
            <span className={styles.mono}>{f.numero ?? '—'}</span>
            <span className={styles.monoTenue}>{formatFecha(f.fechaEmision)}</span>
            <span className={styles.proveedor}>{f.razonSocial ?? '—'}</span>
            <span className={styles.monoTenue}>{formatCuit(f.cuit)}</span>
            <span className={styles.total}>{formatMoneda(f.total)}</span>
            <span className={styles.centro}><ChipConfianza valor={f.confianzaPromedio} /></span>
            <AccionesFila
              id={f.id}
              comprobante={[f.tipo, f.numero].filter(Boolean).join(' ') || `Comprobante ${f.id}`}
              proveedor={f.razonSocial ?? '—'}
              estado={f.estado}
              className={styles.accion}
            />
            <span className={styles.chevron}>›</span>
          </div>
        ))}
      </div>
    </div>
  )
}
