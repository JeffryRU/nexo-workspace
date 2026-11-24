# ADR 0002 — Arquitectura hexagonal y contratos zod como única fuente de tipos

- Estado: aceptada
- Fecha: 2026-11-24

## Contexto

Habrá varios proveedores de agentes, varios clientes (ventana, CLI, MCP, mascota) y dos sistemas
operativos. Sin límites claros, cada proveedor termina filtrándose en la interfaz y cada cliente
reimplementa el protocolo.

## Decisión

- `packages/core` contiene el dominio, los casos de uso y los **puertos**; no hace I/O ni importa Node.
- `packages/adapters/*` implementan los puertos; `apps/*` los componen.
- `packages/contracts` define con **zod** cada mensaje del protocolo y cada tipo de dominio compartido.
  Los tipos salen de `z.infer`. Todo lo que cruza un proceso se valida al recibirlo.
- Cada puerto tiene un falso y una suite de conformidad en `packages/testkit` que corre contra el falso y
  contra los adaptadores reales.
- `dependency-cruiser` en CI hace cumplir la regla de dependencias.

## Consecuencias

- Probar el núcleo no necesita procesos reales: es rápido y determinista.
- Agregar un proveedor = un adaptador nuevo que pase la suite de conformidad de `AgentProviderPort`.
