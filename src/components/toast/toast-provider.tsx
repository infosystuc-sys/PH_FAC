'use client'

import { createContext, useCallback, useContext, useRef, useState } from 'react'
import styles from './toast.module.css'

const ToastContext = createContext<((mensaje: string) => void) | null>(null)

const DURACION_MS = 2600

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [mensaje, setMensaje] = useState<string | null>(null)
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const mostrar = useCallback((m: string) => {
    clearTimeout(timeout.current)
    setMensaje(m)
    timeout.current = setTimeout(() => setMensaje(null), DURACION_MS)
  }, [])

  return (
    <ToastContext.Provider value={mostrar}>
      {children}
      {mensaje && <div className={styles.toast}>{mensaje}</div>}
    </ToastContext.Provider>
  )
}

export function useToast(): (mensaje: string) => void {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast debe usarse dentro de ToastProvider')
  return ctx
}
