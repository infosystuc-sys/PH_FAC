'use client'

import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { coincide } from '@/lib/resaltado'
import styles from './visor.module.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

// Escala fija: no hay controles de zoom (no se pidieron). 1.5 da una
// resolucion legible sin generar canvases enormes en comprobantes largos.
const ESCALA = 1.5

export function Visor({
  id,
  nombre,
  resaltar,
}: {
  id: number
  nombre: string
  resaltar: string | null
}) {
  const contenedor = useRef<HTMLDivElement>(null)
  const [paginas, setPaginas] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelado = false
    // La tarea de carga (no el documento) es lo que tiene destroy(): en
    // esta version de pdf.js PDFDocumentProxy no expone ese metodo, solo
    // lo hace el PDFDocumentLoadingTask que devuelve getDocument().
    const tareaCarga = pdfjs.getDocument({ url: `/api/pdf/${id}` })
    // Se guardan las tareas en curso para poder cancelarlas si el
    // componente se desmonta a mitad de una pagina: sin esto, un cambio
    // rapido de comprobante deja renders de pdf.js corriendo de fondo
    // sobre un <canvas> que ya no esta en el DOM.
    let tareaPagina: RenderTask | null = null
    let tareaTexto: { cancel: () => void } | null = null

    async function cargar() {
      // Se resetea antes del primer await: el efecto reacciona a un cambio
      // de `id` sin remontarse, asi que si no se limpia acá el error o la
      // cantidad de páginas del comprobante anterior quedan pegados encima
      // del siguiente mientras carga (o para siempre, si el siguiente sale
      // bien y nunca vuelve a tocar `error`). Tambien se limpian ya las
      // hojas viejas: si el comprobante nuevo falla, no tiene que quedar
      // el PDF del anterior renderizado detras del mensaje de error.
      setError(null)
      setPaginas(0)
      contenedor.current?.replaceChildren()
      try {
        const doc: PDFDocumentProxy = await tareaCarga.promise
        if (cancelado || !contenedor.current) return
        setPaginas(doc.numPages)
        contenedor.current.replaceChildren()

        for (let n = 1; n <= doc.numPages; n++) {
          if (cancelado) return
          const pagina = await doc.getPage(n)
          if (cancelado || !contenedor.current) return

          const viewport = pagina.getViewport({ scale: ESCALA })

          const hoja = document.createElement('div')
          hoja.className = styles.hoja
          hoja.style.width = `${viewport.width}px`
          hoja.style.height = `${viewport.height}px`

          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          hoja.appendChild(canvas)

          const capa = document.createElement('div')
          capa.className = `${styles.capaTexto} capa-texto-pdf`
          capa.style.width = `${viewport.width}px`
          capa.style.height = `${viewport.height}px`
          // pdf.js posiciona los spans en porcentaje del tamano de este
          // contenedor. Su propio constructor recalcula width/height con
          // un calc() que depende de --total-scale-factor: sin fijarlo
          // ese calc queda invalido y el contenedor se queda sin tamano,
          // desalineando toda la capa de texto respecto del canvas.
          capa.style.setProperty('--total-scale-factor', String(ESCALA))
          capa.style.setProperty('--scale-round-x', '1px')
          capa.style.setProperty('--scale-round-y', '1px')
          hoja.appendChild(capa)

          contenedor.current.appendChild(hoja)

          const tarea = pagina.render({ canvas, viewport })
          tareaPagina = tarea
          await tarea.promise
          tareaPagina = null
          if (cancelado) return

          const texto = await pagina.getTextContent()
          if (cancelado || !contenedor.current) return

          const capaTexto = new pdfjs.TextLayer({
            textContentSource: texto,
            container: capa,
            viewport,
          })
          tareaTexto = capaTexto
          await capaTexto.render()
          tareaTexto = null
        }
      } catch {
        if (!cancelado) setError('No se pudo abrir el PDF.')
      }
    }

    void cargar()
    return () => {
      cancelado = true
      tareaPagina?.cancel()
      tareaTexto?.cancel()
      void tareaCarga.destroy()
    }
  }, [id])

  // Resalta, dentro de la capa de texto de pdf.js, los spans cuyo
  // contenido coincide con el valor del campo enfocado. Recorre todas las
  // hojas (no solo la primera) porque un dato puede caer en cualquier
  // página de un comprobante largo. Si el PDF es escaneado no hay capa de
  // texto -- `querySelectorAll` no encuentra spans y el efecto no hace
  // nada, sin que eso sea un error.
  useEffect(() => {
    const capas = contenedor.current?.querySelectorAll('.capa-texto-pdf')
    if (!capas) return

    for (const capa of capas) {
      for (const span of capa.querySelectorAll('span')) {
        const marcar = resaltar !== null && coincide(span.textContent ?? '', resaltar)
        span.classList.toggle(styles.resaltado, marcar)
      }
    }
  }, [resaltar])

  return (
    <div className={styles.panel}>
      <div className={styles.barra}>
        <span className={styles.nombre}>{nombre}</span>
        <span className={styles.paginas}>
          {paginas === 0 ? 'Cargando…' : `${paginas} ${paginas === 1 ? 'página' : 'páginas'}`}
        </span>
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.hojas} ref={contenedor} />
    </div>
  )
}
