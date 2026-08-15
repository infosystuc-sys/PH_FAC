'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { importarComprobantes } from '@/server/app/acciones'
import { useToast } from '@/components/toast/toast-provider'
import { TIPOS_FACTURA, TIPO_FACTURA_DEFAULT, type TipoFactura } from '@/lib/tipoFactura'
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
  const [tipo, setTipo] = useState<TipoFactura>(TIPO_FACTURA_DEFAULT)
  const [error, setError] = useState<string | null>(null)
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()
  const toast = useToast()

  function agregar(lista: FileList | null) {
    if (!lista) return
    const pdfs = Array.from(lista).filter((f) => f.type === 'application/pdf')
    setArchivos((a) => [...a, ...pdfs].slice(0, 50))
    setError(pdfs.length === lista.length ? null : 'Se ignoraron archivos que no son PDF.')
  }

  function importar() {
    if (archivos.length === 0) return
    const fd = new FormData()
    fd.append('tipoFactura', tipo)
    for (const a of archivos) fd.append('archivos', a)

    arrancar(async () => {
      try {
        const { importados } = await importarComprobantes(fd)
        toast(`${importados} comprobante${importados === 1 ? '' : 's'} importado${importados === 1 ? '' : 's'}.`)
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

        <div className={styles.tipos}>
          <span className={styles.tiposTitulo}>Tipo de comprobante</span>
          <p className={styles.tiposAclaracion}>
            Define cómo lee la IA el lote entero. Si mezclás tipos, importalos por separado.
          </p>
          {TIPOS_FACTURA.map((t) => (
            <button
              key={t.clave}
              type="button"
              className={`${styles.tipo} ${tipo === t.clave ? styles.tipoElegido : ''}`}
              onClick={() => setTipo(t.clave)}
              disabled={pendiente}
              aria-pressed={tipo === t.clave}
            >
              <span className={styles.tipoLabel}>{t.label}</span>
              <span className={styles.tipoAyuda}>{t.ayuda}</span>
            </button>
          ))}
        </div>

        {/* El input va ANTES del label y solo oculto a la vista, no con
            `hidden`. Dos motivos: `hidden` lo saca del orden de
            tabulación, y abrir el selector de archivos con un
            `input.click()` por JavaScript depende de que el navegador
            acepte esa activación programática -- que es justamente lo que
            fallaba. Con `htmlFor` la vinculación es nativa: el click en el
            label abre el diálogo sin que intervenga JavaScript. Estando
            primero, además, el `+` del CSS puede dibujarle el foco al
            label cuando el input recibe el foco por teclado. */}
        <input
          id="importar-archivos"
          className={styles.inputArchivo}
          type="file"
          accept="application/pdf"
          multiple
          onChange={(e) => agregar(e.target.files)}
        />

        <label
          htmlFor="importar-archivos"
          className={styles.dropzone}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            agregar(e.dataTransfer.files)
          }}
        >
          <span className={styles.icono}>⇪</span>
          <span className={styles.dzTitulo}>Arrastrá los PDF acá</span>
          <span className={styles.dzDetalle}>
            o hacé clic para elegirlos · hasta 50 archivos · PDF, máx. 10 MB c/u
          </span>
        </label>

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
