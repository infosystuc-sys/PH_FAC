'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { importarArcaDesdeTexto } from '@/server/app/acciones/configuracion'
import { formatMoneda } from '@/lib/formato'
import type { EstadoConciliacion } from '@/lib/conciliacion'
import styles from './panel.module.css'

/**
 * Lo que la pantalla necesita de cada fila conciliada. Llega aplanado
 * desde el server component: `ResultadoFila` trae los dos comprobantes
 * enteros y acá solo se muestran seis columnas.
 */
export type FilaVista = {
  estado: EstadoConciliacion
  fecha: string | null
  comprobante: string
  cuit: string
  razon: string
  importeArca: number | null
  importeTango: number | null
  diferencia: string | null
}

const ETIQUETA: Record<EstadoConciliacion, string> = {
  coincide: 'Coincide',
  'falta-en-tango': 'Falta en Tango',
  'falta-en-arca': 'No informado por ARCA',
  difiere: 'Difiere el importe',
}

/** El orden en que se muestran: primero lo que hay que resolver. */
const ORDEN: EstadoConciliacion[] = ['falta-en-tango', 'difiere', 'falta-en-arca', 'coincide']

export function PanelConciliacion({
  filas,
  resumen,
  importacion,
}: {
  filas: FilaVista[]
  resumen: Record<EstadoConciliacion, number>
  importacion: {
    archivoNombre: string
    desde: string | null
    hasta: string | null
    filas: number
    fechaAlta: string
    usuario: string
  } | null
}) {
  const router = useRouter()
  const archivo = useRef<HTMLInputElement>(null)
  const [pendiente, arrancar] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  // Arranca mostrando lo que hay que resolver: con miles de filas, abrir en
  // "todas" es abrir en una pared de coincidencias.
  const [verEstado, setVerEstado] = useState<EstadoConciliacion | 'todos'>('falta-en-tango')

  const visibles = useMemo(
    () => (verEstado === 'todos' ? filas : filas.filter((f) => f.estado === verEstado)),
    [filas, verEstado],
  )

  const subir = (f: File) => {
    setError(null)
    setAviso(null)
    arrancar(async () => {
      try {
        // Se manda en base64 y no como texto: el XLSX es binario y .text()
        // lo destruiria. Para el CSV da lo mismo, asi que no se bifurca.
        const bytes = new Uint8Array(await f.arrayBuffer())
        let binario = ''
        const TROZO = 8192
        for (let i = 0; i < bytes.length; i += TROZO) {
          binario += String.fromCharCode(...bytes.subarray(i, i + TROZO))
        }
        const r = await importarArcaDesdeTexto(f.name, btoa(binario))
        setAviso(
          `${r.filas} comprobante(s) importado(s)` +
            (r.ignoradas > 0 ? ` · ${r.ignoradas} fila(s) no se pudieron interpretar` : ''),
        )
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo leer el archivo.')
      }
    })
  }

  return (
    <div className={styles.panel}>
      <section className={styles.subir}>
        <div>
          <p className={styles.subirTitulo}>Archivo de ARCA</p>
          {importacion ? (
            <p className={styles.subirNota}>
              <span className={styles.mono}>{importacion.archivoNombre}</span> ·{' '}
              {importacion.filas} comprobantes · período{' '}
              <span className={styles.mono}>
                {importacion.desde} a {importacion.hasta}
              </span>{' '}
              · subido el <span className={styles.mono}>{importacion.fechaAlta}</span> por{' '}
              {importacion.usuario}
            </p>
          ) : (
            <p className={styles.subirNota}>
              Todavía no se subió ninguno. Descargá de ARCA &quot;Mis Comprobantes — Recibidos&quot;
              y subilo acá, en Excel (.xlsx) o en CSV.
            </p>
          )}
        </div>
        <div className={styles.subirAcciones}>
          <input
            ref={archivo}
            type="file"
            accept=".csv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className={styles.inputArchivo}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) subir(f)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            className={styles.botonSubir}
            disabled={pendiente}
            onClick={() => archivo.current?.click()}
          >
            {pendiente ? 'Leyendo…' : importacion ? 'Subir otro archivo' : 'Subir archivo'}
          </button>
        </div>
      </section>

      {error && <p className={styles.error}>{error}</p>}
      {aviso && <p className={styles.aviso}>{aviso}</p>}

      {importacion && (
        <>
          <div className={styles.resumen}>
            {ORDEN.map((e) => (
              <button
                key={e}
                type="button"
                className={`${styles.chip} ${styles[e]} ${verEstado === e ? styles.chipActivo : ''}`}
                onClick={() => setVerEstado(e)}
              >
                <span className={styles.chipNumero}>{resumen[e]}</span>
                {ETIQUETA[e]}
              </button>
            ))}
            <button
              type="button"
              className={`${styles.chip} ${verEstado === 'todos' ? styles.chipActivo : ''}`}
              onClick={() => setVerEstado('todos')}
            >
              <span className={styles.chipNumero}>{filas.length}</span>
              Todos
            </button>
          </div>

          {verEstado === 'falta-en-arca' && (
            <p className={styles.nota}>
              Están cargados en Tango y ARCA no los informa, dentro del período del archivo. Puede
              ser un comprobante cargado de más, o uno que el proveedor todavía no informó.
            </p>
          )}

          <table className={styles.tabla}>
            <thead>
              <tr>
                <th>Estado</th>
                <th>Fecha</th>
                <th>Comprobante</th>
                <th>CUIT</th>
                <th>Proveedor</th>
                <th className={styles.derecha}>ARCA</th>
                <th className={styles.derecha}>Tango</th>
              </tr>
            </thead>
            <tbody>
              {visibles.slice(0, 500).map((f, i) => (
                <tr key={i}>
                  <td>
                    <span className={`${styles.punto} ${styles[f.estado]}`}>{ETIQUETA[f.estado]}</span>
                  </td>
                  <td className={styles.mono}>{f.fecha ?? '—'}</td>
                  <td className={styles.mono}>{f.comprobante}</td>
                  <td className={styles.mono}>{f.cuit}</td>
                  <td>{f.razon}</td>
                  <td className={`${styles.mono} ${styles.derecha}`}>
                    {f.importeArca === null ? '—' : formatMoneda(f.importeArca)}
                  </td>
                  <td className={`${styles.mono} ${styles.derecha}`}>
                    {f.importeTango === null ? '—' : formatMoneda(f.importeTango)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {visibles.length === 0 && <p className={styles.nota}>No hay comprobantes en este estado.</p>}
          {visibles.length > 500 && (
            <p className={styles.nota}>
              Se muestran los primeros 500 de {visibles.length}.
            </p>
          )}
        </>
      )}
    </div>
  )
}
