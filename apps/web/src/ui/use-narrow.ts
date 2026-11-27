import { createSignal, onCleanup } from 'solid-js'

/** Por debajo de este ancho (px) la barra lateral es un cajón superpuesto; el CSS usa el mismo valor. */
export const DRAWER_BREAKPOINT = 760

/** ¿La ventana es más estrecha que `DRAWER_BREAKPOINT`? Sigue los cambios de tamaño; sin `matchMedia` es «no». */
export function createNarrow(breakpoint = DRAWER_BREAKPOINT): () => boolean {
  const query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(`(max-width: ${breakpoint - 0.02}px)`)
      : undefined
  const [narrow, setNarrow] = createSignal(query?.matches ?? false)
  if (query !== undefined) {
    const onChange = (e: { matches: boolean }) => setNarrow(e.matches)
    query.addEventListener?.('change', onChange)
    onCleanup(() => query.removeEventListener?.('change', onChange))
  }
  return narrow
}
