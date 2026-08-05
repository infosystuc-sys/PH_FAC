# PH_FAC — Importador de facturas con IA hacia Tango

Aplicación web para el equipo de cuentas a pagar. El operador importa comprobantes de compra en PDF, Claude extrae los campos, el operador revisa contra el PDF original, y el comprobante se graba en el ERP **Tango Gestión** sobre SQL Server.

**Antes de trabajar, leé `docs/superpowers/RETOMAR.md`**: tiene el estado actual, qué fase sigue, y tres cosas pendientes que hay que arrastrar a las fases siguientes. El diseño completo está en `docs/superpowers/specs/2026-08-04-importador-facturas-tango-design.md`.

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
- **Solo `src/server/tango/` puede emitir SQL contra tablas del ERP** (`CPA*`, `CTA*`, `STA*`, `GVA*`, `SBA*`). Es la frontera que acota el costo de un futuro cambio de versión de Tango. Ningún otro módulo las nombra.
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

El diseño es de alta fidelidad y sus medidas son finales. La fuente de verdad es `design/README.md`, no las capturas de `design/screenshots/`.

- **IBM Plex Sans** para la UI, **IBM Plex Mono** para todo dato que el operador cotejá contra el PDF: importes, CUIT, CAE, números de comprobante, fechas, timestamps, porcentajes. Es la regla tipográfica central: los dígitos tienen que alinearse en columna. Self-hosted vía `@fontsource`, **nunca desde Google Fonts** (la app corre en red interna).
- Sin Tailwind: CSS Modules y medidas exactas en píxeles. Los colores salen de las variables CSS de `src/app/globals.css`.
- Diseñado para ≥1280px. Sin diseño mobile, sin media queries.
- Copy en **español rioplatense**, sobrio y técnico. El usuario es un administrativo de cuentas a pagar que procesa 20 a 100 comprobantes por día, no un ejecutivo.

## Tests

La mayoría pegan contra SQL Server real. Los que escriben van dentro de `conRollback` para no dejar filas, y **no pueden asumir que las tablas están vacías**: miden contra una línea de base porque la app va a acumular datos reales.

## Convención de commits

En español, en imperativo, terminando con:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```
