const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Elementos a los que se puede llegar con Tab dentro de `root` (visibles y no deshabilitados). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      !el.hidden &&
      el.closest('[hidden], [inert]') === null &&
      el.getAttribute('tabindex') !== '-1',
  )
}

/**
 * Atrapa el foco de Tab dentro de `root`: del último pasa al primero y al revés. Si el foco se salió (o está en el
 * propio contenedor) vuelve a un extremo. Devuelve `true` si gestionó la tecla.
 */
export function trapTab(
  root: HTMLElement,
  e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>,
): boolean {
  if (e.key !== 'Tab') return false
  const items = focusableIn(root)
  const first = items[0]
  const last = items[items.length - 1]
  if (first === undefined || last === undefined) {
    e.preventDefault()
    root.focus()
    return true
  }
  const active = root.ownerDocument.activeElement
  if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
    e.preventDefault()
    last.focus()
    return true
  }
  if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault()
    first.focus()
    return true
  }
  return false
}
