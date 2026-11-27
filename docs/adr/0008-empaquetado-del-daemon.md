# ADR 0008 — El daemon se empaqueta con esbuild y Node va como recurso de Tauri

- Estado: aceptada (F6.1)
- Fecha: 2026-11-27

## Contexto

Hasta F5 el escritorio lanzaba `node apps/daemon/src/main.ts` del repositorio con el Node del sistema. Una app
instalable no puede depender de ninguno de los dos. Hay que decidir (1) cómo se empaqueta el código, (2) cómo se
entrega Node y (3) qué hacer con lo que no cabe en un bundle: `node-pty` (nativo) y el ejecutable de Claude Code
que trae el SDK (~380 MB por plataforma).

## Decisión

1. **esbuild**, un bundle ESM por proceso (`daemon.mjs`, `pty-host.mjs`, `nexo.mjs`, `nexo-mcp.mjs`). Es una sola
   dependencia de desarrollo, entiende los imports `.ts` con extensión que usa el repositorio y no exige tocar el
   código de producción más allá de dos rutas relativas al módulo (el host de PTY y la web). El SDK de Claude, el
   SDK de MCP y `ws` entran en el bundle; las importaciones dinámicas del SDK se resuelven en tiempo de build.
2. **`external`: `node-pty`** (y los addons opcionales de `ws`, que solo se cargan si existen). Se copia junto al
   bundle (`daemon/node_modules/node-pty`) con su `lib`, `package.json` y SOLO el binario nativo de la plataforma
   (prebuilds en Windows, `build/Release` en Linux). El `pty-host` es un bundle aparte que el supervisor lanza con
   `fork` y que resuelve `node-pty` desde la misma carpeta.
3. **Node oficial como recurso** (`bundle.resources`), no como `externalBin`: con `externalBin` Tauri deja el
   ejecutable junto al binario de la app y, en el `.deb`, acabaría como `/usr/bin/node` pisando el del sistema. Como
   recurso queda en `<recursos>/nexo/node/`. Se descarga solo al construir, se comprueba contra SHA-256 **fijados
   en el repositorio** (`tools/package/node-hashes.json`) y además contra el `SHASUMS256.txt` de nodejs.org.
   Los hashes fijados protegen aunque nodejs.org estuviera comprometido; el cruce con `SHASUMS256.txt` detecta un
   fijado equivocado. Nunca se descarga nada en ejecución.
4. **Claude Code no se empaqueta por omisión.** Es un binario de ~380 MB por plataforma; `--with-claude` lo copia a
   `vendor/` y el daemon lo usa si `NEXO_CLAUDE_EXECUTABLE` no manda. F6.2 decide si los instaladores lo llevan.
5. **El manifiesto manda.** `manifest.json` lista cada archivo con su SHA-256 y el archivo oficial de Node del que
   salió; `verify-bundle` y el smoke test lo comprueban.
6. La configuración de Tauri del paquete vive en `tauri.bundle.conf.json` y se mezcla con `tauri build --config`.
   El `tauri.conf.json` base no cambia, así que `cargo test`/`clippy` y `tauri dev` no necesitan el paquete
   construido (tauri-build exige que existan los recursos declarados).

## Consecuencias

- El paquete se construye por plataforma (node-pty es nativo): Linux en Ubuntu, Windows en Windows.
- Sin `--with-claude`, el proveedor Claude necesita `NEXO_CLAUDE_EXECUTABLE`; los demás proveedores no cambian.
- Tamaño aproximado: ~130 MB sin comprimir en Linux (122 MB son el Node oficial).
