'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { FilaBandeja } from '@/server/app/comprobantes'
import type { ClaveTab } from '@/lib/estados'
import { BadgeEstado } from '@/components/badge-estado'
import { AccionesFila } from './acciones-fila'
import { ChipConfianza } from '@/components/chip-confianza'
import { ModalEliminarLote } from '@/components/modal-eliminar-lote'
import { formatMoneda, formatFecha, formatCuit } from '@/lib/formato'
import styles from './tabla.module.css'

export function Tabla({ filas, filtro, query }: { filas: FilaBandeja[]; filtro: ClaveTab; query: string }) {
  const [seleccion, setSeleccion] = useState<Set<number>>(new Set())
  const [modalAbierto, setModalAbierto] = useState(false)

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

  // La seleccion vive en memoria del componente, no en la URL: es una
  // conveniencia de la sesion de trabajo. No hace falta limpiarla a mano
  // al cambiar de filtro/pagina -- `filasSeleccionadas` sale de filtrar
  // `filas` (las que estan en pantalla ahora) contra el Set, asi que un id
  // que ya no esta visible deja de contar solo, sin useEffect ni key.
  const todosSeleccionados = filas.every((f) => seleccion.has(f.id))
  const filasSeleccionadas = filas.filter((f) => seleccion.has(f.id))

  function alternar(id: number) {
    setSeleccion((s) => {
      const copia = new Set(s)
      if (copia.has(id)) copia.delete(id)
      else copia.add(id)
      return copia
    })
  }

  function alternarTodos() {
    setSeleccion(todosSeleccionados ? new Set() : new Set(filas.map((f) => f.id)))
  }

  return (
    <div className={styles.contenedor}>
      <div className={styles.scroll}>
        <div className={styles.header}>
          {filasSeleccionadas.length > 0 ? (
            <div className={styles.barraSeleccion}>
              <span className={styles.check}>
                <input
                  type="checkbox"
                  checked={todosSeleccionados}
                  onChange={alternarTodos}
                  aria-label="Seleccionar todos"
                />
              </span>
              <span className={styles.cantidadSeleccion}>
                {filasSeleccionadas.length} seleccionado{filasSeleccionadas.length === 1 ? '' : 's'}
              </span>
              <button type="button" className={styles.eliminarSeleccion} onClick={() => setModalAbierto(true)}>
                Eliminar seleccionados
              </button>
              <button type="button" className={styles.cancelarSeleccion} onClick={() => setSeleccion(new Set())}>
                Cancelar
              </button>
            </div>
          ) : (
            <>
              <span className={styles.check}>
                <input
                  type="checkbox"
                  checked={todosSeleccionados}
                  onChange={alternarTodos}
                  aria-label="Seleccionar todos"
                />
              </span>
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
            </>
          )}
        </div>

        {filas.map((f) => (
          // La fila es un div y no un Link porque tiene adentro botones
          // (el check, eliminar), y un boton dentro de un <a> no es HTML
          // valido ni se puede clickear sin que el link se lo lleve. El
          // link pasa a ser una capa que cubre la fila entera; el check y
          // la celda de acciones van por encima. La grilla no cambia.
          <div
            key={f.id}
            className={`${styles.fila} ${seleccion.has(f.id) ? styles.filaSeleccionada : ''}`}
          >
            <Link
              href={`/comprobantes/${f.id}${sufijo}`}
              className={styles.enlace}
              aria-label={`Abrir ${f.numero ?? 'comprobante'}`}
            />
            <span className={styles.check}>
              <input
                type="checkbox"
                checked={seleccion.has(f.id)}
                onChange={() => alternar(f.id)}
                aria-label={`Seleccionar ${f.numero ?? 'comprobante'}`}
              />
            </span>
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

      <ModalEliminarLote
        ids={filasSeleccionadas.map((f) => f.id)}
        registrados={filasSeleccionadas.filter((f) => f.estado === 'registrado').length}
        existentes={filasSeleccionadas.filter((f) => f.estado === 'existente').length}
        abierto={modalAbierto}
        onCerrar={() => setModalAbierto(false)}
        // El modal ya hace router.refresh() -- mismo criterio que
        // ModalEliminar en acciones-fila.tsx. Acá solo hace falta limpiar
        // la seleccion.
        alTerminar={() => setSeleccion(new Set())}
      />
    </div>
  )
}
