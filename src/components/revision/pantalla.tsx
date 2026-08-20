'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Formulario, type ValorInicial } from './formulario'
import { AvisoIA } from './aviso-ia'
import { PanelObservacion } from './panel-observacion'
import { PanelValidaciones } from './validaciones'
import { ListoParaRegistrar } from './listo-para-registrar'
import { Renglones } from './renglones'
import { Historial } from './historial'
import type { RenglonGuardado, EntradaAuditoria } from '@/server/app/detalle'
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
  iniciales,
  campos,
  ms,
  modelo,
  confianza,
  hayCorrecciones,
  renglones,
  auditoria,
  validaciones,
  listoParaRegistrar,
  condicionesCompra,
  codigosImpuesto,
  alicuotasIva,
  concepto,
  remitosPendientes,
  codProvee,
  motivoObservacion,
  notaObservacion,
  soloLectura = false,
}: {
  comprobanteId: number
  nombreArchivo: string
  iniciales: Record<string, ValorInicial>
  campos: number
  ms: number | null
  modelo: string | null
  confianza: number | null
  hayCorrecciones: boolean
  renglones: RenglonGuardado[]
  auditoria: EntradaAuditoria[]
  validaciones: Validaciones
  listoParaRegistrar: ResultadoListoParaRegistrar | null
  condicionesCompra: CondicionCompra[]
  codigosImpuesto: CodigoImpuesto[]
  alicuotasIva: AlicuotaTango[]
  concepto: { codConcepto: string; descripcion: string } | null
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

  return (
    <div className={styles.cuerpo}>
      <Visor id={comprobanteId} nombre={nombreArchivo} resaltar={enfocado} />
      <div className={styles.derecha}>
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
        {listoParaRegistrar && <ListoParaRegistrar resultado={listoParaRegistrar} />}
        <Formulario
          comprobanteId={comprobanteId}
          iniciales={iniciales}
          onEnfocar={setEnfocado}
          soloLectura={soloLectura}
          condicionesCompra={condicionesCompra}
          codigosImpuesto={codigosImpuesto}
          alicuotasIva={alicuotasIva}
          concepto={concepto}
        />
        <Renglones
          comprobanteId={comprobanteId}
          renglones={renglones}
          remitos={remitosPendientes}
          codProvee={codProvee}
          soloLectura={soloLectura}
        />
        <Historial entradas={auditoria} />
      </div>
    </div>
  )
}
