/**
 * El set de íconos del sistema visual Rivai ERP (sección 6 del documento de
 * estilo), copiado tal cual: SVG 24×24 de línea, stroke 1.6, color del
 * texto. Un nombre desconocido cae en `help`.
 */
const ICONOS = {
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M2 12h3m14 0h3M4.2 19.8l2.1-2.1m11.4-11.4 2.1-2.1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>',
  logout: '<path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="m15 16 4-4-4-4"/><path d="M19 12H9"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  dotsV: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  download: '<path d="M12 4v12m-4-4 4 4 4-4"/><path d="M4 20h16"/>',
  upload: '<path d="M12 20V8m-4 4 4-4 4 4"/><path d="M4 4h16"/>',
  print: '<path d="M6 9V4h12v5"/><rect x="3" y="9" width="18" height="8" rx="1"/><path d="M6 17v4h12v-4"/>',
  edit: '<path d="m4 20 4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  trash: '<path d="M4 6h16"/><path d="M7 6V4h10v2"/><path d="M6 6v14h12V6"/><path d="M10 10v6M14 10v6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M4 16V4h12"/>',
  save: '<path d="M5 3h11l3 3v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8 3v6h8V3"/><rect x="7" y="13" width="10" height="7"/>',
  keyboard:
    '<rect x="2" y="6" width="20" height="12" rx="1"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M3 4h2l2.5 10h11L21 8H6"/>',
  file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
  fileText: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h4"/>',
  users: '<circle cx="9" cy="9" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="8" r="2.5"/>',
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4"/><path d="M12 11v10"/>',
  truck:
    '<path d="M3 6h11v10H3z"/><path d="M14 9h4l3 3v4h-7z"/><circle cx="7" cy="18" r="1.5"/><circle cx="17" cy="18" r="1.5"/>',
  wallet:
    '<path d="M3 7h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3z"/><path d="M3 7V5a2 2 0 0 1 2-2h11"/><circle cx="17" cy="13" r="1"/>',
  card: '<rect x="3" y="6" width="18" height="13" rx="1"/><path d="M3 10h18"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M7 16v-6M12 16V8M17 16v-4"/>',
  clipboard: '<rect x="6" y="4" width="12" height="18" rx="1"/><rect x="9" y="2" width="6" height="4" rx="1"/>',
  receipt: '<path d="M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1 2-1V3z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8v.01M11 12h1v5h1"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  sparkles: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  flash: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  building: '<path d="M3 21V7l9-4 9 4v14"/><path d="M9 10h.01M15 10h.01M9 14h.01M15 14h.01M9 18h6"/>',
  barcode: '<path d="M3 5v14M7 5v14M10 5v14M13 5v14M17 5v14M20 5v14"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8"/><path d="M10 12h4"/>',
  tag: '<path d="M20 12 12 20l-8-8V4h8z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
  refresh:
    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 4v4h-4"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 20v-4h4"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="1"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="1"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  arrowUpDown: '<path d="M7 15V5l-3 3M7 5l3 3"/><path d="M17 9v10l3-3M17 19l-3-3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17v.01"/>',
} as const

export type NombreIcono = keyof typeof ICONOS

export function Icono({
  nombre,
  size = 16,
  className,
}: {
  nombre: NombreIcono
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      className={className}
      aria-hidden="true"
      // El contenido es fijo, sale de la tabla de arriba: nunca de datos.
      dangerouslySetInnerHTML={{ __html: ICONOS[nombre] ?? ICONOS.help }}
    />
  )
}
