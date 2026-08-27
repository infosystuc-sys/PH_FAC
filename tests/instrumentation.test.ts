import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const RAIZ = path.resolve(__dirname, '..')

/**
 * `instrumentation.ts` vivió en la raíz del proyecto durante toda la sesión
 * en que se construyó el escaneo automático de carpetas -- pero este
 * proyecto usa `src/` (`src/app`, `src/server`, etc.), y Next.js exige que
 * el hook de instrumentación viva *adentro* de `src/` cuando el proyecto
 * usa esa convención. En la ubicación equivocada, Next.js no tira ningún
 * error: simplemente nunca lo ejecuta. El síntoma real fue que el ciclo
 * periódico de `arrancarEscaneoCarpetas` (y el de `arrancarWorker`) nunca
 * corrió ni una sola vez -- lo único que funcionaba era el botón manual
 * "Escanear ahora", que no depende de instrumentation.ts.
 *
 * Este test no puede probar que Next.js *ejecuta* el hook (eso requeriría
 * un server real), pero sí puede evitar que alguien vuelva a moverlo al
 * lugar equivocado sin que nada lo señale.
 */
describe('instrumentation.ts vive donde Next.js lo espera', () => {
  it('existe en src/, no en la raíz del proyecto', () => {
    expect(existsSync(path.join(RAIZ, 'src', 'instrumentation.ts'))).toBe(true)
    expect(existsSync(path.join(RAIZ, 'instrumentation.ts'))).toBe(false)
  })

  it('arranca tanto el worker de la cola como el escaneo de carpetas', () => {
    const contenido = readFileSync(path.join(RAIZ, 'src', 'instrumentation.ts'), 'utf-8')
    expect(contenido).toContain('arrancarWorker')
    expect(contenido).toContain('arrancarEscaneoCarpetas')
  })
})
