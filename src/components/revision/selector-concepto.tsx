'use client'

import { useEffect, useState, useTransition } from 'react'
import { listarConceptosTango, asignarConcepto } from '@/server/app/acciones/imputacion'
import type { ConceptoProveedor } from '@/server/tango/conceptos'
import { useToast } from '@/components/toast/toast-provider'
import styles from './selector-concepto.module.css'

/**
 * Deja elegir un concepto del maestro de Tango (CPA45) cuando el proveedor
 * de una factura de conceptos no tiene ninguno asociado, en vez de mandar
 * al operador a cargarlo a mano en Tango.
 *
 * El maestro completo (89 filas hoy) se trae una sola vez al montar y se
 * filtra en el cliente: a esta escala no hace falta el vaivén al servidor
 * en cada letra que usa `SelectorArticulo` contra un maestro de miles de
 * artículos.
 */
export function SelectorConcepto({
  comprobanteId,
  codProvee,
}: {
  comprobanteId: number
  codProvee: string
}) {
  const [query, setQuery] = useState('')
  const [conceptos, setConceptos] = useState<ConceptoProveedor[] | null>(null)
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()

  useEffect(() => {
    let vigente = true
    listarConceptosTango()
      .then((r) => vigente && setConceptos(r))
      .catch(() => vigente && setConceptos([]))
    return () => {
      vigente = false
    }
  }, [])

  const q = query.trim().toLowerCase()
  const filtrados = (conceptos ?? []).filter(
    (c) => !q || c.codConcepto.toLowerCase().includes(q) || c.descripcion.toLowerCase().includes(q),
  )

  function elegir(c: ConceptoProveedor) {
    arrancar(async () => {
      try {
        await asignarConcepto(comprobanteId, codProvee, c.codConcepto, c.descripcion)
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo asociar el concepto.')
      }
    })
  }

  return (
    <div className={styles.selector}>
      <input
        type="text"
        className={styles.buscador}
        placeholder="Buscar concepto por código o descripción…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className={styles.candidatos}>
        {conceptos === null && <li className={styles.vacio}>Cargando conceptos…</li>}
        {conceptos !== null && filtrados.length === 0 && (
          <li className={styles.vacio}>Ningún concepto coincide.</li>
        )}
        {filtrados.map((c) => (
          <li key={c.codConcepto}>
            <button
              type="button"
              disabled={pendiente}
              onClick={() => elegir(c)}
              className={styles.candidato}
            >
              <span className={styles.codigo}>{c.codConcepto}</span>
              <span className={styles.desc}>{c.descripcion}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
