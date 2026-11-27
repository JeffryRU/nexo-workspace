import { fireEvent, render, screen } from '@solidjs/testing-library'
import { createSignal, Show } from 'solid-js'
import { describe, expect, it, vi } from 'vitest'
import { Dialog, DialogHeader } from './Dialog.tsx'

describe('DialogHeader', () => {
  it('título y cerrar por icono en la misma cabecera; el cerrar lleva aria-label y title', () => {
    const onClose = vi.fn()
    const { container } = render(() => (
      <DialogHeader title="Historial" closeLabel="Cerrar" onClose={onClose} />
    ))
    const header = container.querySelector('.dialog-header')
    expect(header?.querySelector('h2')?.textContent).toBe('Historial')
    const close = screen.getByRole('button', { name: 'Cerrar' })
    expect(header?.contains(close)).toBe(true)
    expect(close.getAttribute('title')).toBe('Cerrar')
    expect(close.classList.contains('icon-button')).toBe(true)
    expect(close.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    expect(close.textContent).toBe('')
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('Dialog', () => {
  it('es un diálogo modal con nombre, enfoca la caja y cierra con Esc', () => {
    const onClose = vi.fn()
    render(() => (
      <Dialog label="Memoria" closeLabel="Cerrar" onClose={onClose}>
        <button type="button">dentro</button>
      </Dialog>
    ))
    const dialog = screen.getByRole('dialog', { name: 'Memoria' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(dialog)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('onEscape sustituye al cierre (volver un paso atrás)', () => {
    const onClose = vi.fn()
    const onEscape = vi.fn()
    render(() => (
      <Dialog label="Historial" closeLabel="Cerrar" onClose={onClose} onEscape={onEscape}>
        x
      </Dialog>
    ))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('atrapa Tab: del último botón pasa al primero (el cerrar de la cabecera)', () => {
    render(() => (
      <Dialog label="Mascota" closeLabel="Cerrar" onClose={() => {}}>
        <button type="button">último</button>
      </Dialog>
    ))
    screen.getByRole('button', { name: 'último' }).focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cerrar' }))
  })

  it('al cerrarse devuelve el foco a lo que lo tenía', () => {
    function Host() {
      const [open, setOpen] = createSignal(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            abrir
          </button>
          <Show when={open()}>
            <Dialog label="D" closeLabel="Cerrar" onClose={() => setOpen(false)}>
              x
            </Dialog>
          </Show>
        </>
      )
    }
    render(() => <Host />)
    const opener = screen.getByRole('button', { name: 'abrir' })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('refocus devuelve el foco a la caja cuando cambia la vista', async () => {
    const [view, setView] = createSignal(0)
    render(() => (
      <Dialog label="D" closeLabel="Cerrar" onClose={() => {}} refocus={view}>
        <button type="button">paso</button>
      </Dialog>
    ))
    screen.getByRole('button', { name: 'paso' }).focus()
    setView(1)
    await Promise.resolve()
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })
})
