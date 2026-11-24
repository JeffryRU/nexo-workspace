# ADR 0003 — El daemon es la única fuente de verdad; ventana, CLI y MCP son clientes

- Estado: aceptada
- Fecha: 2026-11-24

## Contexto

Queremos controlar terminales y agentes desde fuera de la ventana (CLI, otros agentes, la futura
mascota por MCP), como hace herdr, y que cerrar la ventana no mate el trabajo en curso.

## Decisión

- Un proceso **daemon** por usuario guarda todo el estado y los procesos hijos.
- La ventana, la CLI `atalaya` y el servidor MCP hablan el **mismo protocolo** (WebSocket local + token)
  por medio de `packages/client`.
- El daemon escucha solo en `127.0.0.1` y publica su puerto en `daemon.json` en el directorio de estado.

## Consecuencias

- Cualquier cosa que haga la interfaz se puede automatizar por CLI o MCP desde el primer día.
- La mascota futura será un cliente más que se suscribe a eventos (`pane.attention`, estados de agente).
