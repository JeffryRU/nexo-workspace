export type FocusTarget = {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export type FocusDocument = FocusTarget & {
  hasFocus(): boolean
  visibilityState: string
}

/**
 * ¿Tiene la ventana el foco del usuario? Cuenta el foco del documento y que esté visible (una ventana
 * minimizada o en otro escritorio no lo tiene). Llama a `onChange` con cada cambio y devuelve la baja.
 */
export function trackWindowFocus(
  win: FocusTarget,
  doc: FocusDocument,
  onChange: (focused: boolean) => void,
): () => void {
  let last: boolean | undefined
  const update = () => {
    const now = doc.hasFocus() && doc.visibilityState !== 'hidden'
    if (now === last) return
    last = now
    onChange(now)
  }
  win.addEventListener('focus', update)
  win.addEventListener('blur', update)
  doc.addEventListener('visibilitychange', update)
  update()
  return () => {
    win.removeEventListener('focus', update)
    win.removeEventListener('blur', update)
    doc.removeEventListener('visibilitychange', update)
  }
}
