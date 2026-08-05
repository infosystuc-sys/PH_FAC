/**
 * Un renglón tal como lo devuelve la IA: todo texto, sin interpretar. El
 * parseo a número vive en `formato.ts`, igual que con los campos.
 */
export type RenglonExtraido = {
  codigo: string | null
  descripcion: string | null
  cantidad: string | null
  precioUnitario: string | null
  importe: string | null
}

export const CLAVES_RENGLON = [
  'codigo',
  'descripcion',
  'cantidad',
  'precioUnitario',
  'importe',
] as const
