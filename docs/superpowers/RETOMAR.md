# Cómo retomar después del reinicio

**Pausado:** 2026-08-04
**Rama:** `fase-1-fundacion`
**Último commit:** `cc98d8d`
**Árbol de trabajo:** limpio, todo commiteado

---

## Para retomar, decime esto

> Retomá la ejecución de la Fase 1 desde donde quedó. Leé `docs/superpowers/RETOMAR.md`.

Con eso alcanza. El estado real vive en dos lugares que sobreviven al reinicio: el historial de git y el ledger en `.superpowers/sdd/2026-08-04-fase1-fundacion-y-bandeja/progress.md`.

---

## Dónde quedamos

Fase 1 del importador de facturas: 8 tareas. Van 6 completas y la séptima está a medio camino.

| # | Tarea | Estado |
|---|---|---|
| 1 | Andamiaje Next.js + design tokens | ✅ Completa, revisión limpia |
| 2 | Pool SQL Server + transacciones | ✅ Completa, tras 1 fix round |
| 3 | Esquema `PHF_*` | ✅ Completa, revisión limpia |
| 4 | Formato, estados, usuario | ✅ Completa, revisión limpia |
| 5 | Lectura de proveedores de Tango | ✅ Completa, revisión limpia |
| 6 | Consultas de bandeja | ✅ Completa, tras 1 fix round |
| 7 | Header global + badge + chip | ⏸ **Implementada y revisada. Revisión NO aprobada: 2 hallazgos Important abiertos** |
| 8 | Bandeja de comprobantes (UI) | ⬜ Sin empezar |

**49 tests en verde.** Las 4 tablas `PHF_*` existen en `PUNTO_HOGAR_1` (verificado: `sys.tables` pasó de 3.102 a 3.106).

---

## El próximo paso concreto

Fix round 1 de 5 sobre la Task 7. Dos hallazgos Important que hay que corregir antes de pasar a la Task 8. **Los dos vienen de un defecto del plan, no del implementador.**

### Important A — colores hardcodeados en el header

`src/components/header-global.tsx`: el punto de conexión hardcodea `#3ea37c` y `#a03526`. Las variables `var(--conexion-ok)` y `var(--error)` ya existen en `src/app/globals.css` con esos valores exactos. La restricción del proyecto es usar las variables salvo en las dos excepciones declaradas (los `NIVELES` del chip y los colores de `ESTADOS`), y esta no es una de ellas.

### Important B — bug de límite en el chip de confianza

`src/components/chip-confianza.tsx`: el diseño define el rango ámbar como `0,80 – 0,93` **inclusive**, y gris como `> 0,93` **estricto**. La implementación usa `NIVELES.find(n => valor < n.max)` con `max: 0.93`, así que un valor de exactamente `0,93` cae en gris cuando debería ser ámbar. Es un off-by-one de borde: raro pero real, y el chip es lo que le avisa al operador que un campo necesita una segunda mirada.

### Minor diferido, no bloquea

Los `margin-left: -12px` de `src/components/header-global.module.css` son un parche acoplado implícitamente al `gap: 20px` del contenedor. Funciona (verificado con `getComputedStyle`), pero es frágil. Queda anotado para que lo triage la revisión final.

---

## Después del fix

1. Re-revisión acotada del diff del fix.
2. Task 8: la bandeja completa (KPIs, tabs de filtro, buscador, tabla, y el stub de la pantalla de revisión). Es la que hace que la app se vea por primera vez.
3. Revisión final de toda la rama.
4. Decidir cómo integrar la rama a `main`.

Después de eso arrancan las Fases 2 a 4, cada una con su propio plan: importación y extracción con Claude, validaciones, y el registro en Tango.

---

## Qué tiene que estar en pie al volver

Verificalo con esto:

```bash
cd /d/APP/PH_FAC && git branch --show-current && git status --short && pnpm test
```

Esperado: rama `fase-1-fundacion`, sin cambios sin commitear, 49 tests en verde.

- **SQL Server y SQL Browser** arrancan solos: los dos servicios (`MSSQL$AXSQLSERVER` y `SQLBrowser`) están en modo `Automatic`. El SQL Browser hace falta sí o sí para conectar por nombre de instancia.
- **`.env.local`** está en disco y no se commitea. Si desapareciera, se recrea copiando `.env.local.example` y no hace falta editar nada todavía: `ANTHROPIC_API_KEY` recién se usa en la Fase 2.
- **No hay procesos que matar.** No quedó ningún dev server escuchando.

---

## Cuidado con esto

**No corras `git clean -fdx` en esta carpeta.** Borraría `.superpowers/`, que está gitignorado y contiene el ledger, los briefs y los reportes de las 7 tareas. Si llegara a pasar, el historial de git alcanza para reconstruir dónde estábamos, pero se pierde el detalle de las revisiones.

**No borres `.env.local`** salvo que quieras recrearlo del ejemplo.

---

## Contexto que no está en el código

Decisiones tomadas que conviene no re-litigar al volver — el detalle completo está en `docs/superpowers/specs/2026-08-04-importador-facturas-tango-design.md`:

- La base `PUNTO_HOGAR_1` de esta PC es de desarrollo, con la misma estructura que producción. Por eso se escribe directo, sin modo simulación.
- El registro en Tango será cabecera + asociación a un remito existente. Sin renglones inventados, sin mover stock, sin asiento contable.
- La app va sin login; el usuario de auditoría sale del usuario de Windows.
- Los CUIT en `CPA01` están guardados **con** guiones (`23-23292431-4`). La columna de razón social es `NOM_PROVEE`.
