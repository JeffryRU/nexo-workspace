# ADR 0001 — Núcleo en TypeScript (Node 24) y shell de escritorio en Rust delgado (Tauri 2)

- Estado: aceptada
- Fecha: 2026-11-24

## Contexto

Queremos una app rápida para Linux y Windows. Se consideró: todo en Rust, núcleo en Go (compila rápido,
más RAM), y núcleo en TypeScript con Node. Las integraciones con agentes son el corazón del producto y
sus SDK oficiales son TypeScript: Claude Agent SDK, Codex SDK / `codex app-server`, Agent Client Protocol
(Gemini, y agentes como Pi, también escritos en TS), y el SDK de MCP. Además queremos zod para validar,
y compartir los mismos esquemas entre la interfaz, el daemon, la CLI y el servidor MCP.

## Decisión

- **Núcleo, daemon, CLI y MCP en TypeScript sobre Node 24.** Un solo lenguaje para el dominio y los
  contratos; los esquemas zod se escriben una vez.
- **Shell de escritorio en Rust con Tauri 2, delgado:** ventana, bandeja, atajo global, instancia única y
  arrancar el daemon. Sin lógica de negocio, así que se recompila pocas veces y el tiempo de compilación
  de Rust no frena el día a día.
- **No Go:** obligaría a cambiar Tauri por Wails y a duplicar los contratos en otro lenguaje sin
  ganar velocidad perceptible: la latencia la ponen los modelos (segundos), no el proceso que los maneja.

## Consecuencias

- Un PTY o un parser que resulte lento se puede reescribir en Rust (como adaptador de un puerto) sin
  tocar el núcleo: la arquitectura hexagonal deja esa puerta abierta (ver ADR 0004).
- Para distribuir hay que empaquetar Node con el daemon (sidecar de Tauri). Se resuelve en la fase de
  empaquetado.
