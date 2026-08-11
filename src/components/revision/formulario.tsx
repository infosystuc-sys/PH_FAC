'use client'

import { useCallback, useMemo, useState } from 'react'
import { GRUPOS, camposDelGrupo, type GrupoCampo, type DefCampo } from '@/lib/campos'
import { guardarCampo } from '@/server/app/acciones'
import { totalImputado, formatMoneda } from '@/lib/formato'
import type { CondicionCompra } from '@/server/tango/condicionesCompra'
import type { CodigoImpuesto } from '@/server/tango/impuestos'
import { Campo } from './campo'
import styles from './formulario.module.css'

export type ValorInicial = { valor: string; confianza: number | null }

const MAX_SLOTS_ALICUOTA = 5

/**
 * Sobre 15.625 facturas reales: el slot 2 de alícuota se usa en el 19% de
 * los casos, el 3 en el 3,3%, el 4 en el 0,4%, y el 5 nunca. Mostrar los
 * cinco slots siempre seria ruido permanente en la pantalla donde el
 * operador pasa el 90% del tiempo, con 20 a 100 comprobantes por día.
 *
 * Punto de partida: los que la IA encontró con valor, más uno vacío para
 * poder agregar uno nuevo. De acá en más el piso de `slots` (ver `cambiar`
 * más abajo) solo crece -- nunca se recalcula desde cero ni se achica --
 * para que completar el slot vacío revele uno nuevo (la mitad del
 * comportamiento que hacía falta) sin reacomodar nada si el operador
 * borra un slot intermedio mientras escribe (la otra mitad).
 */
function contarSlotsAlicuota(iniciales: Record<string, ValorInicial>): number {
  let ultimoConValor = 0
  for (let i = 1; i <= MAX_SLOTS_ALICUOTA; i++) {
    const tienePorcentaje = (iniciales[`porciva${i}`]?.valor ?? '').trim() !== ''
    const tieneImporte = (iniciales[`impiva${i}`]?.valor ?? '').trim() !== ''
    if (tienePorcentaje || tieneImporte) ultimoConValor = i
  }
  return Math.min(MAX_SLOTS_ALICUOTA, ultimoConValor + 1)
}

const RE_SLOT_ALICUOTA = /^(?:porciva|impiva)([1-5])$/

type Opcion = { valor: string; label: string }

function opcionesPara(
  clave: string,
  condicionesCompra: CondicionCompra[],
  codigosIibb: CodigoImpuesto[],
): Opcion[] | undefined {
  if (clave === 'condcompra') {
    return condicionesCompra.map((c) => ({ valor: String(c.codigo), label: c.descripcion }))
  }
  if (clave === 'codpercibb') {
    return codigosIibb.map((c) => ({ valor: String(c.codigo), label: c.descripcion }))
  }
  if (clave === 'tipoFactura') {
    return [
      { valor: 'conceptos', label: 'Por conceptos' },
      { valor: 'articulos', label: 'Por artículos' },
      // Todavia no tiene logica de registro propia -- validarTipoFactura
      // bloquea el registro si se elige esta opcion. Se agrega igual al
      // selector porque el operador tiene que poder clasificar el
      // comprobante aunque el registro para este tipo llegue despues.
      { valor: 'tarjeta', label: 'Liquidación de tarjeta' },
    ]
  }
  return undefined
}

function camposVisibles(grupo: GrupoCampo, slots: number): DefCampo[] {
  const todos = camposDelGrupo(grupo)
  if (grupo !== 'importes') return todos
  return todos.filter((def) => {
    const m = RE_SLOT_ALICUOTA.exec(def.clave)
    return !m || Number(m[1]) <= slots
  })
}

export function Formulario({
  comprobanteId,
  iniciales,
  onEnfocar,
  soloLectura = false,
  condicionesCompra,
  codigosIibb,
}: {
  comprobanteId: number
  iniciales: Record<string, ValorInicial>
  onEnfocar: (texto: string | null) => void
  // El comprobante está en estado `registrado`: terminal e inmutable
  // (mismo criterio que ya aplica BarraAcciones deshabilitando el botón
  // primario con title="Ver asiento en Tango"). El backend ya bloquea la
  // escritura en guardarCampoEn (src/server/app/detalle.ts) con un no-op
  // silencioso; esto es puramente para que la UI no mienta mostrando el
  // campo como editable.
  soloLectura?: boolean
  // Poblado real de Tango para los campos `tipo: 'select'` del catálogo.
  // Ver Campo -- el resto de los campos los ignora.
  condicionesCompra: CondicionCompra[]
  codigosIibb: CodigoImpuesto[]
}) {
  const [valores, setValores] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(iniciales).map(([k, v]) => [k, v.valor])),
  )
  const [slots, setSlots] = useState(() => contarSlotsAlicuota(iniciales))

  const imputado = useMemo(() => formatMoneda(totalImputado(valores)), [valores])

  const cambiar = useCallback(
    (clave: string, v: string) => {
      setValores((prev) => (prev[clave] === v ? prev : { ...prev, [clave]: v }))

      // Si lo que se completó es un slot de alícuota y quedó con valor,
      // el piso de slots visibles crece para revelar el próximo vacío --
      // Math.max así nunca lo achica si en cambio se está borrando.
      const m = RE_SLOT_ALICUOTA.exec(clave)
      if (m && v.trim() !== '') {
        const siguiente = Math.min(MAX_SLOTS_ALICUOTA, Number(m[1]) + 1)
        setSlots((prev) => Math.max(prev, siguiente))
      }

      void guardarCampo(comprobanteId, clave, v)
    },
    [comprobanteId],
  )

  return (
    <div className={styles.panel}>
      <div className={styles.contenido}>
        {GRUPOS.map((g) => (
          <section key={g.clave} className={styles.tarjeta}>
            <h3 className={styles.tituloGrupo}>{g.titulo}</h3>
            <div className={styles.grilla}>
              {camposVisibles(g.clave, slots).map((def) =>
                // "Total imputado" no es un input: se recalcula en vivo a
                // partir de los demas campos del grupo. Un <input readOnly>
                // generico no serviria: Campo guarda su valor en estado
                // local para el autosave y ese estado no se resincroniza
                // con la prop despues del primer render, asi que nunca
                // reflejaria los cambios en neto/impivaN mientras se edita.
                def.clave === 'imputado' ? (
                  <div
                    key={def.clave}
                    className={styles.campo}
                    style={{ gridColumn: `span ${def.span}` }}
                  >
                    <span className={styles.label}>{def.label}</span>
                    <div className={styles.valorCalculado}>{imputado}</div>
                  </div>
                ) : (
                  <Campo
                    key={def.clave}
                    def={def}
                    valor={valores[def.clave] ?? ''}
                    confianza={iniciales[def.clave]?.confianza ?? null}
                    bloqueado={soloLectura}
                    opciones={opcionesPara(def.clave, condicionesCompra, codigosIibb)}
                    onCambio={(v) => cambiar(def.clave, v)}
                    onFoco={onEnfocar}
                    onDesenfoque={() => onEnfocar(null)}
                  />
                ),
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
