'use client'

import { useRef, useState, useTransition } from 'react'
import { vistaPreviaDnrpa, aplicarDnrpa, type VistaPreviaDnrpa, type ResumenDnrpa } from '@/server/app/acciones/dnrpa'
import { ETIQUETA_DNRPA, type EstadoDnrpa } from '@/lib/dnrpa'
import { ACCEPT_ARCHIVOS, NOMBRES_ADMITIDOS } from '@/lib/tipoArchivo'
import styles from './panel.module.css'

/** Primero lo que se va a grabar, después lo que hay que mirar. */
const ORDEN: EstadoDnrpa[] = ['cargar', 'otro', 'no-encontrada', 'varios-articulos', 'repetida', 'invalida', 'igual']

/**
 * Subir el archivo → vista previa → confirmar → resumen (2026-11-18). Nada se
 * graba hasta "Cargar DNRPA", y solo las filas en "Se carga": las que ya
 * tienen otro comentario, las que no están en Tango y las dudosas se
 * muestran y no se tocan (decisión del usuario).
 */
export function PanelDnrpa() {
  const archivo = useRef<HTMLInputElement>(null)
  const [vista, setVista] = useState<VistaPreviaDnrpa | null>(null)
  const [resumen, setResumen] = useState<ResumenDnrpa | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [leyendo, arrancarLectura] = useTransition()
  const [grabando, arrancarGrabado] = useTransition()

  const subir = (f: File) => {
    setError(null)
    setResumen(null)
    setVista(null)
    arrancarLectura(async () => {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        let binario = ''
        const TROZO = 8192
        for (let i = 0; i < bytes.length; i += TROZO) binario += String.fromCharCode(...bytes.subarray(i, i + TROZO))
        setVista(await vistaPreviaDnrpa(f.name, btoa(binario)))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo leer el archivo.')
      }
    })
  }

  const aCargar = vista?.filas.filter((f) => f.estado === 'cargar') ?? []
  const filas = vista ? [...vista.filas].sort((a, b) => ORDEN.indexOf(a.estado) - ORDEN.indexOf(b.estado)) : []
  const cuenta = (e: EstadoDnrpa) => vista?.filas.filter((f) => f.estado === e).length ?? 0

  const confirmar = () => {
    setError(null)
    arrancarGrabado(async () => {
      try {
        const r = await aplicarDnrpa(aCargar.map((f) => ({ chasis: f.chasis, dnrpa: f.dnrpa })))
        setResumen(r)
        setVista(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo grabar el DNRPA.')
      }
    })
  }

  return (
    <div className={styles.panel}>
      <section className={styles.subir}>
        <div>
          <p className={styles.subirTitulo}>Mail con los certificados</p>
          <p className={styles.subirNota}>
            {vista ? (
              <>
                <span className={styles.mono}>{vista.archivo}</span> · {vista.filas.length} unidad(es) leída(s)
              </>
            ) : (
              `En ${NOMBRES_ADMITIDOS}: la tabla "Detalles de Certificados Nacionales" con NRO DE CHASIS y NRO DNRPA.`
            )}
          </p>
        </div>
        <div className={styles.subirAcciones}>
          <input
            ref={archivo}
            type="file"
            accept={ACCEPT_ARCHIVOS}
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
            disabled={leyendo || grabando}
            onClick={() => archivo.current?.click()}
          >
            {leyendo ? 'Leyendo con IA…' : vista ? 'Subir otro archivo' : 'Subir archivo'}
          </button>
        </div>
      </section>

      {error && <p className={styles.error}>{error}</p>}

      {resumen && (
        <p className={styles.aviso}>
          DNRPA cargado en {resumen.cargadas} serie(s): {resumen.filasSta06} fila(s) de series en stock (STA06) y{' '}
          {resumen.filasSta07} de movimientos (STA07).
          {resumen.cambiaron.length > 0 &&
            ` ${resumen.cambiaron.length} no se cargaron porque cambiaron desde la vista previa: ` +
              resumen.cambiaron.map((c) => `${c.chasis} (${ETIQUETA_DNRPA[c.estado].toLowerCase()})`).join(', ') +
              '.'}
        </p>
      )}

      {vista && (
        <>
          <div className={styles.resumen}>
            {ORDEN.filter((e) => cuenta(e) > 0).map((e) => (
              <span key={e} className={`${styles.chip} ${styles[e]}`}>
                <span className={styles.chipNumero}>{cuenta(e)}</span>
                {ETIQUETA_DNRPA[e]}
              </span>
            ))}
          </div>

          <table className={styles.tabla}>
            <thead>
              <tr>
                <th>Estado</th>
                <th>Modelo</th>
                <th>Nro motor</th>
                <th>Nro de chasis</th>
                <th>Nro DNRPA</th>
                <th>Artículo</th>
                <th>Comentario actual</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f, i) => (
                <tr key={i}>
                  <td>
                    <span className={`${styles.punto} ${styles[f.estado]}`}>{ETIQUETA_DNRPA[f.estado]}</span>
                  </td>
                  <td>{f.modelo}</td>
                  <td className={styles.mono}>{f.motor}</td>
                  <td className={styles.mono}>{f.chasis || '—'}</td>
                  <td className={styles.mono}>{f.dnrpa || '—'}</td>
                  <td className={styles.mono}>{f.codArticu ?? '—'}</td>
                  <td className={styles.mono}>{f.comentarioActual ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className={styles.pie}>
            <p className={styles.nota}>
              Revisá chasis y DNRPA contra el mail: los leyó la IA. Solo se graban las filas en &quot;Se carga&quot;, en
              la serie en stock y en todos sus movimientos. Las demás no se tocan.
            </p>
            <button
              type="button"
              className={styles.botonPrimario}
              disabled={aCargar.length === 0 || grabando || leyendo}
              onClick={confirmar}
            >
              {grabando ? 'Grabando…' : `Cargar DNRPA en ${aCargar.length} serie(s)`}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
