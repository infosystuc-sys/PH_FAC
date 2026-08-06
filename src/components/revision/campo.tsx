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
  // Se prende en el onChange del input, nunca en un efecto. Es lo que
  // distingue "el operador escribió algo" de "este componente se montó".
  const tocado = useRef(false)

  // Autosave con debounce de 500 ms. El primer render no dispara guardado:
  // sin esta guarda, simplemente abrir la pantalla marcaria los 29 campos
  // como corregidos por el usuario. CORREGIDO_POR_USUARIO es el unico dato
  // con el que despues se mide que tan bien lee el modelo -- arruinarlo es
  // silencioso (nadie lo nota en el momento) e irreversible (no hay forma
  // de distinguir despues un "corregido" real de uno falso).
  //
  // La guarda NO puede ser un ref booleano "ya paso el primer render" (lo
  // era antes): React StrictMode (activo por default en el dev server)
  // duplica a proposito la primera pasada de todo efecto -- monta, limpia,
  // vuelve a montar -- y con un flag que se apaga en la primera invocacion
  // la segunda ya lo encuentra apagado y dispara un guardado fantasma.
  // Tampoco alcanza comparar `local` contra el valor inicial: si el
  // operador escribe algo, se guarda de verdad a los 500 ms, y despues se
  // arrepiente y borra hasta volver al valor original, `local` vuelve a
  // ser igual al inicial y esa comparacion bloquearia justo el guardado
  // que tiene que revertir lo que ya se grabó -- la pantalla mostraria el
  // valor original pero la base seguiria con la corrección vieja.
  //
  // Por eso la guarda sigue si HUBO un onChange, no si el valor cambió: el
  // doble montaje de Strict Mode nunca dispara un onChange (no toca el
  // input), así que el primer render sigue sin guardar; y un revert sí es
  // un onChange, así que se vuelve a guardar aunque el valor final
  // coincida con el inicial.
  useEffect(() => {
    if (!tocado.current) return
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
        onChange={(e) => {
          tocado.current = true
          setLocal(e.target.value)
        }}
        onFocus={() => onFoco(local)}
        onBlur={onDesenfoque}
      />
    </div>
  )
}
