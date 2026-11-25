import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  comboOf,
  DEFAULT_KEYMAP,
  isReservedCombo,
  isShellReserved,
  type KeyEventLike,
  matchShortcut,
  normalizeCombo,
  sanitizeKeyMap,
} from './keymap.ts'

const ev = (key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
})
const outside = { inTerminal: false, inEditable: false }
const inTerm = { inTerminal: true, inEditable: false }

describe('comboOf y normalizeCombo', () => {
  it('ordena modificadores y usa la tecla física para letras y dígitos', () => {
    expect(comboOf(ev('t', { altKey: true, shiftKey: true, code: 'KeyT' }))).toBe('Alt+Shift+T')
    expect(comboOf(ev('¡', { altKey: true, code: 'Digit1' }))).toBe('Alt+1')
    expect(comboOf(ev('ArrowLeft', { altKey: true }))).toBe('Alt+ArrowLeft')
    expect(comboOf(ev('p', { metaKey: true, ctrlKey: true }))).toBe('Ctrl+Meta+P')
  })

  it('normaliza el texto de una combinación', () => {
    expect(normalizeCombo('shift+alt+t')).toBe('Alt+Shift+T')
    expect(normalizeCombo('ctrl+PageDown')).toBe('Ctrl+PageDown')
    expect(normalizeCombo('?')).toBe('?')
  })
})

describe('atajos de la shell', () => {
  it.each(['c', 'd', 'r', 'z', 'l', 'a', 'e', 'k', 'u', 'w'])('Ctrl+%s va a la terminal', (k) => {
    const e = ev(k, { ctrlKey: true, code: `Key${k.toUpperCase()}` })
    expect(isShellReserved(e)).toBe(true)
    expect(matchShortcut(e, DEFAULT_KEYMAP, inTerm)).toBeUndefined()
  })

  it('ningún atajo por defecto choca con Ctrl+letra', () => {
    for (const combos of Object.values(DEFAULT_KEYMAP)) {
      for (const c of combos) expect(isReservedCombo(c)).toBe(false)
    }
  })

  it('propiedad: cualquier Ctrl+letra sin otros modificadores nunca dispara un atajo', () => {
    fc.assert(
      fc.property(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), (k) => {
        const e = ev(k, { ctrlKey: true, code: `Key${k.toUpperCase()}` })
        expect(matchShortcut(e, DEFAULT_KEYMAP, outside)).toBeUndefined()
      }),
    )
  })
})

describe('matchShortcut', () => {
  it('reconoce los atajos por defecto', () => {
    expect(
      matchShortcut(
        ev('T', { altKey: true, shiftKey: true, code: 'KeyT' }),
        DEFAULT_KEYMAP,
        inTerm,
      ),
    ).toBe('tab.new')
    expect(
      matchShortcut(
        ev('W', { altKey: true, shiftKey: true, code: 'KeyW' }),
        DEFAULT_KEYMAP,
        inTerm,
      ),
    ).toBe('pane.close')
    expect(
      matchShortcut(
        ev('D', { altKey: true, shiftKey: true, code: 'KeyD' }),
        DEFAULT_KEYMAP,
        inTerm,
      ),
    ).toBe('pane.split-right')
    expect(
      matchShortcut(
        ev('S', { altKey: true, shiftKey: true, code: 'KeyS' }),
        DEFAULT_KEYMAP,
        inTerm,
      ),
    ).toBe('pane.split-down')
    expect(matchShortcut(ev('ArrowRight', { altKey: true }), DEFAULT_KEYMAP, inTerm)).toBe(
      'pane.focus-right',
    )
    expect(matchShortcut(ev('PageDown', { ctrlKey: true }), DEFAULT_KEYMAP, inTerm)).toBe(
      'tab.next',
    )
    expect(matchShortcut(ev('PageUp', { altKey: true }), DEFAULT_KEYMAP, inTerm)).toBe('tab.prev')
    expect(matchShortcut(ev('3', { altKey: true, code: 'Digit3' }), DEFAULT_KEYMAP, inTerm)).toBe(
      'tab.goto-3',
    )
    expect(
      matchShortcut(
        ev('F', { ctrlKey: true, shiftKey: true, code: 'KeyF' }),
        DEFAULT_KEYMAP,
        inTerm,
      ),
    ).toBe('terminal.search')
    expect(
      matchShortcut(
        ev('P', { ctrlKey: true, shiftKey: true, code: 'KeyP' }),
        DEFAULT_KEYMAP,
        inTerm,
      ),
    ).toBe('help.toggle')
  })

  it('«?» abre la ayuda solo fuera de la terminal y de los campos de texto', () => {
    expect(matchShortcut(ev('?', { shiftKey: true }), DEFAULT_KEYMAP, outside)).toBe('help.toggle')
    expect(matchShortcut(ev('?', { shiftKey: true }), DEFAULT_KEYMAP, inTerm)).toBeUndefined()
    expect(
      matchShortcut(ev('?', { shiftKey: true }), DEFAULT_KEYMAP, {
        inTerminal: false,
        inEditable: true,
      }),
    ).toBeUndefined()
  })

  it('las teclas normales no disparan nada', () => {
    expect(matchShortcut(ev('a'), DEFAULT_KEYMAP, outside)).toBeUndefined()
    expect(matchShortcut(ev('Enter'), DEFAULT_KEYMAP, inTerm)).toBeUndefined()
  })
})

describe('sanitizeKeyMap', () => {
  it('acepta cambios y descarta combinaciones reservadas por la shell', () => {
    const map = sanitizeKeyMap({
      'tab.new': ['alt+n', 'Ctrl+C'],
      'pane.close': [],
      'help.toggle': ['', 'x'.repeat(100)],
    })
    expect(map['tab.new']).toEqual(['Alt+N'])
    expect(map['pane.close']).toEqual([])
    expect(map['help.toggle']).toEqual([])
    expect(map['tab.next']).toEqual(DEFAULT_KEYMAP['tab.next'])
    expect(matchShortcut(ev('N', { altKey: true, code: 'KeyN' }), map, outside)).toBe('tab.new')
  })
})
