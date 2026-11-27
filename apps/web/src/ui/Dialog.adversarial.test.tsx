import { fireEvent, render, screen } from '@solidjs/testing-library'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from './Dialog.tsx'

describe('Dialog (adversarial)', () => {
  it('un título larguísimo, con emojis, RTL o marcado no rompe la cabecera', () => {
    const titles = [
      'Historial '.repeat(5000),
      '😀👩‍👩‍👧‍👦'.repeat(200),
      'مرحبا بالعالم '.repeat(300),
      '<img src=x onerror=1>',
    ]
    for (const title of titles) {
      const { container, unmount } = render(() => (
        <Dialog label={title} closeLabel="Cerrar" onClose={() => {}}>
          cuerpo
        </Dialog>
      ))
      const h2 = container.querySelector('h2')
      expect(h2?.classList.contains('ellipsis')).toBe(true)
      expect(h2?.getAttribute('title')).toBe(title)
      expect(container.querySelectorAll('img').length).toBe(0)
      expect(screen.getByRole('button', { name: 'Cerrar' })).toBeTruthy()
      unmount()
    }
  })

  it('Esc y Tab a ráfagas llaman una vez por pulsación y no lanzan', () => {
    const onClose = vi.fn()
    render(() => (
      <Dialog label="D" closeLabel="Cerrar" onClose={onClose}>
        <button type="button">a</button>
      </Dialog>
    ))
    const dialog = screen.getByRole('dialog')
    for (let i = 0; i < 300; i++) fireEvent.keyDown(dialog, { key: i % 3 === 0 ? 'Escape' : 'Tab' })
    expect(onClose).toHaveBeenCalledTimes(100)
  })

  it('un cuerpo enorme queda en el cuerpo con desplazamiento, bajo la cabecera', () => {
    const { container } = render(() => (
      <Dialog label="D" closeLabel="Cerrar" onClose={() => {}}>
        {Array.from({ length: 3000 }, (_, i) => (
          <p>{i}</p>
        ))}
      </Dialog>
    ))
    expect(container.querySelector('.dialog-body')?.querySelectorAll('p').length).toBe(3000)
    expect(container.querySelector('.modal > .dialog-header')).not.toBeNull()
  })
})
