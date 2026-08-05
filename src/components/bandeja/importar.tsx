'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { importarComprobantes } from '@/server/app/acciones'
import styles from './importar.module.css'

export function BotonImportar() {
  const [abierto, setAbierto] = useState(false)
  return (
    <>
      <button type="button" className={styles.primario} onClick={() => setAbierto(true)}>
        + Importar PDF
      </button>
      {abierto && <ModalImportar onCerrar={() => setAbierto(false)} />}
    </>
  )
}

function ModalImportar({ onCerrar }: { onCerrar: () => void }) {
  const [archivos, setArchivos] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pendiente, arrancar] = useTransition()
  const input = useRef<HTMLInputElement>(null)
  const router = useRouter()

  function agregar(lista: FileList | null) {
    if (!lista) return
    const pdfs = Array.from(lista).filter((f) => f.type === 'application/pdf')
    setArchivos((a) => [...a, ...pdfs].slice(0, 50))
    setError(pdfs.length === lista.length ? null : 'Se ignoraron archivos que no son PDF.')
  }

  function importar() {
    if (archivos.length === 0) return
    const fd = new FormData()
    for (const a of archivos) fd.append('archivos', a)

    arrancar(async () => {
      try {
        await importarComprobantes(fd)
        onCerrar()
        router.push('/comprobantes?filtro=leido')
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudieron importar los archivos.')
      }
    })
  }

  return (
    <div className={styles.overlay} onClick={onCerrar}>
      <div className={styles.caja} onClick={(e) => e.stopPropagation()}>
        <div className={styles.encabezado}>
          <h2 className={styles.titulo}>Importar comprobantes</h2>
          <button type="button" className={styles.cerrar} onClick={onCerrar} aria-label="Cerrar">
            ✕
          </button>
        </div>

        <div
          className={styles.dropzone}
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            agregar(e.dataTransfer.files)
          }}
        >
          <div className={styles.icono}>⇪</div>
          <div className={styles.dzTitulo}>Arrastrá los PDF acá</div>
          <div className={styles.dzDetalle}>
            o hacé clic para elegirlos · hasta 50 archivos · PDF, máx. 10 MB c/u
          </div>
        </div>

        <input
          ref={input}
          type="file"
          accept="application/pdf"
          multiple
          hidden
          onChange={(e) => agregar(e.target.files)}
        />

        {archivos.length > 0 && (
          <div className={styles.lista}>
            {archivos.map((a, i) => (
              <div key={`${a.name}-${i}`} className={styles.fila}>
                <span className={styles.etiqueta}>PDF</span>
                <span className={styles.nombre}>{a.name}</span>
                <span className={styles.estado}>{pendiente ? 'Subiendo…' : 'Listo para importar'}</span>
              </div>
            ))}
          </div>
        )}

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.acciones}>
          <button type="button" className={styles.secundario} onClick={onCerrar} disabled={pendiente}>
            Cancelar
          </button>
          <button
            type="button"
            className={styles.primario}
            onClick={importar}
            disabled={pendiente || archivos.length === 0}
          >
            {pendiente ? 'Importando…' : `Importar ${archivos.length || ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
