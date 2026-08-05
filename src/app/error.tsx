'use client'

import { useEffect } from 'react'
import styles from './error.module.css'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Error no manejado en la UI:', error)
  }, [error])

  return (
    <main className={styles.main}>
      <div className={styles.tarjeta}>
        <span className={styles.punto} />
        <h1 className={styles.titulo}>No se pudo mostrar esta pantalla</h1>
        <p className={styles.texto}>
          Hubo un error inesperado. Puede ser que se haya cortado la conexión con el servidor de
          Tango (SQL Server) — fijate el indicador de conexión arriba a la derecha.
        </p>
        <button type="button" className={styles.boton} onClick={() => reset()}>
          Reintentar
        </button>
      </div>
    </main>
  )
}
