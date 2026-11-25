// node-pty (Unix) escribe en la PTY con una cola propia y, si el descriptor se cierra con una escritura en
// vuelo (el hijo murió o se pidió kill), imprime con `console.error('Unhandled pty write error', err)` sin dar
// forma de capturarlo ni de cancelar esa escritura. Es una escritura a una PTY ya cerrada, que el puerto define
// como no-op, así que se descarta exactamente ese aviso (mensaje y EBADF) mientras haya terminales vivas.
// Cualquier otro error, de node-pty o de otro código, sigue llegando a `console.error`.

const MESSAGE = 'Unhandled pty write error'
const GRACE_MS = 250

let active = 0
let original: typeof console.error | undefined
let installed: typeof console.error | undefined

function isClosedPtyWrite(args: readonly unknown[]): boolean {
  const [message, error] = args
  return (
    args.length === 2 &&
    message === MESSAGE &&
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EBADF'
  )
}

/** Activa el filtro hasta que se llame al `release` devuelto (más un margen para escrituras en vuelo). */
export function acquireWriteErrorFilter(): () => void {
  if (active++ === 0) {
    original = console.error
    const base = original
    installed = (...args: unknown[]) => {
      if (!isClosedPtyWrite(args)) base.apply(console, args)
    }
    console.error = installed
  }
  let released = false
  return () => {
    if (released) return
    released = true
    setTimeout(() => {
      if (--active === 0 && original !== undefined) {
        // Si otro código reemplazó console.error mientras tanto, no se pisa.
        if (console.error === installed) console.error = original
        original = undefined
        installed = undefined
      }
    }, GRACE_MS).unref()
  }
}
