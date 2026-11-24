# ADR 0004 — Las terminales (PTY) viven en el daemon con node-pty

- Estado: aceptada
- Fecha: 2026-11-24

## Contexto

Se consideró poner los PTY en Rust (portable-pty, dentro de Tauri) para mandar bytes directo a la vista.
Pero entonces la CLI y el MCP no podrían leer ni escribir en las terminales sin pasar por la ventana, y
cerrar la ventana las mataría.

## Decisión

- Los PTY viven en el daemon, detrás de `PtyPort`, con el adaptador `pty-node` (node-pty: ConPTY en
  Windows, forkpty en Linux; es el que usa VS Code).
- El daemon guarda un búfer circular por terminal (por defecto 2 MiB) para reconectar y para
  `terminal.read`.
- La salida se agrupa (~8 ms o 64 KiB) antes de enviarla.

## Consecuencias

- Si una medición muestra que el rendimiento no alcanza, se escribe otro adaptador de `PtyPort`
  (p. ej. un proceso Rust con portable-pty) sin tocar el núcleo ni los clientes.
