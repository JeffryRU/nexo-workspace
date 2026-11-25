const START = 'tab-switch-start'
const END = 'tab-switch-end'

declare global {
  // Muestras de `tab-switch` (ms) para la prueba de rendimiento de la F1.8.
  var __NEXO_PERF__: { tabSwitch: number[] } | undefined
}

const MAX_SAMPLES = 200

/**
 * Mide un cambio de pestaña con `performance.mark/measure('tab-switch')`. Solid actualiza el DOM de forma
 * síncrona dentro de `fn`, así que la medida cubre el trabajo de la interfaz.
 */
export function measureTabSwitch(fn: () => void): number | undefined {
  const perf: Performance | undefined = globalThis.performance
  if (perf === undefined || typeof perf.mark !== 'function') {
    fn()
    return undefined
  }
  try {
    perf.mark(START)
    fn()
    perf.mark(END)
    const m = perf.measure('tab-switch', START, END)
    const store = globalThis.__NEXO_PERF__ ?? { tabSwitch: [] }
    globalThis.__NEXO_PERF__ = store
    store.tabSwitch.push(m.duration)
    if (store.tabSwitch.length > MAX_SAMPLES) store.tabSwitch.shift()
    return m.duration
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
