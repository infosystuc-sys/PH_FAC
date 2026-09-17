export type Estado =
  | 'procesando'
  | 'leido'
  | 'observacion'
  | 'confirmado'
  | 'registrado'
  | 'error'
  | 'existente'

export const ESTADOS: Record<Estado, { label: string; fondo: string; texto: string }> = {
  procesando:  { label: 'Procesando IA',          fondo: '#eceaf6', texto: '#4a3fa8' },
  leido:       { label: 'Pendiente de revisión',  fondo: '#e7eef9', texto: '#2b4fd0' },
  observacion: { label: 'En observación',         fondo: '#fbf0dc', texto: '#8a5a00' },
  confirmado:  { label: 'Confirmado',             fondo: '#e3f1ea', texto: '#1c7355' },
  registrado:  { label: 'Registrado en Tango',    fondo: '#17191d', texto: '#ffffff' },
  error:       { label: 'Error de lectura',       fondo: '#fae7e3', texto: '#a03526' },
  existente:   { label: 'Comprobante existente',  fondo: '#e8e6e1', texto: '#5a5347' },
}

/**
 * 'vincular' no es un estado: es un corte transversal (2026-09-17, pedido
 * del usuario). Son las facturas de articulos que tienen renglones sin
 * codigo de articulo y sin descripcion aprendida -- las que el operador
 * tiene que vincular a mano antes de poder imputarles la orden de compra.
 * Ver RENGLONES_A_VINCULAR en migrate.ts.
 */
export type ClaveTab = Estado | 'todos' | 'vincular'

export const ORDEN_TABS: { clave: ClaveTab; label: string }[] = [
  { clave: 'todos',       label: 'Todos' },
  { clave: 'leido',       label: 'Pendientes' },
  { clave: 'vincular',    label: 'A vincular' },
  { clave: 'observacion', label: 'En observación' },
  { clave: 'confirmado',  label: 'Confirmados' },
  { clave: 'registrado',  label: 'Registrados' },
  { clave: 'existente',   label: 'Comprobante existente' },
  { clave: 'error',       label: 'Con error' },
]

/** `existente` es terminal igual que `registrado`: la factura ya está en
 *  Tango, no hay ningún paso siguiente que dar desde esta app. */
export function esTerminal(e: Estado): boolean {
  return e === 'registrado' || e === 'existente'
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
