export type Estado =
  | 'procesando'
  | 'leido'
  | 'observacion'
  | 'confirmado'
  | 'registrado'
  | 'error'

export const ESTADOS: Record<Estado, { label: string; fondo: string; texto: string }> = {
  procesando:  { label: 'Procesando IA',          fondo: '#eceaf6', texto: '#4a3fa8' },
  leido:       { label: 'Pendiente de revisión',  fondo: '#e7eef9', texto: '#2b4fd0' },
  observacion: { label: 'En observación',         fondo: '#fbf0dc', texto: '#8a5a00' },
  confirmado:  { label: 'Confirmado',             fondo: '#e3f1ea', texto: '#1c7355' },
  registrado:  { label: 'Registrado en Tango',    fondo: '#17191d', texto: '#ffffff' },
  error:       { label: 'Error de lectura',       fondo: '#fae7e3', texto: '#a03526' },
}

export type ClaveTab = Estado | 'todos'

export const ORDEN_TABS: { clave: ClaveTab; label: string }[] = [
  { clave: 'todos',       label: 'Todos' },
  { clave: 'leido',       label: 'Pendientes' },
  { clave: 'observacion', label: 'En observación' },
  { clave: 'confirmado',  label: 'Confirmados' },
  { clave: 'registrado',  label: 'Registrados' },
  { clave: 'error',       label: 'Con error' },
]

export function esTerminal(e: Estado): boolean {
  return e === 'registrado'
}

/**
 * Valida el `filtro` que llega por searchParams (bandeja y pantalla de
 * revisión, para la navegación J/K con el mismo contexto de filtro): un
 * valor ausente o desconocido cae a 'todos' en vez de romper.
 */
export function leerFiltro(v: string | undefined): ClaveTab {
  const valido = ORDEN_TABS.some((t) => t.clave === v)
  return valido ? (v as ClaveTab) : 'todos'
}

export function permiteRegistrar(e: Estado): boolean {
  return e === 'confirmado'
}
