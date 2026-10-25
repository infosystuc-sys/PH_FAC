'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  guardarConfiguracionCarpetas,
  dispararEscaneoCarpetas,
  type ConfiguracionCarpetas,
} from '@/server/app/acciones'
import { useToast } from '@/components/toast/toast-provider'
import styles from './formulario-carpetas.module.css'

const FORMATO_FECHA = new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'medium' })

export function FormularioCarpetas({ config }: { config: ConfiguracionCarpetas }) {
  const [carpetaRaiz, setCarpetaRaiz] = useState(config.carpetaRaiz ?? '')
  const [intervaloMinutos, setIntervaloMinutos] = useState(String(config.intervaloMinutos))
  const [error, setError] = useState<string | null>(null)
  const [pendiente, arrancar] = useTransition()
  const [escaneando, arrancarEscaneo] = useTransition()
  const router = useRouter()
  const toast = useToast()

  function guardar() {
    setError(null)
    const minutos = Number(intervaloMinutos)
    arrancar(async () => {
      try {
        await guardarConfiguracionCarpetas(carpetaRaiz, minutos)
        toast('Configuración guardada.')
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo guardar la configuración.')
      }
    })
  }

  function escanearAhora() {
    arrancarEscaneo(async () => {
      await dispararEscaneoCarpetas()
      toast('Escaneo disparado — puede tardar unos segundos en reflejarse acá.')
    })
  }

  return (
    <section className={styles.tarjeta}>
      <div className={styles.campo}>
        <label className={styles.label} htmlFor="carpeta-raiz">
          Carpeta raíz
        </label>
        <input
          id="carpeta-raiz"
          className={styles.input}
          type="text"
          placeholder="\\SERVIDOR\Comprobantes o D:\Comprobantes"
          value={carpetaRaiz}
          onChange={(e) => setCarpetaRaiz(e.target.value)}
          disabled={pendiente}
        />
        <p className={styles.ayuda}>
          La app crea sola, adentro, las carpetas <code className={styles.code}>conceptos</code>,{' '}
          <code className={styles.code}>articulos</code>, <code className={styles.code}>tarjeta</code> y{' '}
          <code className={styles.code}>remito</code>. Vacía
          desactiva el escaneo automático.
        </p>
      </div>

      <div className={styles.campo}>
        <label className={styles.label} htmlFor="intervalo">
          Intervalo de escaneo (minutos)
        </label>
        <input
          id="intervalo"
          className={styles.inputChico}
          type="number"
          min={1}
          step={1}
          value={intervaloMinutos}
          onChange={(e) => setIntervaloMinutos(e.target.value)}
          disabled={pendiente}
        />
      </div>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.acciones}>
        <button type="button" className={styles.primario} onClick={guardar} disabled={pendiente}>
          {pendiente ? 'Guardando…' : 'Guardar'}
        </button>
        <button
          type="button"
          className={styles.secundario}
          onClick={escanearAhora}
          disabled={escaneando || !config.carpetaRaiz}
          title={config.carpetaRaiz ? undefined : 'Configurá y guardá una carpeta raíz primero'}
        >
          {escaneando ? 'Escaneando…' : 'Escanear ahora'}
        </button>
      </div>

      <div className={styles.estado}>
        {config.ultimoEscaneo ? (
          <>
            <span className={styles.estadoEtiqueta}>Último escaneo</span>
            <span className={styles.estadoValor}>{FORMATO_FECHA.format(config.ultimoEscaneo)}</span>
            <span className={styles.estadoResultado}>{config.ultimoResultado}</span>
          </>
        ) : (
          <span className={styles.estadoEtiqueta}>Todavía no corrió ningún escaneo.</span>
        )}
      </div>
    </section>
  )
}
