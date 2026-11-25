declare global {
  // Muestras de `tab-switch` (ms) para la prueba de rendimiento de la F1.8.
  var __NEXO_PERF__: { tabSwitch: number[]; tabSwitchRaw: number[] } | undefined
}

const MAX_SAMPLES = 200

const pending: (() => void)[] = []
let channel: MessageChannel | undefined

/** Ejecuta `cb` en una tarea posterior al fotograma actual (después de que el navegador pinte). */
function afterFrame(cb: () => void): void {
  try {
    if (channel === undefined) {
      channel = new MessageChannel()
      channel.port1.onmessage = () => {
        for (const run of pending.splice(0)) run()
      }
    }
    pending.push(cb)
    channel.port2.postMessage(null)
  } catch {
    setTimeout(cb, 0)
  }
}

function record(perf: Performance, start: number, work: number, raw: number): void {
  const store = globalThis.__NEXO_PERF__ ?? { tabSwitch: [], tabSwitchRaw: [] }
  globalThis.__NEXO_PERF__ = store
  store.tabSwitch.push(work)
  store.tabSwitchRaw.push(raw)
  if (store.tabSwitch.length > MAX_SAMPLES) store.tabSwitch.shift()
  if (store.tabSwitchRaw.length > MAX_SAMPLES) store.tabSwitchRaw.shift()
  try {
    perf.measure('tab-switch', { start, duration: work })
  } catch {
    // sin soporte de measure con opciones: las muestras ya quedaron registradas
  }
}

/**
 * Mide un cambio de pestaña hasta el siguiente fotograma pintado. `tab-switch` (`performance.measure` y
 * `__NEXO_PERF__.tabSwitch`) es el trabajo de la interfaz: lo que tarda `fn` (Solid actualiza el DOM de forma
 * síncrona) más lo que tarda el navegador en procesar ese fotograma (estilos, distribución y pintado), desde
 * que arranca su `requestAnimationFrame` hasta la tarea siguiente. No incluye la espera hasta el próximo
 * vsync, que depende de la pantalla y no de la aplicación; `tabSwitchRaw` sí la incluye (del evento al
 * fotograma pintado). Devuelve de inmediato lo que tardó `fn`; sin `requestAnimationFrame` (pruebas en jsdom)
 * la muestra es solo esa.
 */
export function measureTabSwitch(fn: () => void): number | undefined {
  const perf: Performance | undefined = globalThis.performance
  if (perf === undefined || typeof perf.now !== 'function') {
    fn()
    return undefined
  }
  try {
    const start = perf.now()
    fn()
    const sync = perf.now() - start
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      record(perf, start, sync, sync)
      return sync
    }
    globalThis.requestAnimationFrame(() => {
      const frameStart = perf.now()
      afterFrame(() => {
        const end = perf.now()
        record(perf, start, sync + (end - frameStart), end - start)
      })
    })
    return sync
  } catch {
    return undefined
  }
}

/** Muestras de `tab-switch` registradas (ms), para pruebas y para la F1.8. */
export function tabSwitchSamples(): number[] {
  return globalThis.__NEXO_PERF__?.tabSwitch ?? []
}

export function resetTabSwitchSamples(): void {
  globalThis.__NEXO_PERF__ = undefined
}
