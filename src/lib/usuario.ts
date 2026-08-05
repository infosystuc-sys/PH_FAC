import os from 'node:os'

/**
 * Usuario para la auditoria. Toma el usuario de Windows del proceso.
 *
 * Limitacion conocida: si la app se sirve desde un servidor, esto devuelve
 * la cuenta del servicio, no la del operador. Vale mientras cada operador
 * corra la app en su propia PC. PHF_USUARIO permite forzar el valor.
 */
export function usuarioActual(): string {
  const forzado = process.env.PHF_USUARIO?.trim()
  if (forzado) return forzado
  try {
    return os.userInfo().username
  } catch {
    return 'desconocido'
  }
}
