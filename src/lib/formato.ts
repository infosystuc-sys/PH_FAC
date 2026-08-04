const MONEDA = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatMoneda(n: number | null | undefined): string {
  if (n === null || n === undefined || n === 0) return '—'
  return `$ ${MONEDA.format(n)}`
}

export function formatFecha(d: Date | string | null | undefined): string {
  if (!d) return '—'
  const f = typeof d === 'string' ? new Date(`${d}T00:00:00`) : d
  if (Number.isNaN(f.getTime())) return '—'
  const dd = String(f.getDate()).padStart(2, '0')
  const mm = String(f.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${f.getFullYear()}`
}

export function normalizarCuit(c: string | null | undefined): string | null {
  if (!c) return null
  const soloDigitos = c.replace(/\D/g, '')
  return soloDigitos.length === 11 ? soloDigitos : null
}

export function formatCuit(c: string | null | undefined): string {
  if (!c) return '—'
  const n = normalizarCuit(c)
  if (!n) return c
  return `${n.slice(0, 2)}-${n.slice(2, 10)}-${n.slice(10)}`
}
