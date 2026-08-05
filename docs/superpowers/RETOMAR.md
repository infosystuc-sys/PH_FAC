# Cómo retomar después del reinicio

**Pausado:** 2026-08-04, segunda vez
**Rama:** `fase-1-fundacion`
**Último commit:** `4a0a7de`
**Árbol de trabajo:** limpio, todo commiteado

---

## Para retomar, decime esto

> Retomá la ejecución de la Fase 1 desde donde quedó. Leé `docs/superpowers/RETOMAR.md`.

El estado real vive en el historial de git y en el ledger `.superpowers/sdd/2026-08-04-fase1-fundacion-y-bandeja/progress.md`.

---

## Dónde quedamos

**Las 8 tareas de la Fase 1 están completas y la revisión final de la rama ya se hizo.** Fue una revisión de rama entera, con un agente fresco, y rechazó la integración con tres bloqueantes. Los tres están arreglados, más dos recomendados fuertes y varios menores: 7 commits nuevos.

**Falta un solo paso: la re-revisión acotada de esos 7 commits.** Después de eso, integrar a `master`.

| Ítem | Estado |
|---|---|
| Tareas 1 a 8 | ✅ Completas, cada una con su revisión |
| Revisión final de la rama | ✅ Hecha — rechazó con 3 bloqueantes |
| Fixes de los bloqueantes | ✅ Hechos, 7 commits (`b43b7ad..4a0a7de`) |
| **Re-revisión acotada del fix** | ⬜ **Próximo paso** |
| Integrar a `master` | ⬜ Después de la re-revisión |

**59 tests en verde.** Las 4 tablas `PHF_` existen en `PUNTO_HOGAR_1` con 6 filas de muestra; `sys.tables` en 3.106, sin residuos.

---

## El próximo paso concreto

Re-revisión acotada del rango `b43b7ad..4a0a7de`, verificando hallazgo por hallazgo:

| Hallazgo | Qué se arregló | Commit |
|---|---|---|
| **C1** Critical — contraseña de SQL Server commiteada en `.env.local.example`, el spec y el plan | Redactada a `<ver .env.local>`. El host, la instancia, la base y el usuario quedan: son topología, no secretos | `37d6a9b` |
| **I1** — la bandeja truncaba en 100 filas en silencio mientras el pie mostraba el total real | Paginación cableada, con la página en la query string y reset a la 1 al cambiar filtro o búsqueda. El pie ahora dice "Mostrando 1-100 de 347" | `2281136` |
| **I3** — el DDL sin cobertura real (3 tests no podían fallar) ni atomicidad | Cada tabla se crea en su transacción; la idempotencia verifica índices además de tablas; los tests corren con prefijo único para que el `CREATE` se ejecute de verdad | `ad02163` |
| **I4** — sin `error.tsx`: si SQL caía, pantalla genérica en inglés y el indicador de conexión nunca renderizaba | `src/app/error.tsx` en español con reintento; el error de conexión se loguea en vez de descartarse | `4e69c63` |
| **I5** — el comentario de `useUTC` daba una razón falsa para una opción load-bearing | Comentario corregido y test que protege el ida y vuelta de `FECHA_EMISION` | `8aeb11c` |
| **I2** — `buscarProveedorPorCuit` devolvía un proveedor arbitrario con CUIT duplicado | `ORDER BY COD_PROVEE` para que sea determinístico | `fcf12c0` |
| Menores | Dos aserciones que pasaban aunque el código estuviera roto | `4a0a7de` |

El fixer verificó dos regresiones a propósito: con `useUTC: true` el test nuevo falla con `expected '17/05/2026' to be '18/05/2026'`, y con un `CREATE INDEX` roto la transacción se lleva puesta la tabla entera.

---

## Después de la re-revisión

Integrar `fase-1-fundacion` a `master`. **Ojo: la rama base se llama `master`, no `main`** — `git init` la creó así.

Después arrancan las fases 2 a 4, cada una con su propio plan:

- **Fase 2** — importación de PDFs, extracción con Claude, pantalla de revisión con resaltado por capa de texto.
- **Fase 3** — las cuatro validaciones, modal de observación, confirmación, auditoría, toasts, atajos de teclado.
- **Fase 4** — registro en Tango y asociación de remitos.

---

## Dos cosas que hay que arrastrar a las fases siguientes

**1. Siete CUIT duplicados en `CPA01`, uno de ellos en cuatro filas.** Verificado contra la base. Hoy no rompe nada porque la Fase 1 no escribe, y `buscarProveedorPorCuit` ya es determinístico. Pero la resolución de verdad —ofrecerle las coincidencias al operador para que elija— es de la Fase 3. Si no se hace, la Fase 4 termina imputando una factura a la cuenta corriente del proveedor equivocado, en el ERP real, sin ningún síntoma visible.

**2. El spec declara cinco lecturas de Tango y solo se implementó una.** El spec §4 pide proveedores, remitos pendientes de facturar, condiciones de compra, alícuotas de IVA y códigos de impuesto. El plan de la Fase 1 angostó eso a solo proveedores sin dejarlo asentado. La Fase 2 no puede arrancar creyendo que la capa de lectura está terminada: faltan cuatro consultas contra tablas del ERP que hay que descubrir, verificar y testear.

---

## Qué tiene que estar en pie al volver

```bash
cd /d/APP/PH_FAC && git branch --show-current && git status --short && pnpm test
```

Esperado: rama `fase-1-fundacion`, sin cambios sin commitear, 59 tests en verde.

- **SQL Server y SQL Browser arrancan solos**: los dos servicios están en `Automatic`. El SQL Browser hace falta para conectar por nombre de instancia.
- **`.env.local` está en disco y no se commitea.** Ahora importa más que antes: es el único lugar del proyecto donde vive la contraseña. Si desapareciera, hay que recrearlo desde `.env.local.example` y **completar `SQLSERVER_PASSWORD` a mano**, porque el ejemplo ya no la trae.
- **`ANTHROPIC_API_KEY` sigue vacía.** Se usa recién en la Fase 2.
- **No quedan procesos que matar.**

---

## Cuidado con esto

**No corras `git clean -fdx` en esta carpeta.** Borraría `.superpowers/`, que está gitignorada y guarda el ledger, los briefs y los reportes de revisión. El historial de git alcanza para reconstruir dónde estábamos, pero se pierde el detalle de por qué cada decisión se tomó como se tomó.

**Rotar la contraseña de SQL Server es decisión tuya.** La saqué de los archivos trackeados, pero estuvo commiteada en el historial de esta rama. No hay remoto configurado, así que nunca salió de tu disco. Si querés que el historial quede limpio también, hay que reescribirlo, y eso lo tenés que pedir explícitamente.

---

## Contexto que no está en el código

El detalle completo está en `docs/superpowers/specs/2026-08-04-importador-facturas-tango-design.md`. Lo que conviene no re-litigar:

- La base `PUNTO_HOGAR_1` de esta PC es de desarrollo, con la misma estructura que producción. Por eso se escribe directo, sin modo simulación.
- El registro en Tango será cabecera + asociación a un remito existente. Sin renglones inventados, sin mover stock, sin asiento contable.
- La app va sin login; el usuario de auditoría sale del usuario de Windows.
- Los CUIT en `CPA01` están guardados **con** guiones (`23-23292431-4`). La columna de razón social es `NOM_PROVEE`.
- Un ingreso de factura en Tango toca 11 tablas, no una. Están listadas en el spec §2.
