# PH_FAC — Importador de facturas con IA hacia Tango

Aplicación web para el equipo de cuentas a pagar. El operador importa comprobantes de compra en PDF, Claude extrae los campos, el operador revisa contra el PDF original, y el comprobante se graba en el ERP **Tango Gestión** sobre SQL Server.

**Antes de trabajar, leé `docs/superpowers/RETOMAR.md`**: entorno, qué hace la app, pendientes y decisiones vigentes del usuario, en una página. La bitácora detallada de cada cambio está en `docs/superpowers/HISTORIAL.md`. Al cerrar una sesión, actualizá las dos. El diseño original está en `docs/superpowers/specs/2026-08-04-importador-facturas-tango-design.md`.

## Stack

Next.js 15 (App Router) + TypeScript + React 19. Acceso a datos con `mssql` (node-mssql) y SQL explícito, sin ORM. Tests con Vitest. Gestor: `pnpm`.

```bash
pnpm dev       # dev server
pnpm test      # suite completa (pega contra SQL Server real)
pnpm build     # build de produccion
pnpm migrate   # crea las tablas PHF_ (idempotente)
pnpm seed      # carga comprobantes de muestra
```

## Base de datos

`PUNTO_HOGAR_1` en `INFOSYS01\AXSQLSERVER`. Credenciales en `.env.local`, que **no se commitea**.

**Es la base de Tango Gestión con más de 3.100 tablas del ERP y datos reales.** Las tablas de esta app conviven con ellas. Requiere el servicio SQL Server Browser corriendo (la instancia tiene nombre).

## Reglas que no se negocian

- **Todas las tablas propias llevan prefijo `PHF_`.** Ninguna otra tabla se crea en la base. Nunca borres, alteres ni escribas sobre una tabla que no lleve ese prefijo.
- **Solo `src/server/tango/` puede emitir SQL contra tablas del ERP** (`CPA*`, `STA*`, `GVA*`, `SBA*`). Es la frontera que acota el costo de un futuro cambio de versión de Tango. Ningún otro módulo las nombra.
- **Solo se tocan tablas que figuren en la documentación oficial de Axoft**, por módulo: [Compras](https://ayudas.axoft.com/21ar/documentos/operacion/tablas_oper/tablascompras_oper/) y [Stock](https://ayudas.axoft.com/21ar/documentos/operacion/tablas_oper/tablastock_oper/). Las `CTA*` no figuran en ninguno: son el espejo de Tango Central para consolidación entre sucursales, no la fuente de verdad. No se leen (para datos se usa siempre la tabla `CPA*`/`STA*` de origen) y no se escriben, **con tres excepciones de escritura**: `CTA05`, `CTA06` y `CTA07` son el espejo fila por fila de `CPA04`, `CPA18` y `CPA46`, y `registrarComprobanteEn` (`src/server/tango/comprobantes.ts`) inserta en cada una la misma fila que en su `CPA*`, como hace Tango al registrar una factura (spec §2 y §9, implementado en la Fase 4). No sacarlas: la factura quedaría sin espejo para la consolidación. Ninguna otra `CTA*` se toca; en particular `CTA09`/`CTA11` (remitos), que se reemplazaron por `STA14`/`STA20`.
  **Excepción explícita (2026-08-20/21), decidida por el usuario:** `TIPO_CONTABLE`, `CUENTA`, `ASIENTO_MODELO_CP`, `RENGLON_MODELO_CP`, `CONCEPTO_CP` y `ARTICULO_CUENTA` tampoco figuran en Compras ni Stock (se revisó también Contabilidad, Procesos generales y Administrador), pero son tablas de configuración real del motor contable de Tango -- no espejos `CTA*` -- y hacen falta, de solo lectura, para la vista previa del asiento contable. Autorizadas para lectura únicamente.
    **Segunda excepción explícita (2026-08-22), decidida por el usuario:** `ASIENTO_COMPROBANTE_CP` y `ASIENTO_CP` tampoco figuran en Compras ni Stock, pero son las tablas de staging donde Tango arma el asiento antes de "pasar a contabilidad" -- no el mayor posteado final, que vive en otras tablas (`ASIENTO_CP` "de verdad" no es esta; hay un módulo completo de Contabilidad con numeración por ejercicio/período que esta app no toca). Autorizadas para lectura y **escritura**: `registrarComprobanteEn` (`src/server/tango/comprobantes.ts`) arma ahí el asiento de cada factura que registra, sin marcarlo contabilizado -- ese paso lo sigue haciendo el usuario desde el propio Tango.
  **`STA12` (2026-09-23), decidida por el usuario:** figura en la documentación oficial de Stock como "Precios artículos compra / costo", así que no es una excepción a la regla de arriba -- se anota acá porque es la primera tabla de STOCK sobre la que la app escribe. `registrarComprobanteEn` actualiza el precio de última compra de cada artículo que factura, que es lo que hace Tango al registrar: sin eso, todo informe de última compra o de costo de reposición quedaba con el precio de la compra anterior. Ver `src/server/tango/preciosCompra.ts`, que documenta qué columna sale de dónde y cuáles NO se tocan.
  **`STA11.USA_ESC` (2026-09-30):** `STA11` ya se leía; se anota acá porque esa columna es la que distingue un artículo **base** de escala (`B`, el padre, que no se factura) de una **variante** (`S`, la que lleva el color o el talle pegado al código). Sin mirarla, la app tomaba un base por un artículo facturable y decía "reconocido, sin pendiente de facturar" -- ver `Escala` en `src/server/tango/articulos.ts`.
  **Remitos de proveedor (2026-10-25), decidido por el usuario:** la app registra remitos (`TCOMP_IN_S = 'RP'`), así que escribe por primera vez en `STA14`/`STA20` (cabecera y renglones del movimiento de stock), suma el saldo del depósito 01 en `STA19.CANT_STOCK` y baja `STA19.CANT_PEND` (lo pendiente de recibir de las OC), actualiza los contadores de recepción de `CPA36` (`CAN_RECIBI`, `CAN_PENDIE`, …) y avanza el `PROXIMO` del talonario de remitos en `CPA56`. Todas figuran en la documentación de Stock o de Compras. **2026-10-29, pedido del usuario:** además inserta una fila por renglón de remito contra OC en `CPA_OC_REMITO` (el vínculo remito ↔ orden de compra), con el patrón de las 10.355 filas `RP` reales. Ver `src/server/tango/remitosCompra.ts`, que documenta de qué datos reales sale cada columna. **2026-11-03, pedido del usuario:** la factura de artículos contra una OC consume además el remito ya recibido contra ese renglón: inserta en `CPA48` (vínculo factura ↔ remito), baja `STA20.CANT_PEND` (sin tocar `CANT_FACTU`), pasa `STA14.ESTADO_MOV` a `'F'` y setea `CPA46.FALTA_REM`. Ver `src/server/tango/remitosFactura.ts`.
- Toda consulta va parametrizada con `.input(...)`. Nunca concatenes valores de usuario en el SQL.
- Ninguna credencial en archivos trackeados.

## Arquitectura

| Carpeta | Responsabilidad |
|---|---|
| `src/server/db/` | Pool de conexión y helpers de transacción. Infraestructura, no nombra tablas |
| `src/server/tango/` | Única capa que toca el ERP |
| `src/server/app/` | Tablas propias `PHF_*`. No conoce Tango |
| `src/lib/` | Lógica pura: formato, estados, umbrales de confianza |
| `src/app/`, `src/components/` | Rutas y UI. Consumen server actions, nunca SQL |

## UI

Desde 2026-10-17 la app usa el **sistema visual Rivai ERP** (pedido del usuario, documento "Rivai ERP - Estilo"): los tokens están en `src/app/tokens.css`, copiados tal cual del documento — colores, radios 2/3/6 px, controles de 30 px, sombras. `globals.css` deja los nombres viejos (`--acento`, `--texto-2`, …) como alias de esos tokens; en código nuevo usá los tokens. Íconos: `src/components/icono.tsx` (el set del documento, línea 1.6), sin emoji. La disposición de pantallas sigue lo descripto en `design/README.md`; sus colores y radios quedaron reemplazados por los del sistema Rivai.

- **IBM Plex Sans** para la UI, **IBM Plex Mono** para todo dato que el operador cotejá contra el PDF: importes, CUIT, CAE, números de comprobante, fechas, timestamps, porcentajes. Es la regla tipográfica central: los dígitos tienen que alinearse en columna. Self-hosted vía `@fontsource`, **nunca desde Google Fonts** (la app corre en red interna).
- Sin Tailwind: CSS Modules y medidas exactas en píxeles. Los colores salen de los tokens de `src/app/tokens.css`; ningún hex suelto fuera de la paleta.
- Etiquetas de sección y encabezados de tabla en Mono, mayúsculas, 10–11 px, tracking 0.6 px.
- Diseñado para ≥1280px. Sin diseño mobile, sin media queries.
- Copy en **español rioplatense**, sobrio y técnico. El usuario es un administrativo de cuentas a pagar que procesa 20 a 100 comprobantes por día, no un ejecutivo.

## Tests

La mayoría pegan contra SQL Server real. Los que escriben van dentro de `conRollback` para no dejar filas, y **no pueden asumir que las tablas están vacías**: miden contra una línea de base porque la app va a acumular datos reales.

## Convención de commits

En español, en imperativo, terminando con:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```
