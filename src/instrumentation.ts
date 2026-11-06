export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Una instancia de prueba (otra copia de la app contra la misma base)
    // no tiene que tomar comprobantes de la cola ni escanear las carpetas:
    // los procesaria en paralelo con la de produccion (2026-11-05).
    if (process.env.PHF_SIN_WORKER === '1') return
    const { arrancarWorker } = await import('@/server/app/cola')
    arrancarWorker()
    const { arrancarEscaneoCarpetas } = await import('@/server/app/carpetas')
    arrancarEscaneoCarpetas()
  }
}
