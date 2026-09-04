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

/*
 * La escala sale del ancho real del panel, no de una constante. Antes era
 * fija en 1.5, que para una A4 da una hoja de 892px: el panel del PDF mide
 * ~420px (`minmax(420px, 44%)` en pantalla.module.css), asi que la hoja
 * nunca entraba y, al estar centrada, el operador veia solo una franja del
 * medio del comprobante -- ni siquiera en un monitor ancho entraba, porque
 * 44% de 1920px tampoco alcanza los 892px.
 *
 * ESCALA_MAX conserva el 1.5 de antes como techo: con el PDF en pantalla
 * completa no tiene sentido dibujar canvases mas grandes que eso.
 */
const ESCALA_MAX = 1.5

/** Piso: por debajo preferimos que desborde y se scrollee antes que dibujar algo ilegible. */
const ESCALA_MIN = 0.35

/** Un resize menor a esto no justifica re-renderizar todas las paginas (hay comprobantes de 48 hojas). */
const UMBRAL_RESIZE_PX = 8

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
  // Cuenta las páginas cuya capa de texto ya terminó de renderizarse. El
  // efecto de resaltado la usa como dependencia: sin esto, si el operador
  // enfoca un campo mientras todavía se están cargando las páginas
  // siguientes de un comprobante largo, esas páginas nunca quedan
  // resaltadas -- el efecto ya corrió (con los spans que existían en ese
  // momento) y no vuelve a correr solo porque aparecieron más spans en el
  // DOM. Cada página que termina su capa de texto empuja este contador,
  // lo que dispara una nueva pasada de resaltado sobre el estado actual.
  const [paginasConTexto, setPaginasConTexto] = useState(0)

  // Ancho util del panel, medido del DOM. `null` hasta la primera medicion:
  // sin ancho no se puede elegir la escala, asi que el render espera.
  //
  // No hay riesgo de bucle (medir -> renderizar mas ancho -> medir de
  // nuevo): `.hojas` es un bloque que toma el ancho del panel, y una hoja
  // mas ancha lo desborda en vez de estirarlo, asi que la medicion no
  // depende de lo que se dibuje adentro.
  const [ancho, setAncho] = useState<number | null>(null)
  useEffect(() => {
    const el = contenedor.current
    if (!el) return

    const medir = () => {
      const actual = el.clientWidth
      if (actual === 0) return
      setAncho((previo) =>
        previo !== null && Math.abs(previo - actual) < UMBRAL_RESIZE_PX ? previo : actual,
      )
    }

    medir()
    const observador = new ResizeObserver(medir)
    observador.observe(el)
    return () => observador.disconnect()
  }, [])

  useEffect(() => {
    if (ancho === null) return
    // Copia local: `cargar` lo usa adentro de un closure async y ahi se
    // pierde el estrechado de tipo del guard de arriba.
    const anchoPanel = ancho
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
      setPaginasConTexto(0)
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

          // La escala se calcula por pagina: un comprobante puede mezclar
          // hojas de distinto tamano (una A4 y un ticket largo), y lo que
          // tiene que entrar en el panel es cada una, no la primera.
          const base = pagina.getViewport({ scale: 1 })
          const escala = Math.min(ESCALA_MAX, Math.max(ESCALA_MIN, anchoPanel / base.width))
          const viewport = pagina.getViewport({ scale: escala })

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
          capa.style.setProperty('--total-scale-factor', String(escala))
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
          if (cancelado) return
          setPaginasConTexto((p) => p + 1)
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
    // `ancho` re-renderiza las hojas cuando cambia el ancho del panel: la
    // escala depende de el, y una hoja dibujada para el ancho anterior
    // queda chica o desbordada. El umbral de UMBRAL_RESIZE_PX evita que un
    // arrastre del borde de la ventana dispare una tanda por pixel.
  }, [id, ancho])

  // Resalta, dentro de la capa de texto de pdf.js, los spans cuyo
  // contenido coincide con el valor del campo enfocado. Recorre todas las
  // hojas (no solo la primera) porque un dato puede caer en cualquier
  // página de un comprobante largo. Si el PDF es escaneado no hay capa de
  // texto -- `querySelectorAll` no encuentra spans y el efecto no hace
  // nada, sin que eso sea un error.
  //
  // `paginasConTexto` está en las dependencias aunque no se lea en el
  // cuerpo: las capas de texto se renderizan de a una, en paralelo con
  // este efecto, así que un campo enfocado antes de que termine de cargar
  // el comprobante puede quedar corriendo con menos spans en el DOM que
  // los que hay un instante después. Sin esta dependencia, las páginas
  // que terminan de renderizarse después del enfoque quedan sin marcar
  // hasta que el operador desenfoca y vuelve a enfocar.
  useEffect(() => {
    const capas = contenedor.current?.querySelectorAll('.capa-texto-pdf')
    if (!capas) return

    for (const capa of capas) {
      for (const span of capa.querySelectorAll('span')) {
        const marcar = resaltar !== null && coincide(span.textContent ?? '', resaltar)
        span.classList.toggle(styles.resaltado, marcar)
      }
    }
  }, [resaltar, paginasConTexto])

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
