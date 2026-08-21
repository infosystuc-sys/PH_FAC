# Vista previa del asiento contable

**Fecha:** 2026-08-21
**Estado:** Aprobado, pendiente de implementación.

## Objetivo

Durante la revisión de un comprobante, el operador quiere ver **qué asiento contable generaría Tango** si se registrara ahora — cuenta por cuenta, Debe y Haber — sin tener que confirmarlo ni registrarlo primero. Es una vista previa de solo lectura: no escribe nada, ni en `PHF_*` ni en el ERP.

Hoy la app no toca la contabilización: `registrarComprobanteEn` deja `CONTABILIZ = 0` y un proceso aparte de Tango genera el asiento real más tarde (`ASIENTO_COMPROBANTE_CP`, fuera de alcance — ver el spec original §2). Esta vista previa **no lee ni escribe esa tabla**: la calcula desde cero, simulando el motor de asientos de Tango con sus propias tablas de configuración.

## Alcance

**Incluye:** un botón "Ver asiento" en la pantalla de revisión que abre un modal de solo lectura con las líneas del asiento que correspondería al comprobante tal como está cargado en este momento (con las correcciones del operador ya aplicadas).

**No incluye:**
- Registrar el asiento en Tango, ni escribir `ASIENTO_COMPROBANTE_CP` ni ninguna otra tabla.
- Flete, Intereses ni Bonificación de cabecera (`TIPO_CONTABLE` los prevé, pero la app no captura esos tres como campo — decisión del usuario, 2026-08-21: se omiten).
- Una cuenta corriente específica por proveedor para la línea "Total del comprobante": no se encontró ninguna tabla que la vincule: usa la cuenta del modelo (20002 · PROVEEDORES) siempre.
- Modelos de asiento distintos del `1` ("FACTURAS / NOTAS DE DEBITO") — es el único que pidió el usuario.

## Excepción a la regla de tablas documentadas

`CLAUDE.md` exige que solo se toquen tablas listadas en la documentación de Axoft para Compras o Stock. De las tablas que hacen falta acá:

| Tabla | Módulo documentado |
|---|---|
| `RENGLON_MODELO_CP` | Compras |
| `CONCEPTO_CP` | Compras |
| `ARTICULO_CUENTA` | Stock |
| `TIPO_CONTABLE` | **Ninguno** (se revisó Compras, Stock, Contabilidad, Procesos generales, Administrador) |
| `CUENTA` | **Ninguno** (mismas páginas revisadas) |
| `ASIENTO_MODELO_CP` | **Ninguno** (existe `ASIENTO_MODELO`, sin el sufijo `_CP`, documentado en Contabilidad — es una tabla distinta) |

Decisión del usuario (2026-08-21), ya reflejada en `CLAUDE.md`: las tres últimas son tablas de configuración real del motor contable — no espejos `CTA*` — y se autorizan **de solo lectura**.

## Los datos reales del modelo 1

Verificado contra la base (`PUNTO_HOGAR_1`). El modelo `1` (`ASIENTO_MODELO_CP.COD_ASIENTO_MODELO_CP='01'`, `DESC_ASIENTO_MODELO_CP='FACTURAS / NOTAS DE DEBITO'`) tiene 26 renglones en `RENGLON_MODELO_CP`. Los que la app puede completar con datos que ya captura:

| `TIPO_CONTABLE.COD_TIPO_CONTABLE` | Descripción | Cuenta modelo | D/H | Reemplaza cuenta | De dónde sale en la app |
|---|---|---|---|---|---|
| `SB` | Subtotal gravado | 120 · COMPRAS - MERCADERIA | D | **Sí** | `neto` |
| `EX` | Subtotal exento | 120 · COMPRAS - MERCADERIA | D | **Sí** | `exento` |
| `1`/`2`/`3`/`4` | IVA 21/0/10,5/27% | 93 · DGI - IVA CREDITO FISCAL | D | No | `porciva1..5`/`impiva1..5`, vía `resolverAlicuotas` |
| `15`/`16`/`17` | Percepción R.G.3337 / Percep. de IVA / Retención IVA | 95 / 95 / 94 | D | No | `TIPO_ALI='IV'` en `CPA14`, igual que los códigos `1`-`4`: si algún slot `porciva1..5` trae 3% (el porcentaje de esta percepción), `resolverAlicuotas` lo resuelve a estos códigos por el mismo mecanismo de match-por-porcentaje que usa para el IVA -- no pasan por "Impuestos varios" (`listarCodigosImpuesto` los excluye, filtra solo `IB`/`II`/`OT`) |
| `60`/`61`/`62`/`68` | Percepción IIBB Tuc./Salta/CABA/Formosa | 99 · PERCEPCIONES SUFRIDAS IIBB | D | No | `percep1..4`/`imppercep1..4`, vía `resolverPercepciones` |
| resto (`52..59`, `63..67`) | Retenciones e impuestos varios | según el renglón | D | No | `varios1..2`/`impvarios1..2`, vía `resolverVarios` |
| `TO` | Total del comprobante | 155 · PROVEEDORES | **H** | Sí (no implementado — ver Alcance) | `total` |

`FL`/`IN`/`BO` (Flete/Intereses/Bonificación) existen en el modelo pero se omiten (Alcance).

**El hallazgo que simplifica todo:** los códigos de `TIPO_CONTABLE.COD_TIPO_CONTABLE` para IVA (`1`-`4`) y percepción IIBB (`60`,`61`,`62`,`68`) son **los mismos códigos de `CPA14`** que ya usan `porciva1..5`/`codpercibb` en el formulario. No hace falta ningún mapeo nuevo: el código que ya resuelve `resolverAlicuotas`/`resolverPercepciones`/`resolverVarios` (las mismas funciones de `src/lib/` que usa `registrarComprobanteEn`) es directamente la clave para buscar en `TIPO_CONTABLE`.

## Motor: `src/server/tango/asiento.ts` (nuevo, solo lectura)

```ts
export type LineaAsiento = {
  codCuenta: string
  descCuenta: string
  leyenda: string
  debe: number   // 0 si esta linea es de Haber
  haber: number  // 0 si esta linea es de Debe
}

export type AsientoPreview = {
  lineas: LineaAsiento[]
  totalDebe: number
  totalHaber: number
  balanceado: boolean  // |totalDebe - totalHaber| < 0.01
}

export async function previsualizarAsiento(comprobanteId: number): Promise<AsientoPreview>
```

Pasos:

1. **Cargar el modelo** (una sola query, cacheable en memoria del proceso si hace falta más adelante — no por ahora, YAGNI): `RENGLON_MODELO_CP` JOIN `TIPO_CONTABLE` JOIN `CUENTA`, filtrado a `ID_ASIENTO_MODELO_CP = 1`. Arma un `Map<codTipoContable, {codCuenta, descCuenta, leyenda, dh}>`.

2. **Cargar el comprobante**: `obtenerDetalleEn`/`obtenerDetalle` (ya existe, `src/server/app/detalle.ts`) trae campos y renglones. Se arma el mismo `Record<clave, valorFinal>` que ya arma `registrarComprobanteEn`.

3. **Armar la lista de `{codTipoContable, importe, dh}` a partir de los campos**, reusando sin modificar:
   - `neto`/`exento` → `SB`/`EX` (antes de aplicar el reemplazo de cuenta, ver paso 4).
   - `resolverAlicuotas(valores, await listarAlicuotasIva())` → una entrada por línea con `estado='registra'`, código = `alicuota.codigo` (as string).
   - `resolverPercepciones(valores, tipoFactura)` → una entrada por línea con `estado='registra'`, código = `codigo.codigo`.
   - `resolverVarios(valores, await listarCodigosImpuesto())` → ídem, código = `codigo`.
   - `total` → `TO`.

   A diferencia de `registrarComprobanteEn`, acá **no se bloquea** si alguna línea queda `sin-codigo`: es una vista previa, tiene que poder mostrarse aunque el comprobante todavía no esté listo para registrar. Una línea sin código resuelto se **omite** del asiento -- su importe sigue estando en el total de cabecera, así que el asiento puede salir desbalanceado; `AsientoPreview.lineasOmitidas` cuenta cuántas líneas se omitieron por esto, para que el aviso de "no cierra" pueda distinguirlo de un problema real de importes.

4. **Resolver el reemplazo de cuenta de `SB`/`EX`** (`REEMPLAZA_CUENTA='S'`):
   - `tipoFactura IN ('conceptos','tarjeta')`: `conceptoDelComprobante(tipoFactura, codProvee)` (ya existe) da el concepto; se busca en `CONCEPTO_CP` por `ID_CPA45` (mismo `ID_CPA45` que ya resuelve `buscarConceptoProveedor`/`buscarConceptoTarjeta`) su `ID_CUENTA`. Un único concepto por comprobante (1:1 verificado), así que `SB` y `EX` van los dos a esa cuenta, sin split.
   - `tipoFactura = 'articulos'`: por cada renglón (`codigoFinal ?? codigo`), resolver `ARTICULO_CUENTA.ID_CUENTA_COMPRAS` (join por `COD_STA11`). Agrupar renglones por cuenta resuelta y sumar `IMPORTE_IA` por grupo → una línea de Debe por cada cuenta distinta. Si hay más de un grupo, `EX` usa la cuenta del grupo con mayor importe (simplificación: la app no distingue qué renglones son "exentos" a nivel de renglón, ver "Simplificaciones"). Si hay un solo grupo (caso dominante: 9.059/9.060 artículos comparten la cuenta 120), `EX` usa esa misma cuenta sin ambigüedad.
   - `tipoFactura` sin elegir, o sin dato para resolver: se usa la cuenta del modelo (120) para `SB`/`EX`, sin bloquear la vista previa.

5. **Armar las líneas finales**: por cada `{codTipoContable, importe, dh}` con `importe > 0`, buscar en el `Map` del modelo la cuenta/descripción/leyenda (con el reemplazo del paso 4 si aplica), y emitir una `LineaAsiento`. Sumar Debe y Haber, marcar `balanceado`.

## Server action

`src/server/app/acciones.ts` gana un pasamanos fino:

```ts
export async function verAsiento(comprobanteId: number): Promise<AsientoPreview> {
  return previsualizarAsiento(comprobanteId)
}
```

Mismo criterio que el resto del archivo: los componentes cliente importan todo de `acciones.ts`, nunca de `src/server/tango/` directo.

## UI

- **Botón "Ver asiento"** en la barra de acciones de la pantalla de revisión (`barra-acciones.tsx` o el lugar equivalente donde viven "Confirmar datos"/"Marcar en observación"), visible siempre que el comprobante esté en revisión (no depende de que esté "listo para registrar" — es justamente para revisar antes de eso).
- Al click, un componente cliente nuevo (`ver-asiento.tsx`, mismo patrón de `useTransition`+`useToast` que `actualizar-remito.tsx`) llama a `verAsiento(comprobanteId)` y abre un **modal** (mismo patrón visual que `modal-observacion.tsx`) con:
  - Tabla: Cuenta (código + descripción) · Leyenda · Debe · Haber, en IBM Plex Mono para los importes.
  - Fila de totales al pie.
  - Si `!balanceado`: aviso visible (mismo tono que `.difiere` en `renglones.module.css`) — no debería pasar nunca si los datos son consistentes, pero es una señal útil mientras el comprobante se sigue corrigiendo.
- Sin botón "Registrar este asiento" ni nada que escriba: es pura lectura.

## Simplificaciones conocidas (para dejar anotadas, no para resolver ahora)

1. **Split gravado/exento por renglón**: la app no sabe, renglón por renglón, si es gravado o exento — son dos campos de cabecera. Si una factura de artículos mezclara renglones con cuentas distintas Y tuviera un importe exento, `EX` se asigna entero a la cuenta del grupo de mayor importe, que puede no ser exacto. Caso raro (mezclar cuentas ya es 1/9.060) y no bloquea nada, pero puede mostrar una cuenta distinta a la real en ese caso puntual.
2. **Cuenta corriente del proveedor para `TO`**: siempre la cuenta del modelo (155). No se encontró una tabla que vincule proveedor → cuenta contable específica.
3. **Líneas sin código resuelto**: si `resolverPercepciones`/`resolverVarios` no puede resolver un código (jurisdicción no reconocida, código elegido ya no existe en Tango), esa línea se omite de la vista previa en vez de bloquear — a diferencia del registro real, que sí bloquea.

## Testing

Contra la base real, sin mocks (convención del proyecto). Sin escritura: no hace falta `conRollback`.

- **Snapshot del modelo**: un test que verifica que el modelo 1 sigue teniendo las cuentas/tipos contables esperados para `SB`, `EX`, `1`-`4`, `60`-`62`/`68`, `TO` — protege contra un cambio de configuración en Tango que rompería la vista previa en silencio.
- **`previsualizarAsiento` con un comprobante de prueba** (`insertarComprobantePrueba`/`insertarRenglonPrueba`, mismo patrón que el resto de la suite): un caso de conceptos (proveedor real con concepto cargado, `010151`/`712`) y un caso de artículos (artículo real con cuenta conocida, `106817`→cuenta 120), verificando que las líneas de `SB` apunten a la cuenta correcta en cada uno.
- Un caso con IVA 21% + percepción IIBB Tucumán, verificando las cuentas 93 y 99 respectivamente.
- Un caso con una línea de "Impuestos varios" para confirmar que el join genérico también funciona ahí, no solo en los casos con mapeo directo.
