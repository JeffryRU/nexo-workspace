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

## Notas del adaptador `pty-node` (F1.1)

- `env` se mezcla sobre el entorno del anfitrión; `spawn` rechaza siempre con `PtySpawnError` (`EXECUTABLE_NOT_FOUND`,
  `CWD_NOT_FOUND`, `INVALID_OPTIONS`, `SPAWN_FAILED`).
- Windows: sin señales (`kill` ignora el argumento, `signal` es `null` y `exitCode` numérico); se usa el
  `conpty.dll` incluido en node-pty porque el ConPTY del sistema provoca violaciones de acceso nativas cuando varios
  PTYs salen a la vez; los `kill` se espacian 25 ms por la misma razón; la entrada a ConPTY va a ~25 KiB/s
  (1 MiB tarda ~40 s) y `process.stdout.columns` del hijo no se refresca tras un `resize` (hay que consultar el handle).
- Linux: node-pty se compila al instalar (node-gyp); `pnpm-workspace.yaml` lo permite con `allowBuilds`.
