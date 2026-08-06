'use client'

import { useEffect, useRef, useState } from 'react'
import type { DefCampo } from '@/lib/campos'
import { nivelConfianza } from '@/lib/confianza'
import styles from './formulario.module.css'

export function Campo({
  def,
  valor,
  confianza,
  onCambio,
  onFoco,
  onDesenfoque,
}: {
  def: DefCampo
  valor: string
  confianza: number | null
  onCambio: (v: string) => void
  onFoco: (v: string) => void
  onDesenfoque: () => void
}) {
  const [local, setLocal] = useState(valor)
  // Snapshot inmutable del valor con el que se montó el campo. Sirve para
  // no autoguardar mientras `local` siga siendo ese mismo valor.
  const inicial = useRef(valor)

  // Autosave con debounce de 500 ms. El primer render no dispara guardado:
  // sin esta guarda, simplemente abrir la pantalla marcaria los 29 campos
  // como corregidos por el usuario. CORREGIDO_POR_USUARIO es el unico dato
  // con el que despues se mide que tan bien lee el modelo -- arruinarlo es
  // silencioso (nadie lo nota en el momento) e irreversible (no hay forma
  // de distinguir despues un "corregido" real de uno falso).
  //
  // La guarda NO puede ser un ref booleano "ya paso el primer render":
  // React StrictMode (activo por default en el dev server) duplica a
  // proposito la primera pasada de todo efecto -- monta, limpia, vuelve a
  // montar -- para exponer justamente este tipo de bug. Con un flag que se
  // apaga en la primera invocacion, la SEGUNDA pasada de StrictMode ya lo
  // encuentra apagado y dispara un autoguardado fantasma en los 29 campos
  // sin que el operador haya tocado nada (se confirmo en la base durante
  // la verificacion). Comparar contra un snapshot inmutable del valor
  // inicial es indiferente a cuantas veces se invoca el efecto: mientras
  // `local` siga siendo el mismo valor con el que se montó, no hay nada
  // que guardar.
  useEffect(() => {
    if (local === inicial.current) return
    const t = setTimeout(() => onCambio(local), 500)
    return () => clearTimeout(t)
  }, [local, onCambio])

  const baja = confianza !== null && confianza < 0.8
  // Igual que ChipConfianza: confianza null (campo sin lectura de IA) o
  // >= 1 (resuelto por el sistema, no por el modelo) oculta el chip.
  const nivel = confianza === null || confianza >= 1 ? null : nivelConfianza(confianza)

  return (
    <div className={styles.campo} style={{ gridColumn: `span ${def.span}` }}>
      <label className={styles.label} htmlFor={`campo-${def.clave}`}>
        {def.label}
        {nivel && (
          <span className={styles.chip} style={{ background: nivel.fondo, color: nivel.texto }}>
            {Math.round(confianza! * 100)}%
          </span>
        )}
      </label>
      <input
        id={`campo-${def.clave}`}
        className={[
          styles.input,
          def.mono ? styles.mono : '',
          baja ? styles.baja : '',
          def.soloLectura ? styles.soloLectura : '',
        ]
          .filter(Boolean)
          .join(' ')}
        value={local}
        readOnly={def.soloLectura}
        onChange={(e) => setLocal(e.target.value)}
        onFocus={() => onFoco(local)}
        onBlur={onDesenfoque}
      />
    </div>
  )
}
