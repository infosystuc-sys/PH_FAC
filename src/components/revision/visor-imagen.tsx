'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './visor.module.css'

/**
 * El visor para un comprobante que llegó como imagen (JPG o PNG) en vez de
 * PDF -- admitidos desde el 2026-09-16, pedido del usuario.
 *
 * Es la versión mínima del `Visor` de PDF: misma barra, misma pantalla
 * completa (botón, Ctrl+M y Esc), misma hoja centrada. Lo que no tiene es
 * el resaltado del campo enfocado: eso se apoya en la capa de texto que
 * pdf.js extrae del PDF, y una foto no tiene texto que extraer. El
 * operador coteja mirando, igual que con un papel.
 */
export function VisorImagen({ id, nombre }: { id: number; nombre: string }) {
  const panel = useRef<HTMLDivElement>(null)
  const [completa, setCompleta] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const alternarPantallaCompleta = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    } else {
      void panel.current?.requestFullscreen().catch(() => {})
    }
  }, [])

  useEffect(() => {
    const alCambiar = () => setCompleta(document.fullscreenElement === panel.current)
    document.addEventListener('fullscreenchange', alCambiar)
    return () => document.removeEventListener('fullscreenchange', alCambiar)
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault()
        alternarPantallaCompleta()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [alternarPantallaCompleta])

  return (
    <div className={styles.panel} ref={panel}>
      <div className={styles.barra}>
        <span className={styles.nombre}>{nombre}</span>
        <span className={styles.paginas}>imagen</span>
        <button
          type="button"
          className={styles.pantallaCompleta}
          onClick={alternarPantallaCompleta}
          title={completa ? 'Salir (Esc)' : 'Ver la imagen en pantalla completa (Ctrl+M)'}
        >
          {completa ? 'Salir' : 'Pantalla completa'}
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.hojas}>
        {/* eslint-disable-next-line @next/next/no-img-element -- es un archivo
            servido por la propia app, no una URL externa que optimizar. */}
        <img
          className={styles.imagen}
          src={`/api/pdf/${id}`}
          alt={nombre}
          onError={() => setError('No se pudo cargar la imagen del comprobante.')}
        />
      </div>
    </div>
  )
}
