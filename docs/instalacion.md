# Instalación

Nexo Workspace se instala con un instalador por sistema. Todos llevan **su propio Node 24 y el daemon**: no hace falta
instalar Node, pnpm ni clonar el repositorio. Los instaladores salen del workflow `Release` (ver
[Arquitectura](ARCHITECTURE.md#instaladores-y-release-f62)) y, de momento, **no están firmados**.

| Sistema | Instalador | Notas |
| ------- | ---------- | ----- |
| Windows 10/11 (x64) | `nexo-workspace_<versión>_windows_x64-setup.exe` (NSIS) | Por usuario: no pide administrador. Lo recomendado. |
| Windows 10/11 (x64) | `nexo-workspace_<versión>_windows_x64.msi` | Para despliegues con herramientas MSI. |
| Linux (x64) | `nexo-workspace_<versión>_linux_x64.deb` | Debian, Ubuntu y derivadas. |
| Linux (x64) | `nexo-workspace_<versión>_linux_x64.AppImage` | Cualquier distribución con WebKitGTK 4.1. |

## Requisitos

- **Windows**: 10 u 11 de 64 bits con WebView2 (viene con Windows 11; el instalador lo descarga si falta en Windows 10).
- **Linux**: 64 bits con `libwebkit2gtk-4.1` y `libgtk-3` (el `.deb` los declara como dependencias; la AppImage los
  espera en el sistema). Para la bandeja hace falta `libayatana-appindicator3`. Un entorno gráfico (X11 o Wayland).
- Los proveedores de agentes se instalan aparte, cada uno a su manera (ver [Proveedores](#proveedores-y-sus-sesiones)).
  Sin ninguno, Nexo funciona igual como espacio de terminales.

## Verificar la descarga

Cada release publica `SHA256SUMS` junto a los instaladores. Descarga ambos a la misma carpeta y comprueba:

```bash
# Linux
sha256sum --check --ignore-missing SHA256SUMS
```

```powershell
# Windows (PowerShell): compara el hash con la línea del archivo en SHA256SUMS
Get-FileHash .\nexo-workspace_<versión>_windows_x64-setup.exe -Algorithm SHA256
Select-String nexo-workspace_ .\SHA256SUMS
```

Las sumas solo prueban que el archivo no cambió respecto al que publicó el workflow; **no sustituyen a una firma**.

## Instalar

### Windows (NSIS)

Ejecuta `nexo-workspace_<versión>_windows_x64-setup.exe`. Se instala por usuario en
`%LOCALAPPDATA%\Programs\Nexo Workspace` (sin administrador), crea el acceso directo del menú Inicio y el desinstalador.
Instalación silenciosa en una carpeta concreta: `setup.exe /S /D=C:\Ruta\Nexo` (`/D` va siempre al final y sin comillas).

**Aviso de SmartScreen.** Como el instalador no está firmado, Windows muestra «Windows protegió su PC». Es lo esperado:
comprueba antes la suma SHA-256, pulsa **Más información** y después **Ejecutar de todas formas**. Cuando haya firma, este
aviso desaparecerá.

### Windows (MSI)

`msiexec /i nexo-workspace_<versión>_windows_x64.msi` (o `/qn` para silencioso). Instala para todos los usuarios y pide
administrador. Desinstalar: `msiexec /x nexo-workspace_<versión>_windows_x64.msi`. También lo marca SmartScreen.

### Linux (.deb)

```bash
sudo apt install ./nexo-workspace_<versión>_linux_x64.deb
```

Instala el ejecutable en `/usr/bin` y el paquete (Node, daemon, CLI, web) en `/usr/lib/Nexo Workspace/nexo`. Aparece en el
menú de aplicaciones. Desinstalar: `sudo apt remove nexo-desktop`.

### Linux (AppImage)

```bash
chmod +x nexo-workspace_<versión>_linux_x64.AppImage
./nexo-workspace_<versión>_linux_x64.AppImage
```

**Aviso de la AppImage sin firma.** No está firmada ni integra sola el menú: es un archivo ejecutable que descargas de
internet, así que verifica antes la suma. Si tu sistema no tiene FUSE 2, extrae y ejecuta sin él:
`./nexo-workspace_<versión>_linux_x64.AppImage --appimage-extract` y lanza `squashfs-root/AppRun`.

## Actualizar

No hay actualización automática todavía. Instala la versión nueva **encima** de la anterior:

- **NSIS**: ejecuta el instalador nuevo; detiene el daemon viejo antes de reemplazar los archivos.
- **MSI / .deb**: instala el paquete nuevo (`apt install ./...`). Si el daemon anterior sigue vivo, detenlo con
  `nexo daemon stop` (o reinicia la sesión) para que la app arranque el nuevo.
- **AppImage**: sustituye el archivo.

El estado y la configuración se conservan entre versiones.

## Desinstalar

- **Windows**: Configuración > Aplicaciones > Nexo Workspace, o `"%LOCALAPPDATA%\Programs\Nexo Workspace\uninstall.exe" /S`.
  Si el daemon sigue corriendo, el desinstalador lo detiene primero.
- **Linux**: `sudo apt remove nexo-desktop`. Borra el archivo de la AppImage para quitarla.

**Desinstalar no borra tus datos** (ver abajo). Si quieres empezar de cero, borra el directorio de estado a mano
después de desinstalar. Si el daemon seguía vivo al desinstalar el `.deb` o el MSI, termínalo antes con
`nexo daemon stop`.

## Dónde quedan tus datos

| Qué | Windows | Linux |
| --- | ------- | ----- |
| Estado, configuración y logs | `%LOCALAPPDATA%\Nexo` | `$XDG_STATE_HOME/nexo` o `~/.local/state/nexo` |

`NEXO_STATE_DIR` cambia esa carpeta. Dentro están el registro del daemon (`daemon.log`, rotado a 2 MB), `daemon.json` y el
token (solo para tu usuario), la memoria y sus ajustes (`memory-settings.json`), la mascota elegida
(`companion-settings.json`) y las mascotas instaladas (`companions/`). El instalador no escribe ahí nunca y el
desinstalador tampoco lo toca. El programa (solo lectura) queda en la carpeta de instalación; los datos de la ventana
(WebView) los guarda el sistema bajo el identificador `dev.nexo.workspace`.

El daemon corre **separado de la ventana**: cerrar la app no detiene tus terminales ni agentes. Para pararlo del todo,
`nexo daemon stop` (el lanzador `nexo` está en `<instalación>/nexo/bin`; en Windows `nexo.cmd`).

## Proveedores y sus sesiones

Cada proveedor usa **su propia sesión, la que tú iniciaste con su herramienta**. Nexo no hace login, no lee ni copia
credenciales y no toca sus carpetas de configuración (por ejemplo `~/.claude`): lanza el programa del proveedor como proceso
hijo y este lee su propia sesión.

- **Claude Code**: los instaladores **no** lo incluyen (pesaría unos 380 MB). Instálalo con su instalador oficial e inicia
  sesión con `claude`. Nexo busca, en este orden: `NEXO_CLAUDE_EXECUTABLE`; `vendor/claude` del paquete (solo si se
  construyó con `--with-claude`); el `claude` ejecutable de tu `PATH`; y `~/.local/bin/claude` (`%USERPROFILE%\.local\bin\claude.exe`
  en Windows). Solo comprueba que el archivo exista y se pueda ejecutar. En Windows hace falta `claude.exe` (los `.cmd` de npm
  no se pueden lanzar sin shell). Si no lo encuentra, el proveedor aparece «no disponible» con el motivo y la forma de
  arreglarlo; reinicia Nexo (`nexo daemon stop` y abre la app) después de instalarlo.
- **Codex, Gemini/ACP, Antigravity (`agy`)**: instálalos e inicia sesión con su propia herramienta; Nexo los busca en el `PATH` o
  por sus variables (`NEXO_CODEX_EXECUTABLE`, etc.).
- **Ollama**: local, en `http://127.0.0.1:11434` (o `NEXO_OLLAMA_URL`).

Si arrancas Nexo desde el menú y no desde una terminal, tu `PATH` puede ser más corto que el de tu shell: define la variable
`NEXO_*_EXECUTABLE` correspondiente o instala el proveedor en una ruta estándar.

## Mascota de ejemplo (opcional)

«Sin mascota» es lo predeterminado y el instalador **no instala ninguna por su cuenta**. El paquete trae a Robi en
`<instalación>/nexo/companions/robi`; para usarla, copia esa carpeta a `<estado>/companions/` y elígela en la interfaz
(ver [Mascotas](mascotas.md)):

```bash
# Linux (.deb)
mkdir -p ~/.local/state/nexo/companions && cp -r "/usr/lib/Nexo Workspace/nexo/companions/robi" ~/.local/state/nexo/companions/
```

```powershell
# Windows (NSIS)
Copy-Item -Recurse "$env:LOCALAPPDATA\Programs\Nexo Workspace\nexo\companions\robi" "$env:LOCALAPPDATA\Nexo\companions\"
```

## Migrar desde desarrollo

La versión instalada y la de desarrollo (`pnpm dev`, `apps/daemon` del repositorio) usan **el mismo directorio de estado**, así
que tus datos ya están. Conviene:

1. Detener el daemon de desarrollo (`nexo daemon stop`, o Ctrl+C si lo lanzaste a mano): solo puede haber un daemon por
   directorio de estado.
2. Instalar y abrir Nexo Workspace: arranca su daemon empaquetado sobre el mismo estado.
3. Para usar la CLI empaquetada en cualquier terminal, pon `<instalación>/nexo/bin` en el `PATH` (o enlázala:
   `ln -s "<instalación>/nexo/bin/nexo" ~/.local/bin/nexo`). Quita antes el `nexo` de desarrollo si lo tenías enlazado.
4. Si quieres mantener ambos a la vez, dale al de desarrollo otro `NEXO_STATE_DIR`.

## Para quien construye los instaladores

Los instaladores los construye el CI (`.github/workflows/release.yml`); no hace falta construirlos a mano. Resumen:

```bash
pnpm install --frozen-lockfile
pnpm --filter @nexo/web build
node tools/package/build-bundle.mjs                                   # paquete de ejecución
pnpm --filter @nexo/desktop exec tauri build --config src-tauri/tauri.bundle.conf.json --bundles deb,appimage   # o nsis,msi
node tools/package/installer-smoke.mjs --dir apps/desktop/src-tauri/target/release/bundle   # INSTALA de verdad: solo en CI o una VM
```

- **Versión única**: la fuente es `version` de `package.json` (raíz). `node tools/version/sync-version.mjs --set 0.2.0` la copia
  a todos los `package.json`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json` y a las constantes del daemon y la CLI; sin
  argumentos solo comprueba, y `pnpm check` falla si algo no coincide.
- **Publicar**: sube la versión, haz merge y crea la etiqueta `v<versión>` (debe coincidir con `package.json`). El workflow
  construye, prueba los instaladores y deja un **borrador** de release con instaladores y `SHA256SUMS`; publicarlo es manual.
- **Icono**: el maestro es `apps/desktop/icon.svg`. Regenera todos los tamaños con `pnpm tauri icon icon.svg` desde `apps/desktop`.
