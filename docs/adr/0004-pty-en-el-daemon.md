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

## Actualización (issue #15): los PTY corren en un proceso host aparte

### Problema

node-pty 1.1.0 con ConPTY se cae a veces con una violación de acceso nativa (`0xC0000005`, código de salida
`3221225477`) en Windows. Si ocurre dentro del daemon, tumba **todas** las terminales del usuario.

### Medición (Windows 11 10.0.26300, Node 24.20, node-pty 1.1.0, 12 terminales por ronda, 100 rondas por variante)

Cada ronda corre en un proceso hijo desechable (`tools/stress/pty-stress.mjs`). Variantes con node-pty a pelo:

| Variante                                                | Rondas con crash                                 |
| ------------------------------------------------------- | ------------------------------------------------ |
| `conpty.dll` incluido, `kill` a la vez                  | **12 / 100** (todas 0xC0000005)                  |
| `conpty.dll`, mitad salen solas / mitad `kill` a la vez | **34 / 100** (25 / 100 con 4 rondas en paralelo) |
| `conpty.dll`, `kill` espaciados 25 ms                   | 0 / 100                                          |
| `conpty.dll`, mixto con espaciado 25 ms                 | 0 / 100                                          |
| `conpty.dll`, todas salen solas a la vez                | 0 / 100                                          |
| `conpty.dll`, salida abundante + exit                   | 0 / 100                                          |
| `conpty.dll`, `resize` durante la salida                | 0 / 100                                          |
| ConPTY del sistema, `kill` a la vez                     | 0 / 100                                          |
| ConPTY del sistema, mixto a la vez                      | 0 / 100                                          |
| ConPTY del sistema, `resize` durante la salida          | 0 / 100                                          |

Conclusiones: el crash se reproduce con node-pty solo (caso mínimo en `tools/stress/node-pty-conpty-repro.mjs`: 10 / 100;
borrador de reporte en `docs/upstream/node-pty-conpty-crash.md`) y la causa es el **`kill` simultáneo** con
`conpty.dll`. Contra lo anotado en F1.1, en estas pruebas el ConPTY del sistema no se cayó (0 / 400 rondas en
todas las variantes), y el espaciado de 25 ms con `conpty.dll` tampoco (0 / 400 con él). El crash residual que
se vio en corridas completas de `pnpm check` (muchos workers y procesos en paralelo) no se reprodujo con el adaptador
directo y la mitigación actual (0 / 300 rondas, 4 en paralelo), así que sigue siendo un riesgo intermitente que no se puede
descartar; por eso se contiene en lugar de confiar solo en la mitigación.

### Decisión

El daemon ejecuta node-pty en un **proceso hijo** («pty host», `@nexo/adapter-pty-host`, `child_process.fork` + IPC) por
defecto en Windows; en Linux/macOS sigue el adaptador directo `pty-node`. Se elige con `NEXO_PTY_MODE=host|direct`.

- **Protocolo IPC** propio (`packages/adapters/pty-host/src/protocol.ts`), validado con zod en ambos extremos, con
  ids de terminal enteros acotados y límites de tamaño (escritura ≤ 64 KiB por mensaje, salida ≤ 1 MiB por mensaje,
  entorno ≤ 1 MiB). Daemon → host: `spawn`, `write`, `resize`, `kill`, `shutdown`. Host → daemon: `ready`, `spawned`,
  `spawn-error`, `data`, `exit`. El daemon resuelve el ejecutable y valida opciones antes de enviar, de modo que los
  errores tipados (`PtySpawnError`) son los mismos que con el adaptador directo.
- **Caída del host.** Cada terminal afectada emite `onExit` con `{ exitCode: null, signal: 'HOST_CRASH' }` (documentado
  en `PtyExit`; el daemon lo publica como `terminal.exit`), se registra el error y el host se relanza bajo demanda para
  las terminales nuevas. Backoff exponencial (250 ms, duplicando hasta 5 s) tras caídas rápidas consecutivas; tras 5
  seguidas el circuito se abre 30 s y `spawn` falla con «el proceso pty host se cayó 5 veces seguidas; no se reintenta…»,
  luego se permite un intento. Un host que vive ≥ 10 s se considera estable y reinicia el contador.
- **Salida sin código.** node-pty (ConPTY) puede llamar a `onExit` sin `exitCode` numérico. El host lo envía como
  `exitCode: null` (y lo registra); si no, el daemon descartaría el evento `exit` por inválido y la terminal nunca
  saldría (issue #37).
- **Mensajes hostiles del host** (malformados, enormes, de ids ajenos) se descartan y se registran; tras 20 inválidos el
  host se mata y se trata como caída. El host valida también lo que recibe y termina si el canal IPC se cierra
  (nunca quedan terminales huérfanas); el cierre ordenado (`shutdown`) mata las terminales una a una.
- Se mantiene el espaciado de 25 ms entre `kill` (ahora dentro del host) y `useConptyDll` en Windows.
- Un único host: la medición no justifica varios (el crash es por `kill` simultáneo, no por el número de terminales
  por proceso). Si se quisiera acotar el radio de una caída, el diseño admite varios hosts sin cambiar el protocolo.
- `resolve.ts` y `mergeEnv` están copiados de `pty-node`: la regla de dependencias prohíbe que un adaptador importe otro.

### Coste del salto IPC (`tools/stress/pty-bench.mjs`, Windows, ConPTY, 300 ecos y 20 MiB de salida)

| Adaptador      | Eco ida y vuelta p50 / p95 / máx | Salida de 20 MiB |
| -------------- | -------------------------------- | ---------------- |
| directo        | 0,15 / 0,30 / 1,13 ms            | 5,5 MiB/s        |
| pty host (IPC) | 0,23 / 0,46 / 2,05 ms            | 5,5 MiB/s        |

El salto añade ~0,1 ms al eco y no cambia el throughput (el límite es ConPTY). Frente a los presupuestos de F1.8
(p95 de cambio de pestaña en ms) es despreciable.

### Resultado

Con el pty host, 100 rondas (4 en paralelo) de cada escenario (`host-mixed`, `host-output-exit`, `host-resize-exit`)
terminaron sin que el proceso que hace de daemon cayera (0 / 300); matar el host con `process.kill` a mitad de salida de
varias terminales deja al daemon vivo, las terminales reciben `HOST_CRASH` y una terminal nueva funciona
(`pty-host.adversarial.test.ts`, `daemon.integration.test.ts`). La prueba de estrés del host corre en el CI de Windows.
