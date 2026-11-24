# ADR 0005 — Interfaz con SolidJS, TanStack Solid Query y stores en vivo

- Estado: aceptada
- Fecha: 2026-11-24

## Contexto

La interfaz recibe texto en streaming de varios agentes y salida de varias terminales a la vez, y debe
cambiar de pestaña sin recargar.

## Decisión

- **SolidJS**: reactividad fina, sin DOM virtual ni re-render de árboles completos.
- **`@tanstack/solid-query`** para datos de petición/respuesta (historial, modelos, límites de uso,
  configuración): caché, reintentos e invalidación.
- **Stores de Solid** alimentados por el flujo de eventos para el estado en vivo.
- Pestañas y paneles se ocultan, no se desmontan.

## Consecuencias

- Los eventos que cambian datos cacheados invalidan las consultas de Solid Query que correspondan
  (p. ej. `session.ended` invalida el historial).
