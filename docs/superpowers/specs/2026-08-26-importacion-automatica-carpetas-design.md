# Importación automática desde carpetas

**Fecha:** 2026-08-26
**Estado:** Aprobado, pendiente de implementación.

## Objetivo

Hoy el operador sube cada PDF a mano, uno por uno o en lote, eligiendo el tipo de comprobante en un modal (`ModalImportar`). Este feature agrega una segunda vía de entrada: la app vigila tres carpetas del sistema de archivos — una por tipo de comprobante — y cada cierto tiempo (configurable) importa sola lo que encuentre ahí, sin que el operador tenga que abrir la app para eso. Es aditivo: la carga manual sigue funcionando exactamente igual.

Pedido directo del usuario: "que la app busque en una carpeta los comprobantes y los analice por IA. La carpeta... debe ser configurable desde la app. Debes crear una carpeta por tipo de comprobante... La app debe buscar cada cierto período, configurable desde la app."

## Alcance

**Incluye:**
- Una carpeta raíz configurable desde una pantalla nueva (`/configuracion`), con tres subcarpetas fijas que la app crea sola: `conceptos/`, `articulos/`, `tarjeta/` (mismos valores que `TipoFactura`).
- Un ciclo periódico, con intervalo configurable en minutos desde la misma pantalla, que escanea las tres carpetas y reusa el pipeline de importación existente.
- Manejo de éxito/error/duplicado por archivo, con el PDF movido a una subcarpeta `procesados/` o `error/` según corresponda — nunca se reprocesa el mismo archivo dos veces.
- Un botón "Escanear ahora" en la pantalla de configuración, para no esperar al ciclo.

**No incluye:**
- Ningún cambio al flujo de carga manual ni al modal de importación existente.
- Ningún cambio a cómo la IA extrae los campos: el escaneo de carpetas produce la misma fila `PHF_COMPROBANTE` con `ESTADO='procesando'` que ya produce hoy `importarComprobanteEn`, y la sigue leyendo el worker de cola que **ya existe** (`tanda()`, cada 2 minutos, `cola.ts`) — cero código nuevo de IA.
- Subcarpetas o rutas configurables por separado para cada tipo: es una única raíz configurable, con subcarpetas fijas.
- Un flag explícito de encendido/apagado: sin carpeta raíz configurada, el ciclo simplemente no encuentra nada que escanear.
- Recursividad dentro de las carpetas de tipo: solo se listan archivos directamente adentro de `conceptos/`, `articulos/`, `tarjeta/` — nunca dentro de `procesados/`/`error/`, que son sus subcarpetas.

## Refactor previo: mover `importarComprobanteEn` de `acciones.ts` a `cola.ts`

`importarComprobanteEn` (hoy `acciones.ts:44-70`) ya hace exactamente lo que un archivo encontrado en una carpeta necesita: guarda el PDF (`guardarPdf`), inserta la fila en `PHF_COMPROBANTE` con `ESTADO='procesando'`, audita. Toma un `Buffer` plano — no depende de `File` del navegador — así que se puede llamar igual desde el escáner de carpetas.

El problema es de dirección de dependencias: en todo el proyecto, **solo los componentes cliente importan de `acciones.ts`** (`grep` confirmado: quince componentes lo hacen, ningún módulo de `src/server/` lo hace). `acciones.ts` es la capa `'use server'` que compone los módulos de abajo (`cola.ts`, `detalle.ts`, `archivos.ts`, etc.), nunca al revés — de hecho ya importa `despertarWorker` desde `cola.ts`. Si el nuevo `carpetas.ts` importara `importarComprobanteEn` de `acciones.ts`, invertiría esa regla para una sola función.

Se mueve `importarComprobanteEn` de `acciones.ts` a `cola.ts` (que ya es el dueño conceptual de "cómo entra un comprobante al pipeline" — ya tiene `tomarPendientesEn`, `procesarUno`, `despertarWorker`). `acciones.ts` pasa a importarla desde `cola.ts`, igual que ya hace con `despertarWorker`. El test `describe('importarComprobanteEn', ...)` (`tests/server/app/acciones.test.ts:31-90`) se mueve a `tests/server/app/cola.test.ts`, mismo contenido, import actualizado.

Sin cambios de comportamiento: es un `git mv` de función, no una reescritura.

## Duplicados: usar el hash que ya existe

`guardarPdf` (`archivos.ts:38-51`) ya calcula el SHA-256 del PDF y lo guarda en `PHF_COMPROBANTE.ARCHIVO_HASH` — hoy sin usar para nada. La carga manual no lo necesita (el operador ve lo que está subiendo), pero un escaneo automático sí: si el mismo PDF se dropea dos veces en la carpeta (por accidente, o porque un proceso de escaneo externo lo vuelve a copiar), no tiene que crear un segundo comprobante.

Nueva función en `detalle.ts` (ya es el módulo que hace lecturas sobre `PHF_COMPROBANTE` más allá del alta):

```ts
export async function buscarComprobantePorHashEn(e: Ejecutor, hash: string): Promise<number | null>
```

Un `SELECT TOP 1 ID FROM PHF_COMPROBANTE WHERE ARCHIVO_HASH = @hash`. Se usa solo desde el escaneo de carpetas — la carga manual no cambia.

## Tabla nueva: `PHF_CONFIGURACION`

Una sola fila fija (`ID=1`), primera tabla de configuración global de la app (hasta ahora todo lo que hacía falta vivía en variables de entorno).

```sql
CREATE TABLE PHF_CONFIGURACION (
  ID                  INT            NOT NULL,
  CARPETA_RAIZ        NVARCHAR(500)  NULL,
  INTERVALO_MINUTOS   INT            NOT NULL CONSTRAINT DF_PHF_CONFIG_INTERVALO DEFAULT 15,
  ULTIMO_ESCANEO      DATETIME2      NULL,
  ULTIMO_RESULTADO    NVARCHAR(500)  NULL,
  CONSTRAINT PK_PHF_CONFIGURACION PRIMARY KEY (ID),
  CONSTRAINT CK_PHF_CONFIGURACION_ID CHECK (ID = 1)
);
```

`CARPETA_RAIZ NULL` es el estado "sin configurar" (el ciclo no escanea nada). `ULTIMO_ESCANEO`/`ULTIMO_RESULTADO` existen para que el operador vea desde la pantalla si el ciclo corrió y qué encontró la última vez, sin tener que ir a mirar las carpetas a mano — importante porque corre sin supervisión.

Ninguna otra tabla `PHF_*` necesita una fila sembrada de entrada (todas arrancan vacías); esta sí. En vez de generalizar `Definicion` con un mecanismo de seed (nadie más lo necesita hoy — YAGNI), `migrar()` (`scripts/migrate.ts`) gana un paso puntual después de crear/reparar `PHF_CONFIGURACION`:

```sql
IF NOT EXISTS (SELECT 1 FROM PHF_CONFIGURACION WHERE ID = 1)
  INSERT INTO PHF_CONFIGURACION (ID, INTERVALO_MINUTOS) VALUES (1, 15);
```

Idempotente, como el resto de `migrar()`.

## `src/server/app/carpetas.ts` (nuevo)

```ts
export type ConfiguracionCarpetas = {
  carpetaRaiz: string | null
  intervaloMinutos: number
  ultimoEscaneo: Date | null
  ultimoResultado: string | null
}

export type ResultadoEscaneo = {
  importados: number
  duplicados: number
  errores: number
}

export async function leerConfiguracionCarpetasEn(e: Ejecutor): Promise<ConfiguracionCarpetas>

export async function guardarConfiguracionCarpetasEn(
  e: Ejecutor,
  carpetaRaiz: string | null,
  intervaloMinutos: number,
): Promise<void>

export async function escanearCarpetasEn(e: Ejecutor): Promise<ResultadoEscaneo>

/** Arranca el ciclo periodico en proceso. Se llama una vez desde instrumentation.ts. */
export function arrancarEscaneoCarpetas(): void

/** Dispara un escaneo ya, sin esperar al ciclo. Botón "Escanear ahora". */
export function escanearCarpetasAhora(): void
```

Mismo patrón `_En`/wrapper que el resto del proyecto: `guardarConfiguracionCarpetasEn` valida `intervaloMinutos >= 1` y recorta `carpetaRaiz` vacío a `null`. `Ejecutor` se declara local a este archivo (`type Ejecutor = { request(): sql.Request }`), como ya hace cada módulo de `src/server/app/` — no hay un tipo compartido, es una convención duplicada a propósito (`cola.ts:38`, `detalle.ts:52`, etc.).

### `escanearCarpetasEn`: el ciclo

Por cada `tipo` en `TIPOS_FACTURA` (conceptos/articulos/tarjeta), secuencial (no en paralelo — no es una ruta sensible a latencia, y procesar de a uno evita que dos copias del mismo PDF dropeadas en el mismo ciclo pasen el chequeo de duplicado a la vez antes de que la primera se haya commiteado):

1. **Asegurar la estructura**: `mkdir(path.join(raiz, tipo, 'procesados'), { recursive: true })` y lo mismo para `error` — crea `raiz/tipo/`, `raiz/tipo/procesados/` y `raiz/tipo/error/` de una sola vez si no existen. Si la raíz configurada no existe o no es accesible (ruta de red caída, por ejemplo), el `mkdir` tira — se captura por tipo, se anota en el resultado, y se sigue con el próximo tipo en vez de abortar todo el ciclo.
2. **Listar candidatos**: `readdir(path.join(raiz, tipo))` filtrado a `*.pdf`, top-level únicamente (nunca entra a `procesados/`/`error/`, así que un archivo movido no vuelve a aparecer en ningún escaneo futuro).
3. **Filtro de estabilidad**: se descarta (queda para el próximo ciclo) cualquier archivo cuyo `mtime` sea de menos de 10 segundos atrás — evita agarrar un PDF que un proceso externo todavía está terminando de copiar a la carpeta.
4. **Por archivo**: leer bytes, calcular hash (`createHash('sha256')`, mismo cálculo que `guardarPdf`), `buscarComprobantePorHashEn`:
   - Si ya existe: mover a `error/` con un `.txt` al lado (`"Ya se había importado antes: comprobante #<id>."`), contar como duplicado, no crear fila.
   - Si no existe: `importarComprobanteEn(e, nombre, datos, tipo)` (ahora en `cola.ts`) dentro de `conTransaccion`. Si tira, mover a `error/` con el mensaje de la excepción en el `.txt`, contar como error. Si sale bien, mover a `procesados/`, contar como importado.
5. Nombres en `procesados/`/`error/` llevan el timestamp del movimiento como prefijo (`20260826-143000-factura.pdf`) para que dos archivos con el mismo nombre en fechas distintas no se pisen.
6. Al final: si `importados > 0`, `despertarWorker()` una vez (mismo criterio que la carga manual: no hacer esperar a la IA el intervalo de la cola). Se actualiza `PHF_CONFIGURACION.ULTIMO_ESCANEO`/`ULTIMO_RESULTADO` con un resumen (`"3 importados, 1 duplicado, 0 errores"`).

### El ciclo periódico

```ts
let escaneando = false
let temporizadorCarpetas: ReturnType<typeof setTimeout> | null = null

async function cicloCarpetas(): Promise<void> {
  let minutos = 1
  try {
    const pool = await getPool()
    const config = await leerConfiguracionCarpetasEn(pool)
    minutos = config.intervaloMinutos > 0 ? config.intervaloMinutos : 1
    if (config.carpetaRaiz) await escanearCarpetasEn(pool)
  } catch {
    // Si la base no responde, el proximo ciclo reintenta.
  } finally {
    temporizadorCarpetas = setTimeout(() => void cicloCarpetas(), minutos * 60 * 1000)
  }
}

export function arrancarEscaneoCarpetas(): void {
  if (temporizadorCarpetas) return
  void cicloCarpetas()
}

export function escanearCarpetasAhora(): void {
  if (escaneando) return
  escaneando = true
  getPool()
    .then((pool) => escanearCarpetasEn(pool))
    .catch(() => {})
    .finally(() => { escaneando = false })
}
```

`setTimeout` recursivo, no `setInterval`: cada vuelta relee `INTERVALO_MINUTOS` de la base, así que si el operador cambia el número desde `/configuracion` aplica en el ciclo siguiente, sin reiniciar el servidor — mismo espíritu que ya vale para `arrancarWorker`, pero ese usa `setInterval` porque su intervalo (`INTERVALO_MS`) es una constante de código, no editable en caliente.

Igual que `tanda()` en `cola.ts`, `escanearCarpetasEn` no debe dejar escapar una excepción: los errores por tipo (carpeta inaccesible) se capturan adentro del loop de tipos, y cualquier error que se escape igual (falla de conexión al leer/escribir `PHF_CONFIGURACION`) se captura en el nivel más externo de la función, dejando el resultado anotado en `ULTIMO_RESULTADO` en vez de propagar — así ni `cicloCarpetas` ni `escanearCarpetasAhora` necesitan un `catch` para el caso general, el de arriba es solo defensa en profundidad.

`instrumentation.ts` gana una línea, mismo criterio que `arrancarWorker`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { arrancarWorker } = await import('@/server/app/cola')
    arrancarWorker()
    const { arrancarEscaneoCarpetas } = await import('@/server/app/carpetas')
    arrancarEscaneoCarpetas()
  }
}
```

## Server actions (`acciones.ts`)

Pasamanos finos, mismo criterio que `verAsiento`/`verCuotas`:

```ts
export async function leerConfiguracionCarpetas(): Promise<ConfiguracionCarpetas> {
  return leerConfiguracionCarpetasEn(await getPool())
}

export async function guardarConfiguracionCarpetas(
  carpetaRaiz: string | null,
  intervaloMinutos: number,
): Promise<void> {
  await guardarConfiguracionCarpetasEn(await getPool(), carpetaRaiz, intervaloMinutos)
  revalidatePath('/configuracion')
}

export async function dispararEscaneoCarpetas(): Promise<void> {
  escanearCarpetasAhora()
}
```

## UI

**Pantalla nueva `/configuracion`** (`src/app/configuracion/page.tsx`, Server Component): lee `leerConfiguracionCarpetas()` y pasa los valores a un formulario cliente nuevo (`src/components/configuracion/formulario-carpetas.tsx`, mismo patrón `useTransition`+`useToast` que el resto):
- Campo de texto para `carpetaRaiz` (placeholder tipo `\\SERVIDOR\Comprobantes` o `D:\Comprobantes`).
- Campo numérico para `intervaloMinutos` (mínimo 1).
- Botón "Guardar".
- Debajo, de solo lectura: último escaneo y resultado (`ultimoEscaneo`/`ultimoResultado`), o "Todavía no corrió ningún escaneo" si `ultimoEscaneo` es `null`.
- Botón "Escanear ahora", llama a `dispararEscaneoCarpetas()` y muestra un toast ("Escaneo disparado — puede tardar unos segundos en reflejarse.") — no espera el resultado en el mismo request, el resultado se ve la próxima vez que se refresca la pantalla.

**Link desde la bandeja**: en `src/app/comprobantes/page.tsx`, junto a `<BotonImportar />` en el `div.titulo`, un `<Link href="/configuracion">Configuración</Link>` simple, con una clase nueva en `page.module.css` (mismo estilo discreto que el resto de los links secundarios de la app).

## Testing

Contra archivos reales en una carpeta temporal (`fs.mkdtemp`, nunca contra las carpetas de producción configuradas), y contra la base real sin mocks (convención del proyecto):

- `carpetas.test.ts`:
  - `escanearCarpetasEn` crea las subcarpetas de estructura si no existen.
  - Un PDF válido en `articulos/` se importa (fila nueva en `PHF_COMPROBANTE` con `TIPO_FACTURA='articulos'`) y el archivo aparece movido a `articulos/procesados/`.
  - Un PDF con el mismo hash que un comprobante ya existente se mueve a `error/` con un `.txt` explicando el motivo, sin crear fila nueva.
  - Un archivo que no es PDF válido (bytes corruptos, o `guardarPdf`/`importarComprobanteEn` tira) se mueve a `error/` con el mensaje de la excepción.
  - Un archivo con `mtime` de hace menos de 10 segundos no se toca en ese ciclo.
  - Un archivo dentro de `procesados/` o `error/` nunca se vuelve a levantar en un escaneo posterior.
  - `guardarConfiguracionCarpetasEn` rechaza `intervaloMinutos < 1` y normaliza `carpetaRaiz=''` a `null`.
- `cola.test.ts`: se le suma el `describe('importarComprobanteEn', ...)` movido de `acciones.test.ts`, sin cambios de contenido.
- `detalle.test.ts`: `buscarComprobantePorHashEn` encuentra el ID correcto y devuelve `null` si no hay match.
- `migrate.test.ts`: `PHF_CONFIGURACION` se crea con su fila `ID=1` sembrada; correr `migrar()` de nuevo no duplica la fila ni falla.
