import { createSignal } from 'solid-js'
import { DEFAULT_KEYMAP, type KeyMap } from '../shortcuts/keymap.ts'

export type MemoryJump = { sessionId: string; from: number; to: number }

/** Estado de interfaz local (no viaja al daemon). */
export function createUiState(keymap: KeyMap = DEFAULT_KEYMAP) {
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string | undefined>()
  const [helpOpen, setHelpOpen] = createSignal(false)
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [memoryOpen, setMemoryOpen] = createSignal(false)
  const [historyOpen, setHistoryOpen] = createSignal(false)
  const [companionOpen, setCompanionOpen] = createSignal(false)
  /** Cajón de espacios abierto (solo existe en ventanas estrechas; no se guarda). */
  const [drawerOpen, setDrawerOpen] = createSignal(false)
  /** Ventana estrecha (< 760 px): la barra lateral es un cajón. Lo fija el banco de trabajo con `matchMedia`. */
  const [narrow, setNarrow] = createSignal(false)
  /** Bloque de origen al que debe saltar el panel de una sesión (lo pide la vista de memoria). */
  const [jump, setJump] = createSignal<MemoryJump | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const [swapSource, setSwapSource] = createSignal<string | undefined>()
  const [editing, setEditing] = createSignal<string | undefined>()
  const [windowFocused, setWindowFocused] = createSignal(true)
  let errorTimer: ReturnType<typeof setTimeout> | undefined

  return {
    keymap,
    activeWorkspaceId,
    setActiveWorkspaceId,
    helpOpen,
    setHelpOpen,
    searchOpen,
    setSearchOpen,
    memoryOpen,
    setMemoryOpen,
    historyOpen,
    setHistoryOpen,
    companionOpen,
    setCompanionOpen,
    drawerOpen,
    setDrawerOpen,
    narrow,
    setNarrow,
    jump,
    setJump,
    error,
    swapSource,
    setSwapSource,
    /** Clave del elemento que se está renombrando en línea (`ws:<id>`, `tab:<id>`). */
    editing,
    setEditing,
    /** ¿La ventana tiene el foco del usuario? (la actualiza `trackWindowFocus`; decide notificaciones y «visto»). */
    windowFocused,
    setWindowFocused,
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
