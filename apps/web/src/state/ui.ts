import { createSignal } from 'solid-js'
import { DEFAULT_KEYMAP, type KeyMap } from '../shortcuts/keymap.ts'

/** Estado de interfaz local (no viaja al daemon). */
export function createUiState(keymap: KeyMap = DEFAULT_KEYMAP) {
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string | undefined>()
  const [helpOpen, setHelpOpen] = createSignal(false)
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const [swapSource, setSwapSource] = createSignal<string | undefined>()
  const [editing, setEditing] = createSignal<string | undefined>()
  let errorTimer: ReturnType<typeof setTimeout> | undefined

  return {
    keymap,
    activeWorkspaceId,
    setActiveWorkspaceId,
    helpOpen,
    setHelpOpen,
    searchOpen,
    setSearchOpen,
    error,
    swapSource,
    setSwapSource,
    /** Clave del elemento que se está renombrando en línea (`ws:<id>`, `tab:<id>`). */
    editing,
    setEditing,
    showError(message: string): void {
      setError(message.slice(0, 300))
      if (errorTimer !== undefined) clearTimeout(errorTimer)
      errorTimer = setTimeout(() => setError(undefined), 6000)
    },
    dismissError(): void {
      if (errorTimer !== undefined) clearTimeout(errorTimer)
      setError(undefined)
    },
  }
}

export type UiState = ReturnType<typeof createUiState>
