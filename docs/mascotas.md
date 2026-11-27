# Mascotas

Nexo funciona al 100 % sin mascota. Si quieres una, hay dos caminos:

1. **Un paquete de mascota** (solo imágenes y un JSON, sin código): Nexo la dibuja en una esquina de la ventana y
   la cambia según lo que hacen tus agentes. Es lo más fácil. Ver [Parte 1](#parte-1-crear-un-paquete).
2. **Una mascota externa** (su propia app, con su propia lógica o IA): se conecta a Nexo como un cliente más, por
   MCP o por WebSocket, y solo lee. Ver [Parte 2](#parte-2-conectar-una-mascota-externa).

Los detalles de diseño están en [ARCHITECTURE.md](ARCHITECTURE.md) («Compañeros») y en el
[ADR 0006](adr/0006-mascotas-intercambiables.md).

## Parte 1: crear un paquete

Un paquete es una carpeta con un `companion.json` y las imágenes que declara. No contiene ni admite código: Nexo
solo lee el JSON y las imágenes que nombra, y el resto de archivos de la carpeta se ignora.

### Estados

La mascota muestra uno de seis estados, que salen de la atención de todos los agentes (la misma prioridad que
`nexo://attention`):

| Estado     | Cuándo                                         | Se queda al menos                |
| ---------- | ---------------------------------------------- | -------------------------------- |
| `waiting`  | algún agente espera un permiso o una respuesta | 2 s                              |
| `error`    | algún agente falló (y ninguno espera)          | 2,5 s                            |
| `busy`     | dos o más agentes trabajando                   | 1 s                              |
| `thinking` | un agente trabajando                           | 1 s                              |
| `done`     | terminó un turno (y nada más pide atención)    | 2,5 s; a los 6 s vuelve a `idle` |
| `idle`     | no hay nada que mostrar                        | -                                |

`idle` es **obligatorio**. Los demás son opcionales: un estado que no declaras (o cuya imagen falla) se dibuja con
la imagen de `idle`. Si falla incluso `idle`, Nexo no dibuja nada (nunca una imagen rota).

### Ejemplo completo

```
robi/
  companion.json
  idle.png
  pensando.gif
  hoja-espera.png
  img/hecho.webp
  error.svg
```

`companion.json`:

```json
{
  "format": 1,
  "id": "robi",
  "name": "Robi",
  "version": "1.0.0",
  "description": "Un robot sencillo.",
  "author": { "name": "Tu nombre", "url": "https://ejemplo.org" },
  "license": "CC0-1.0",
  "states": {
    "idle": { "src": "idle.png" },
    "thinking": { "src": "pensando.gif" },
    "waiting": {
      "src": "hoja-espera.png",
      "sheet": {
        "frameWidth": 32,
        "frameHeight": 32,
        "frames": 4,
        "columns": 4,
        "fps": 6,
        "loop": true
      }
    },
    "busy": { "src": "idle.png" },
    "done": { "src": "img/hecho.webp" },
    "error": { "src": "error.svg" }
  }
}
```

Reglas del manifiesto (el esquema es estricto: un campo que no existe es un error):

- `format` es `1`. `id` es el nombre de la carpeta: minúsculas, dígitos, `-` y `_` (hasta 48 caracteres, empieza por
  letra o dígito). No puede ser un nombre reservado de Windows (`con`, `nul`, `com1`...).
- `name`, `description` y `author.name` son texto corto sin saltos ni caracteres de control. `author.url` es opcional y
  tiene que ser `https`. `version` es `x.y.z` (con `-pre` opcional). `license` es un id SPDX (`CC0-1.0`, `MIT`...).
- `src` es una ruta **relativa** con `/`, de hasta 4 segmentos de `[A-Za-z0-9._-]` (sin empezar ni acabar en punto),
  hasta 128 caracteres y extensión de imagen. Quedan fuera `..`, rutas absolutas, `C:`, UNC, `\`, espacios y flujos
  alternos (`a.png:x`).
- Varios estados pueden usar la misma imagen (se pide una sola vez).

### Formatos y topes

| Qué                 | Tope                                     |
| ------------------- | ---------------------------------------- |
| Formatos            | PNG, WebP, GIF y SVG                     |
| `companion.json`    | 64 KiB                                   |
| Cada imagen         | 512 KiB                                  |
| Todo el paquete     | 8 MiB                                    |
| Tamaño de la imagen | 4096 px por lado (se lee del encabezado) |
| Paquetes listados   | 64                                       |

El tipo se comprueba por los **bytes**, no por el nombre: un `.png` que en realidad es un GIF, HTML o texto se
rechaza. Los enlaces simbólicos, las uniones y los enlaces duros dentro del paquete también se rechazan.

### Hojas de sprites (`sheet`)

Para animar un estado, declara una hoja: cuadros del mismo tamaño en filas de `columns` (por omisión, todos en
una fila). Nexo la anima en la ventana mostrando un cuadro cada `1000 / fps` ms.

- `frameWidth`, `frameHeight`: tamaño de un cuadro; `frames`: cuántos; `columns` (opcional): cuántos por fila;
  `fps`: de 0,1 a 60; `loop` (opcional, `true` por omisión): si es `false`, se queda en el último cuadro.
- La hoja tiene que caber en la imagen. Los cuadros se leen de izquierda a derecha y de arriba abajo.
- Con `prefers-reduced-motion` del sistema, la hoja queda **fija en el primer cuadro**.
- Un GIF o WebP animado lo anima el navegador y **no se puede pausar** con `prefers-reduced-motion`; si quieres
  respetarlo, usa una hoja de sprites.
- La imagen se dibuja en un recuadro de 96 px: si el cuadro es más pequeño se amplía en múltiplos enteros
  (`image-rendering: pixelated`), así el pixel art no se ve borroso.

### Reglas del SVG

SVG es el único formato que puede llevar código, así que se acepta con condiciones. Nexo **rechaza** (no
sanea) el archivo si contiene: `<script>`, `<foreignObject>`, `<iframe>`, `<embed>`, `<object>`, `<audio>`,
`<video>`, `<link>` o `<meta>`; atributos `on...=`; `javascript:`, `vbscript:` o `data:text`/`data:image/svg`; entidades
(`<!ENTITY`) o referencias de carácter distintas de `&amp; &lt; &gt; &quot; &apos;`; `@import` o `expression(`;
animaciones de `href`; `href`/`xlink:href` que no apunten a un fragmento local (`#id`) o a una imagen
`data:` de mapa de bits; y `url()` que no apunte a un fragmento. Debe ser UTF-8 válido.

Además, la interfaz **siempre** lo dibuja como `<img>` (con un `Blob`), nunca incrustado en la página ni en
`<object>`/`<iframe>`: dentro de un `<img>` el navegador no ejecuta scripts ni carga recursos externos. Mantén el
SVG autocontenido: formas, degradados y texto; nada de fuentes ni imágenes externas.

### Dónde copiarlo

En la carpeta `companions` del directorio de datos de Nexo, una subcarpeta por mascota (el nombre de la
subcarpeta es el `id`):

| Sistema | Ruta                                              |
| ------- | ------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\Nexo\companions\<id>\`            |
| Linux   | `<directorio de estado de Nexo>/companions/<id>/` |

`NEXO_STATE_DIR` cambia el directorio de datos. No hace falta reiniciar: el daemon vuelve a leer la carpeta al listar.

### Probarla

```
nexo companion list          # paquetes válidos, los que no lo son (con el motivo) y el elegido
nexo companion get robi      # manifiesto, tamaño de cada recurso y total (valida el paquete entero)
nexo companion select robi   # la elige (queda guardada)
nexo companion state         # estado actual y mascota elegida
nexo companion none          # vuelve a «sin mascota»
```

Si `list` marca el paquete como no válido, el motivo dice qué campo o archivo falla. También puedes elegirla desde
la ventana: botón **Mascota** de la barra de estado. Para ver los estados sin esperar a un agente, pide a un agente
una tarea larga (`thinking`) o que necesite permiso (`waiting`).

### Cómo la usa la ventana

- **Dónde:** en la esquina inferior izquierda, debajo de la lista de espacios. Ocupa su propio sitio, así que no tapa
  pestañas, paneles, compositor ni barra de estado. En ventanas muy bajas (menos de 520 px de alto) se quita.
- **Ocultar:** el botón `×` de la mascota (aparece al pasar el ratón o con el teclado) o el interruptor «Mostrar la mascota
  en la ventana» del selector. Solo oculta el dibujo en esa ventana; la mascota elegida se conserva en el daemon. La
  preferencia se guarda con los demás ajustes de la interfaz (almacenamiento local de la ventana).
- **Sin mascota** es el valor por omisión y una opción más del selector, no una ausencia.
- **Accesibilidad:** la imagen lleva un texto alternativo («Robi: pensando») y un aviso discreto (`aria-live="polite"`)
  anuncia el cambio de estado.
- **Fallos:** si falla el recurso de un estado se usa `idle`; si falla todo, o el paquete se borró del disco, no se
  muestra nada y la interfaz sigue igual.

## Parte 2: conectar una mascota externa

Una mascota con su propia app (un widget flotante, una IA, un robot de escritorio) no necesita ser un paquete: se
conecta a Nexo como **cliente de solo lectura** y decide ella cómo dibujarse. Hay dos formas.

### Por MCP (`apps/mcp`)

El servidor MCP de Nexo (`apps/mcp`, por stdio) expone recursos suscribibles. Para una mascota bastan dos:

| Recurso                     | Qué es                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `nexo://attention`          | atención agregada de todas las sesiones: `needs-input` > `error` > `working` > `done` > `idle` |
| `nexo://agents/<id>/status` | estado de una sesión de agente concreta                                                        |

Léelos con `resources/read` y suscríbete con `resources/subscribe`: el servidor avisa con
`notifications/resources/updated` cada vez que cambian. Son de **solo lectura**: no hace falta activar ninguna
herramienta de escritura (`NEXO_MCP_WRITE` queda sin definir). La prioridad de `nexo://attention` es la misma que
usan los estados de la mascota, así que puedes traducirla directamente (`needs-input` = `waiting`, `working` =
`thinking`/`busy`, `done` = `done`, `error` = `error`, `idle` = `idle`).

### Por WebSocket o `@nexo/client`

El daemon habla JSON-RPC por WebSocket en `127.0.0.1` y exige el token de `daemon.json`. Con `@nexo/client` es:

```ts
import { companionApi, NexoClient } from '@nexo/client'

const client = new NexoClient(/* transporte y token, como en apps/cli */)
await client.connect()
const companion = companionApi(client)

const { state, selected } = await companion.state() // estado actual
const off = companion.onState((view) => {
  // view = { state: 'idle'|'thinking'|'waiting'|'busy'|'done'|'error', since: <ms Unix>, selected: <id>|null }
  dibujar(view.state)
})
```

`companion.state` ya viene **traducido y suavizado** (tiempos mínimos visibles, `done` que decae a `idle`), así que
una mascota externa se comporta igual que la de la ventana sin repetir esa lógica. Si no quieres usar el estado de
la mascota del daemon, puedes leer `agent.status` y `agent.session` y decidir tú. Tres cosas a tener en cuenta:

- Ignora un evento con el mismo `selected` y un `since` anterior al último que viste (llegó fuera de orden) y no
  repintes por uno repetido.
- Para las imágenes de un paquete del daemon: `companion.get { id }` una vez, y `companion.asset { id, path }` por
  cada `src` (devuelve `{ mime, bytes, data }` con `data` en base64, hasta 512 KiB). Dibújalas como imagen
  (`new Blob([bytes], { type: mime })` + `URL.createObjectURL` para un `<img>`) y **revoca** la URL al cambiar de
  mascota. Nunca incrustes un SVG en el DOM.
- Una mascota externa solo lee: no hace falta, ni conviene, que llame a `agent.send`, `agent.respond` ni a ningún
  método que cambie cosas. Nexo no lee ni copia credenciales de ningún proveedor y la mascota tampoco debería pedirlas.
