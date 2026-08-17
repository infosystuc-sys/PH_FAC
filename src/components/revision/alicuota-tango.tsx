'use client'

import { resolverCodigoIva, type AlicuotaTango } from '@/lib/alicuotas'
import { JURISDICCIONES_IIBB, resolverIibbPorTipo } from '@/lib/percepcionIibb'
import { parsearImporte } from '@/lib/formato'
import styles from './formulario.module.css'

type Tono = 'vacio' | 'ok' | 'alerta' | 'error'

function clasePorTono(tono: Tono): string {
  if (tono === 'ok') return styles.derivadoOk
  if (tono === 'alerta') return styles.derivadoAlerta
  if (tono === 'error') return styles.derivadoError
  return styles.derivadoVacio
}

/**
 * El código va primero porque la celda mide dos columnas (131px) y una
 * descripción como "PERCEPCION R.G.3337" no entra entera. Al recortarse se
 * pierde la cola, así que adelante tiene que ir el dato que se graba.
 */
function etiqueta(codigo: number | string, descripcion: string): string {
  return `${codigo} · ${descripcion}`
}

export type OpcionTango = { valor: string; label: string }

/**
 * La celda del medio de una fila de impuesto: a qué código de Tango va.
 *
 * Arranca mostrando lo que resolvió el sistema a partir de la columna de la
 * izquierda, y es una lista para que el operador lo corrija cuando la IA
 * leyó mal. Esa corrección se guarda aparte (codivaN / codpercepN) y gana
 * sobre lo resuelto; se limpia sola cuando cambia la columna izquierda, así
 * no queda un código viejo pegado a un dato que ya cambió.
 *
 * Va en Sans y no en Mono a propósito: la regla tipográfica del proyecto
 * reserva Mono para los datos que el operador cotejá contra el PDF, y esto
 * no está en el PDF -- es la clasificación que le pone Tango.
 */
function CeldaLista({
  opciones,
  valor,
  placeholder,
  tono,
  bloqueado,
  onCambio,
}: {
  opciones: OpcionTango[]
  /** El código elegido a mano, o el resuelto por el sistema. */
  valor: string
  /** Qué mostrar cuando no hay ninguno: "—", "No se registra", etc. */
  placeholder: string
  tono: Tono
  bloqueado: boolean
  onCambio: (v: string) => void
}) {
  return (
    <div className={styles.campo} style={{ gridColumn: 'span 2' }}>
      <span className={styles.label}>En Tango</span>
      <select
        className={`${styles.derivado} ${clasePorTono(tono)}`}
        value={valor}
        disabled={bloqueado}
        onChange={(e) => onCambio(e.target.value)}
      >
        <option value="">{placeholder}</option>
        {opciones.map((o) => (
          <option key={o.valor} value={o.valor}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Alícuota de IVA: la resuelve el PORCENTAJE, y el operador puede
 * corregirla.
 *
 * `importe` no se usa para resolver nada -- se usa para NO resolver. Esta
 * celda tiene que mostrar lo que se va a registrar, y `resolverAlicuotas`
 * descarta las líneas sin importe, así que una línea en cero no puede
 * mostrar un código ni marcarse en rojo. Pasa de verdad: hay comprobantes
 * que imprimen la tasa de una percepción con importe 0,00 (por ejemplo
 * "PERC IVA RG 2408 1,50% ... 0,00"), y esa línea salía en rojo como "Sin
 * código en Tango" pidiendo que el operador resolviera algo que no se iba
 * a grabar.
 */
export function CeldaAlicuotaTango({
  porcentaje,
  importe,
  correccion,
  alicuotas,
  bloqueado,
  onCambio,
}: {
  porcentaje: string
  importe: string
  correccion: string
  alicuotas: AlicuotaTango[]
  bloqueado: boolean
  onCambio: (v: string) => void
}) {
  const opciones = alicuotas.map((a) => ({
    valor: String(a.codigo),
    label: etiqueta(a.codigo, a.descripcion),
  }))

  const sinImporte = importe.trim() === '' || parsearImporte(importe) <= 0

  // Antes que todo lo demas, incluida la correccion manual: sin importe no
  // hay linea que grabar, y mostrar un codigo ahi seria mentir.
  if (sinImporte) {
    return (
      <CeldaLista
        opciones={opciones}
        valor=""
        placeholder="—"
        tono="vacio"
        bloqueado={bloqueado}
        onCambio={onCambio}
      />
    )
  }

  if (correccion) {
    return (
      <CeldaLista
        opciones={opciones}
        valor={correccion}
        placeholder="—"
        tono="ok"
        bloqueado={bloqueado}
        onCambio={onCambio}
      />
    )
  }

  const crudo = porcentaje.trim()
  const p = crudo === '' ? null : parsearImporte(crudo)

  // Norma de registración: la alícuota 0% no se graba. Se avisa acá mismo
  // para que el operador no descubra el faltante al registrar.
  if (p === 0) {
    return (
      <CeldaLista
        opciones={opciones}
        valor=""
        placeholder="No se registra"
        tono="alerta"
        bloqueado={bloqueado}
        onCambio={onCambio}
      />
    )
  }

  const encontrada = p === null ? null : resolverCodigoIva(p, alicuotas)
  return (
    <CeldaLista
      opciones={opciones}
      valor={encontrada ? String(encontrada.codigo) : ''}
      placeholder={p === null ? '—' : 'Sin código en Tango'}
      tono={encontrada ? 'ok' : p === null ? 'vacio' : 'error'}
      bloqueado={bloqueado}
      onCambio={onCambio}
    />
  )
}

/**
 * Percepción de Ingresos Brutos: la resuelve la JURISDICCIÓN, nunca el
 * porcentaje -- el 60 (Tucumán) y el 61 (Salta) son ambos 2,5%.
 */
export function CeldaPercepcionTango({
  jurisdiccion,
  importe,
  correccion,
  tipoFactura,
  bloqueado,
  onCambio,
}: {
  jurisdiccion: string
  importe: string
  correccion: string
  /** En tarjeta el IIBB va al 64 aunque la jurisdiccion diga otra cosa. */
  tipoFactura: string
  bloqueado: boolean
  onCambio: (v: string) => void
}) {
  const opciones = JURISDICCIONES_IIBB.map((j) => ({
    valor: j.codigo,
    label: etiqueta(j.codigo, j.jurisdiccion),
  }))

  // Mismo criterio que en IVA: sin importe no hay nada que registrar (ver
  // resolverPercepciones, que tambien descarta esas lineas).
  const sinImporte = importe.trim() === '' || parsearImporte(importe) <= 0
  const vacio = sinImporte || (jurisdiccion.trim() === '' && !correccion)
  // El slot vacio no muestra codigo. Hace falta decirlo explicito desde que
  // en tarjeta la resolucion tiene un fallback al 64: sin esto, las cuatro
  // filas de percepcion arrancarian mostrando "64 · Bancarias" aunque no
  // haya ninguna linea, que se lee como si hubiera algo para registrar.
  const elegido = vacio
    ? ''
    : correccion || resolverIibbPorTipo(jurisdiccion, tipoFactura)?.codigo || ''

  return (
    <CeldaLista
      opciones={opciones}
      valor={elegido}
      placeholder={vacio ? '—' : 'Jurisdicción no reconocida'}
      tono={elegido ? 'ok' : vacio ? 'vacio' : 'error'}
      bloqueado={bloqueado}
      onCambio={onCambio}
    />
  )
}

/**
 * Impuestos varios: el código ya se elige en la columna de la izquierda,
 * así que acá no hay nada que corregir -- solo se confirma qué es en Tango.
 */
export function CeldaVariosTango({
  codigo,
  codigos,
}: {
  codigo: string
  codigos: { codigo: number; descripcion: string }[]
}) {
  const crudo = codigo.trim()
  const encontrado = codigos.find((c) => String(c.codigo) === crudo)
  const texto = crudo === '' ? '—' : encontrado ? etiqueta(encontrado.codigo, encontrado.descripcion) : 'Sin código en Tango'
  const tono: Tono = crudo === '' ? 'vacio' : encontrado ? 'ok' : 'error'

  return (
    <div className={styles.campo} style={{ gridColumn: 'span 2' }}>
      <span className={styles.label}>En Tango</span>
      <div className={`${styles.derivado} ${clasePorTono(tono)}`} title={texto}>
        {texto}
      </div>
    </div>
  )
}

/**
 * El concepto de Tango asociado al proveedor. No es un campo: sale de la
 * ficha del proveedor en el ERP, no del PDF ni de una eleccion. Se muestra
 * porque es lo que se va a imputar en una factura de conceptos, y porque
 * un proveedor sin concepto configurado bloquea el registro -- mejor verlo
 * mientras se revisa que descubrirlo al final.
 */
export function CeldaConcepto({
  concepto,
  hayProveedor,
}: {
  concepto: { codConcepto: string; descripcion: string } | null
  hayProveedor: boolean
}) {
  const texto = concepto
    ? etiqueta(concepto.codConcepto, concepto.descripcion)
    : hayProveedor
      ? 'El proveedor no tiene concepto en Tango'
      : '—'
  const tono: Tono = concepto ? 'ok' : hayProveedor ? 'error' : 'vacio'

  return (
    <div className={styles.campo} style={{ gridColumn: 'span 3' }}>
      <span className={styles.label}>Concepto en Tango</span>
      <div className={`${styles.derivado} ${clasePorTono(tono)}`} title={texto}>
        {texto}
      </div>
    </div>
  )
}
