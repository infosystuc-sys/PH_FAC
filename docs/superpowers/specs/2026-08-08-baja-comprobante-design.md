# Dar de baja un comprobante desde la bandeja

**Fecha:** 2026-08-08
**Estado:** aprobado, pendiente de plan de implementación
**Depende de:** Fase 4 integrada en `master`

---

## 1. Qué se construye

Un botón en cada fila de la bandeja (`/comprobantes`) que permite borrar un comprobante que ya no hace falta seguir rastreando en la app — un fixture de prueba, un duplicado, un comprobante mal cargado. No tiene relación con dar de baja un comprobante en Tango: esa baja se hace desde Tango mismo, por un proceso propio del ERP.

## 2. Decisiones

| Punto | Decisión | Motivo |
|---|---|---|
| Tipo de borrado | Físico (`DELETE`), no un estado nuevo tipo `'baja'` | Decisión explícita del usuario. Más simple: no requiere migración de esquema ni tocar el `CHECK` de `ESTADO` |
| Alcance del borrado | Solo tablas propias — `PHF_COMPROBANTE` y, en cascada por FK, `PHF_CAMPO`/`PHF_RENGLON`/`PHF_AUDITORIA` | Regla del proyecto: solo `src/server/tango/` toca tablas de Tango, y esta feature no entra por esa puerta a propósito |
| Estados en los que se puede dar de baja | Todos, sin excepción, incluido `registrado` | Decisión explícita del usuario. Un comprobante `registrado` ya escribió en Tango — borrar la fila de la app solo pierde el vínculo de trazabilidad local, no toca lo ya escrito en `CPA04` y el resto |
| Archivo PDF en disco | Se borra también, después de que el `DELETE` en la base tenga éxito | Decisión explícita del usuario. Sin esto cada baja deja un archivo huérfano en `PHF_STORAGE_DIR` para siempre |
| Si falla el borrado del PDF | No revierte el `DELETE` de la fila | La baja en la app ya es lo importante; un archivo huérfano en disco es un problema menor y recuperable a mano, no motivo para dejar el comprobante fantasma en la bandeja |
| Confirmación | Modal simple confirmar/cancelar, sin motivo obligatorio | Decisión explícita del usuario — es borrado físico, un motivo no tiene dónde persistir después de que la fila desaparece |
| Alcance de la UI | Solo la bandeja (`tabla.tsx`) | El pedido fue específicamente ahí. No se agrega a `barra-acciones.tsx` en la pantalla de revisión — mantiene el cambio acotado |

## 3. Arquitectura

**Backend** — `src/server/app/acciones.ts`, mismo patrón `_En`/wrapper que `elegirProveedorEn`/`elegirProveedor`, `marcarObservacionEn`/`marcarObservacion`, `asignarRemitoEn`/`asignarRemito`:

```ts
darDeBajaComprobanteEn(e: Ejecutor, id: number): Promise<{ archivoRuta: string } | null>
darDeBajaComprobante(id: number): Promise<void>
```

`darDeBajaComprobanteEn` lee `ARCHIVO_RUTA` y borra la fila de `PHF_COMPROBANTE` (la cascada de FK se encarga de `PHF_CAMPO`/`PHF_RENGLON`/`PHF_AUDITORIA`) dentro de la misma conexión — testeable con `conRollback`. Devuelve `null` si el `id` no existe, para que el wrapper pueda avisar con un mensaje claro en vez de un error genérico.

`darDeBajaComprobante` es el wrapper de producción: abre el pool real, llama al `_En`, y si devolvió una ruta, borra el archivo del disco con `fs.rm(ruta, { force: true })` (no explota si el archivo ya no está). Termina con `revalidatePath('/comprobantes')`.

**Frontend** — `src/components/bandeja/tabla.tsx` pasa a ser client component. Hoy cada fila es un `<Link>` que envuelve toda la fila; un `<button>` no puede anidarse dentro de un `<a>`, así que la fila pasa a ser un `<div>` con su propio `onClick` (navega con `useRouter().push`), y el botón de baja es un `<button>` hermano, visible en hover de la fila, con `stopPropagation` para no disparar la navegación al clickearlo.

Al clickear el botón se abre un modal nuevo (`ModalBaja`, mismo esqueleto visual que `ModalObservacion` pero sin selector de motivo: solo texto de confirmación + botones Cancelar/Dar de baja). Al confirmar, llama a `darDeBajaComprobante(id)` dentro de una transición de React, muestra un toast de éxito o error (`useToast`, ya existente), y en éxito el modal se cierra y la fila desaparece de la bandeja (vía `revalidatePath` + refresh del router).

## 4. Manejo de errores

- `id` inexistente (carrera: alguien más ya lo borró, o dos clicks): `darDeBajaComprobanteEn` devuelve `null`, el wrapper tira un error con mensaje claro, el modal lo muestra como toast y no navega a ningún lado raro — la bandeja se refresca igual y la fila ya no está.
- Falla el `DELETE` en la base (conexión caída, lock): el error sube tal cual al toast; la fila sigue en la bandeja porque nada se borró.
- Falla el borrado del PDF después de que el `DELETE` ya tuvo éxito: no se propaga como error al usuario — la baja ya se completó desde su perspectiva. Se deja un `console.error` server-side para que quede rastro si hace falta limpiar el archivo a mano.

## 5. Testing

- `darDeBajaComprobanteEn` contra la base real dentro de `conRollback`: borra la fila, la cascada se lleva `PHF_CAMPO`/`PHF_RENGLON`/`PHF_AUDITORIA` (verificar con un comprobante de prueba que tenga de las tres), devuelve `null` si el `id` no existe.
- Verificación manual en el navegador: dar de baja un comprobante de prueba desde la bandeja, confirmar que desaparece, que el PDF se borró del disco, y que cancelar el modal no borra nada.

---

## Notas para quien escriba el plan

- No hace falta ninguna migración de esquema — el `DELETE` usa la tabla y las FK tal como están.
- El PDF de prueba para el test manual puede ser cualquiera de los ya usados en la suite (`tests/server/app/archivos.test.ts` tiene fixtures chicos).
