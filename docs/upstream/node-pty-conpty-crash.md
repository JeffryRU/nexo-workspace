# Borrador de reporte para node-pty: violación de acceso al matar varios PTY a la vez con `useConptyDll`

> Borrador preparado para el issue #15 de Nexo. **No se ha abierto ningún issue en `microsoft/node-pty`**: decide el
> usuario si se envía, tras revisar y reproducir en otra máquina.

## Título propuesto

Windows: `kill()` simultáneo de varios PTY con `useConptyDll: true` termina el proceso con 0xC0000005 (~10 % de las rondas con 12 terminales)

## Entorno

- node-pty **1.1.0** (binarios prebuilt de la distribución npm, `conpty.dll`/`OpenConsole.exe` incluidos en `third_party/conpty`).
- Node.js **24.20.0**, Windows 11 Pro **10.0.26300**, x64, Intel i5-11400F (12 hilos lógicos).
- Sin Electron: Node plano.

## Qué pasa

Con `useConptyDll: true`, llamar a `pty.kill()` sobre varios PTY a la vez (en el mismo tick) tumba el proceso de Node
con una violación de acceso nativa (código de salida `3221225477` = `0xC0000005`), sin excepción de JS ni salida por
`stderr`. Con el ConPTY del sistema (`useConptyDll: false`) no se reproduce en las mismas condiciones, y con los
`kill()` espaciados 25 ms entre sí tampoco.

## Pasos para reproducir

Caso mínimo, solo node-pty (sin código de Nexo): `tools/stress/node-pty-conpty-repro.mjs`. Equivale a:

```js
const pty = require('node-pty')
const ptys = []
for (let i = 0; i < 12; i++) {
  ptys.push(
    pty.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cols: 80,
      rows: 24,
      useConptyDll: true,
    }),
  )
}
await new Promise((r) => setTimeout(r, 500)) // que arranquen
for (const p of ptys) p.kill() // todos a la vez -> a veces el proceso muere con 0xC0000005
```

Cada ronda corre en un proceso hijo desechable y se cuenta como fallo si termina con código distinto de 0.

```
node tools/stress/node-pty-conpty-repro.mjs --rounds 100 --terminals 12 --dll true  --gap 0
node tools/stress/node-pty-conpty-repro.mjs --rounds 100 --terminals 12 --dll false --gap 0
node tools/stress/node-pty-conpty-repro.mjs --rounds 100 --terminals 12 --dll true  --gap 25
```

## Tasas medidas (100 rondas, 12 terminales)

| `useConptyDll` | Espaciado entre `kill` | Rondas con crash                  |
| -------------- | ---------------------- | --------------------------------- |
| `true`         | 0 ms (a la vez)        | **10 / 100** (todas `0xC0000005`) |
| `false`        | 0 ms                   | 0 / 100                           |
| `true`         | 25 ms                  | 0 / 100                           |

Variante con la mitad de las terminales saliendo solas y la otra mitad matadas a la vez (`tools/stress/pty-stress.mjs`,
`dll-nogap-mixed`): 34 / 100 en serie y 25 / 100 con 4 rondas en paralelo.

Escenarios que **no** reprodujeron el crash en 100 rondas cada uno: todas las terminales saliendo solas a la vez,
salida abundante más salida simultánea, y `resize` durante la salida (con y sin `useConptyDll`).

## Hipótesis (sin confirmar)

Condición de carrera en la ruta de cierre de `conpty.dll` cuando varios `ClosePseudoConsole`/`TerminateProcess`
coinciden. No se ha depurado el volcado del crash; si se envía, conviene adjuntar uno (`procdump -e -ma`).

## Mitigación en Nexo

Espaciar los `kill` 25 ms (F1.1) y, como defensa en profundidad, ejecutar node-pty en un proceso hijo («pty host»,
`packages/adapters/pty-host`) para que un crash nativo no tumbe al daemon. Ver `docs/adr/0004-pty-en-el-daemon.md`.
