'use client'

import { useState, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { Formulario, type ValorInicial } from './formulario'
import { AvisoIA } from './aviso-ia'
import { PanelObservacion } from './panel-observacion'
import { PanelValidaciones } from './validaciones'
import { ListoParaRegistrar } from './listo-para-registrar'
import { Renglones } from './renglones'
import { RenglonesOc } from './renglones-oc'
import { Cargos } from './cargos'
import { SelectorOc } from './selector-oc'
import { Historial } from './historial'
import { VisorImagen } from './visor-imagen'
import type { RenglonGuardado, RenglonPdfGuardado, CargoGuardado, EntradaAuditoria } from '@/server/app/detalle'
import type { Validaciones, ResultadoListoParaRegistrar } from '@/server/app/validaciones'
import type { CondicionCompra } from '@/server/tango/condicionesCompra'
import type { CodigoImpuesto } from '@/server/tango/impuestos'
import type { AlicuotaTango } from '@/lib/alicuotas'
import type { RemitoPendiente } from '@/server/tango/remitos'
import styles from './pantalla.module.css'

/**
 * pdf.js toca APIs de navegador (`DOMMatrix`) al evaluarse el módulo. Que
 * el Visor sea 'use client' no alcanza para evitarlo: Next igual lo
 * renderiza del lado del servidor en el primer paso, y ese require
 * explota ahí con "DOMMatrix is not defined" -- el Visor nunca había
 * estado montado dentro del árbol de una página hasta esta pantalla, así
 * que el problema estaba latente. Se importa dinámico con `ssr: false`
 * para que el módulo (y pdf.js con él) recién se cargue en el navegador.
 * No se toca visor.tsx: el problema es de dónde se monta, no de cómo
 * está escrito.
 */
const Visor = dynamic(() => import('./visor').then((m) => m.Visor), { ssr: false })

/** La preferencia vale para toda la sesión, no para un comprobante. */
const CLAVE_PDF_OCULTO = 'phf.pdfOculto'

/**
 * Contenedor cliente del cuerpo de dos paneles. Sostiene el estado del
 * campo enfocado y se lo pasa al Visor para que resalte, en la capa de
 * texto del PDF, la zona que corresponde al campo que el operador está
 * mirando en el Formulario.
 *
 * El panel derecho es un único scroll (`.derecha`) que aloja, en orden,
 * el aviso de lectura IA, el Formulario (que no se toca: trae su propio
 * fondo/padding, revisados y aprobados en una tarea anterior), los
 * renglones si los hay, y el historial. No se envuelve todo en un
 * contenedor con su propio padding para no duplicar el que ya aplica
 * Formulario: cada pieza nueva (AvisoIA, Renglones, Historial) reproduce
 * el mismo padding horizontal de 24px y el mismo max-width de 760px por
 * su cuenta, así los bordes de las tarjetas alinean con los de Formulario
 * aunque estén fuera de su `contenido`.
 */
export function Pantalla({
  comprobanteId,
  nombreArchivo,
  esImagen,
  iniciales,
  campos,
  ms,
  modelo,
  confianza,
  hayCorrecciones,
  renglones,
  renglonesPdf,
  cargos,
  auditoria,
  validaciones,
  listoParaRegistrar,
  condicionesCompra,
  codigosImpuesto,
  alicuotasIva,
  concepto,
  conceptos,
  aprendidosIva,
  aprendidosPercepcion,
  aprendidosVarios,
  remitosPendientes,
  codProvee,
  motivoObservacion,
  notaObservacion,
  soloLectura = false,
}: {
  comprobanteId: number
  nombreArchivo: string
  /** El archivo es JPG/PNG: va al visor de imagen, sin capa de texto. */
  esImagen: boolean
  iniciales: Record<string, ValorInicial>
  campos: number
  ms: number | null
  modelo: string | null
  confianza: number | null
  hayCorrecciones: boolean
  renglones: RenglonGuardado[]
  /** Lo que la IA leyó del PDF, con precio y subtotal impresos. Solo artículos. */
  renglonesPdf: RenglonPdfGuardado[]
  cargos: CargoGuardado[]
  auditoria: EntradaAuditoria[]
  validaciones: Validaciones
  listoParaRegistrar: ResultadoListoParaRegistrar | null
  condicionesCompra: CondicionCompra[]
  codigosImpuesto: CodigoImpuesto[]
  alicuotasIva: AlicuotaTango[]
  concepto: { codConcepto: string; descripcion: string } | null
  /** El maestro de conceptos, para elegir otro solo para este comprobante. */
  conceptos: { codConcepto: string; descripcion: string }[]
  /**
   * Lo que este proveedor ya le enseñó a la app para IVA e IIBB (ver
   * aprendizajeImpuestos.ts), para que las celdas "En Tango" propongan en
   * vivo el mismo código que va a resolver el registro real.
   */
  aprendidosIva: Record<string, string>
  aprendidosPercepcion: Record<string, string>
  aprendidosVarios: Record<string, string>
  /**
   * Los remitos con saldo del proveedor. Los usa la tarjeta de renglones
   * para ofrecer, en cada uno, a qué renglón de remito reapuntarlo.
   */
  remitosPendientes: RemitoPendiente[]
  /** El proveedor ya resuelto, para buscar y asociar artículos en Tango. */
  codProvee: string | null
  // Por que esta en observacion. Va arriba de todo porque explica el
  // estado del comprobante entero, no un campo.
  motivoObservacion: string | null
  notaObservacion: string | null
  // Comprobante `registrado`: terminal e inmutable. Se pasa a Formulario
  // para que los inputs queden de solo lectura (ver comentario ahí); el
  // backend ya bloquea la escritura de todos modos, esto es solo UI.
  soloLectura?: boolean
}) {
  const [enfocado, setEnfocado] = useState<string | null>(null)

  // Arranca SIEMPRE con el PDF visible y recien despues lee la preferencia,
  // en un efecto: leer localStorage durante el render rompe la hidratacion
  // (el servidor no lo tiene y pintaria distinto que el cliente).
  const [pdfOculto, setPdfOculto] = useState(false)
  useEffect(() => {
    setPdfOculto(window.localStorage.getItem(CLAVE_PDF_OCULTO) === '1')
  }, [])

  // La preferencia se guarda porque el operador navega entre comprobantes
  // con J/K todo el dia: si se reseteara en cada uno, esconder el PDF no
  // serviria de nada.
  const alternarPdf = useCallback(() => {
    setPdfOculto((previo) => {
      const siguiente = !previo
      window.localStorage.setItem(CLAVE_PDF_OCULTO, siguiente ? '1' : '0')
      return siguiente
    })
  }, [])

  // Ctrl+P, con el mismo criterio que Ctrl+Enter y Ctrl+O (ver atajos.ts):
  // sin guard de foco, porque el operador tiene el cursor en un campo casi
  // todo el tiempo y Ctrl no escribe un caracter literal.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        alternarPdf()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [alternarPdf])

  return (
    <div className={`${styles.cuerpo} ${pdfOculto ? styles.sinPdf : ''}`}>
      {/* Desmontado y no escondido con CSS: el Visor carga pdf.js y renderiza
          la pagina, trabajo que no tiene sentido hacer para algo invisible. */}
      {/* Una imagen (JPG/PNG) no tiene capa de texto que resaltar: va al
          visor simple. El tipo sale de la extension con la que se guardo. */}
      {!pdfOculto &&
        (esImagen ? (
          <VisorImagen id={comprobanteId} nombre={nombreArchivo} />
        ) : (
          <Visor id={comprobanteId} nombre={nombreArchivo} resaltar={enfocado} />
        ))}
      <div className={styles.derecha}>
        <div className={styles.barraVista}>
          <button
            type="button"
            className={styles.alternarPdf}
            onClick={alternarPdf}
            title="Ctrl+P"
          >
            {pdfOculto ? 'Mostrar PDF' : 'Ocultar PDF'}
          </button>
        </div>
        <PanelObservacion motivo={motivoObservacion} nota={notaObservacion} />
        <AvisoIA
          id={comprobanteId}
          campos={campos}
          ms={ms}
          modelo={modelo}
          confianza={confianza}
          hayCorrecciones={hayCorrecciones}
        />
        <PanelValidaciones comprobanteId={comprobanteId} validaciones={validaciones} />
        {listoParaRegistrar && (
          <ListoParaRegistrar
            comprobanteId={comprobanteId}
            resultado={listoParaRegistrar}
            tipoFactura={iniciales.tipoFactura?.valor || null}
            codProvee={codProvee}
          />
        )}
        <Formulario
          comprobanteId={comprobanteId}
          iniciales={iniciales}
          onEnfocar={setEnfocado}
          soloLectura={soloLectura}
          condicionesCompra={condicionesCompra}
          codigosImpuesto={codigosImpuesto}
          alicuotasIva={alicuotasIva}
          concepto={concepto}
          conceptos={conceptos}
          aprendidosIva={aprendidosIva}
          aprendidosPercepcion={aprendidosPercepcion}
          aprendidosVarios={aprendidosVarios}
        />
        {/* Solo en articulos: es el paso que reemplaza al remito como
            origen del detalle, y va antes de Renglones porque los define. */}
        {iniciales.tipoFactura?.valor === 'articulos' && (
          <SelectorOc
            comprobanteId={comprobanteId}
            codProvee={codProvee}
            soloLectura={soloLectura}
            // Ensenar una descripcion se permite siempre: es conocimiento
            // del proveedor y sirve para las facturas que vengan, no un
            // cambio de este comprobante (2026-10-07, decision del
            // usuario). Ver puedeVincular en selector-oc.tsx.
            permitirVincular
          />
        )}
        {/* Va antes de Renglones porque en tarjeta es la tarjeta con el
            detalle del comprobante, y en tarjeta no hay renglones. */}
        <Cargos
          comprobanteId={comprobanteId}
          cargos={cargos}
          netoVigente={iniciales.neto?.valor ?? null}
          soloLectura={soloLectura}
        />
        {/* Con una OC imputada, la tarjeta muestra la factura y la orden lado
            a lado (decision del usuario, 2026-09-15). La de remito sigue para
            los comprobantes que quedaron en ese circuito. */}
        {renglones.some((r) => r.ocNOrdenCo !== null) ? (
          <RenglonesOc
            renglones={renglones}
            renglonesPdf={renglonesPdf}
            descuentoGeneral={iniciales.descuentogeneral?.valor ?? null}
            netoFactura={iniciales.neto?.valor ?? null}
            // La base que implica el IVA, ya calculada por el servidor con las
            // mismas lineas que valida el panel: es la evidencia con la que
            // se decide si los subtotales son netos o brutos.
            baseSegunImpuestos={listoParaRegistrar?.netoSegunIva ?? null}
          />
        ) : (
          <Renglones
            comprobanteId={comprobanteId}
            renglones={renglones}
            remitos={remitosPendientes}
            codProvee={codProvee}
            netoFactura={iniciales.neto?.valor ?? null}
            soloLectura={soloLectura}
          />
        )}
        <Historial entradas={auditoria} />
      </div>
    </div>
  )
}
