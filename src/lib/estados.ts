export type Estado =
  | 'procesando'
  | 'leido'
  | 'observacion'
  | 'confirmado'
  | 'registrado'
  | 'error'
  | 'existente'

/**
 * Colores de los EstadoPill del sistema visual Rivai ERP (2026-10-17): fondo
 * "soft" y texto del tono. Confirmado va en primario --es el paso previo a
 * registrar--, registrado en exito, y existente (terminal, no lo hizo esta
 * app) apagado.
 */
export const ESTADOS: Record<Estado, { label: string; fondo: string; texto: string }> = {
  procesando:  { label: 'Procesando IA',          fondo: 'var(--ai-soft)',      texto: 'var(--ai)' },
  leido:       { label: 'Pendiente de revisión',  fondo: 'var(--info-soft)',    texto: 'var(--info)' },
  observacion: { label: 'En observación',         fondo: 'var(--warning-soft)', texto: 'var(--warning)' },
  confirmado:  { label: 'Confirmado',             fondo: 'var(--primary-soft)', texto: 'var(--primary)' },
  registrado:  { label: 'Registrado en Tango',    fondo: 'var(--success-soft)', texto: 'var(--success)' },
  error:       { label: 'Error de lectura',       fondo: 'var(--danger-soft)',  texto: 'var(--danger)' },
  existente:   { label: 'Comprobante existente',  fondo: 'var(--bg-sunken)',    texto: 'var(--text-muted)' },
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
