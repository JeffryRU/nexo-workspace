# ADR 0007 — Memoria observacional para todos los agentes

- Estado: propuesta (se implementa después de F3, cuando haya al menos dos proveedores)
- Fecha: 2026-11-24
- Inspiración: la «Observational Memory» de Mastra (Mastra Code). No usamos Mastra; tomamos la idea.

## Contexto

En Mastra, dos agentes en segundo plano mantienen la memoria:

- el **Observador** resume en notas el historial cada ~30k tokens, con una compresión de entre 5 y 40 veces;
- el **Reflector** condensa esas notas cuando superan ~40k tokens.

El contexto queda en tres niveles: los mensajes recientes tal cual, las observaciones y las reflexiones.
El historial nunca crece sin límite. Mastra puede hacerlo porque **controla la ventana de contexto**: quita
los mensajes ya observados y pone las observaciones en su lugar.

Nexo no controla la ventana de contexto de Claude Code, Codex, Gemini ni Antigravity: cada CLI tiene la
suya y compacta a su manera. Pero Nexo sí tiene algo que ninguno de ellos tiene: **la transcripción
normalizada de todos los agentes** (los `Block` del documento), en un solo formato.

## Decisión

La memoria observacional vive en el **daemon** y trabaja sobre la transcripción normalizada. Así sirve
igual para todos los proveedores. Los adaptadores solo saben **inyectar** el resultado.

1. **Observador:** cuando una sesión acumula N tokens nuevos (por defecto 6k por lote), un modelo
   barato, configurable, escribe observaciones fechadas y con prioridad. Puede ser Ollama local, Haiku o
   Gemini Flash. Cada observación guarda el rango de bloques de donde salió, para poder volver al texto
   original.
2. **Reflector:** cuando las observaciones de un proyecto superan M tokens (por defecto 40k), reescribe
   el registro completo: condensa más lo antiguo y conserva el detalle de lo reciente.
3. **Alcance:** por sesión y por **proyecto** (carpeta del espacio). Lo que hizo Claude en un proyecto lo
   sabe Codex al abrir una sesión nueva en esa carpeta.
4. **Inyección:** puerto `MemoryInjectionPort`, con una implementación por proveedor:

   | Proveedor               | Al empezar la sesión                                                   | Cuando el CLI compacta su contexto                                                |
   | ----------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
   | Claude Code (Agent SDK) | `systemPrompt.append` o el hook `SessionStart` con `additionalContext` | hook `SessionStart` con origen `compact`: se vuelven a inyectar las observaciones |
   | Codex (`app-server`)    | `developerInstructions` de `thread/start` (verificado en F3.5.3)       | hilo nuevo sembrado con las observaciones                                         |
   | Gemini / ACP            | primer bloque de contexto de `session/new` o el primer prompt          | sesión nueva sembrada                                                             |
   | Antigravity (`agy`)     | prefijo del primer mensaje en `stream-json`                            | sesión nueva sembrada                                                             |

Implementado en F3.5.3 (ver ARCHITECTURE, «Inyección por proveedor»): en Antigravity, Codex, ACP y Ollama el CLI compacta por su cuenta sin
que Nexo lo vea, así que su columna «al compactar» se cubre con la renovación (punto 5) y no con un gancho propio.

5. **Renovación (el «encogimiento»):** como no podemos quitar mensajes de un CLI que ya está corriendo,
   se ofrece **renovar la sesión** cuando su contexto pasa el umbral. Se abre una sesión nueva sembrada
   con las reflexiones, las observaciones y los últimos turnos tal cual. En la interfaz se ve como la misma
   pestaña. Es opcional por proveedor, porque se pierde la caché de prompts del CLI.
6. **Recuerdo bajo demanda:** el servidor MCP de Nexo expone `memory.search` y `memory.recall(rango)`.
   Todos estos CLIs hablan MCP, así que cualquier agente puede consultar las observaciones o el texto
   original detrás de una de ellas.

## Consecuencias

- **Costo:** el Observador y el Reflector consumen tokens de un modelo aparte. Se pueden apagar, usan un
  modelo barato o local por defecto, y la interfaz muestra cuánto gastan.
- **Privacidad:** las observaciones se guardan en el directorio de estado del usuario y nunca salen de
  la máquina, salvo hacia el modelo del Observador. Con Ollama no sale nada.
- **Seguridad:** las observaciones son texto que vuelve a entrar a un agente, así que es un vector de
  inyección de prompts. Se guardan como datos, se inyectan dentro de un bloque delimitado, y el
  Observador recibe la instrucción de no copiar órdenes del texto observado. Las pruebas adversariales
  incluyen transcripciones con órdenes hostiles.
- El dominio (umbrales, lotes, rangos, reescritura) es puro y se prueba con falsos en `core`. Los modelos
  del Observador y del Reflector son adaptadores de un `SummarizerPort`.
