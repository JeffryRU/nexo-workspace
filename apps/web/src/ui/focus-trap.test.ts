import { describe, expect, it } from 'vitest'
import { focusableIn, trapTab } from './focus-trap.ts'

function setup(html: string): HTMLElement {
  document.body.innerHTML = `<div id="root" tabindex="-1">${html}</div>`
  return document.getElementById('root') as HTMLElement
}
const key = (shiftKey = false, name = 'Tab') => {
  let prevented = false
  return {
    event: {
      key: name,
      shiftKey,
      preventDefault: () => {
        prevented = true
      },
    },
    prevented: () => prevented,
  }
}
const three = '<button id="a">a</button><button id="b">b</button><button id="c">c</button>'

describe('focus-trap', () => {
  it('lista solo lo enfocable: sin deshabilitados, ocultos ni tabindex -1', () => {
    const root = setup(
      '<button id="a">a</button><button disabled>b</button><button hidden>c</button><span tabindex="-1">d</span><input id="e"><div hidden><button>f</button></div>',
    )
    expect(focusableIn(root).map((e) => e.id)).toEqual(['a', 'e'])
  })

  it('Tab en el último vuelve al primero y Mayús+Tab en el primero va al último', () => {
    const root = setup(three)
    const [a, , c] = Array.from(root.querySelectorAll('button'))
    c?.focus()
    const forward = key()
    expect(trapTab(root, forward.event)).toBe(true)
    expect(forward.prevented()).toBe(true)
    expect(document.activeElement).toBe(a)
    expect(trapTab(root, key(true).event)).toBe(true)
    expect(document.activeElement).toBe(c)
  })

  it('en medio no interviene (el navegador mueve el foco)', () => {
    const root = setup(three)
    root.querySelector<HTMLElement>('#b')?.focus()
    const k = key()
    expect(trapTab(root, k.event)).toBe(false)
    expect(k.prevented()).toBe(false)
  })

  it('si el foco se salió del contenedor lo recupera', () => {
    const root = setup('<button id="a">a</button>')
    document.body.insertAdjacentHTML('beforeend', '<button id="out">fuera</button>')
    document.getElementById('out')?.focus()
    expect(trapTab(root, key().event)).toBe(true)
    expect(document.activeElement?.id).toBe('a')
  })

  it('sin nada enfocable deja el foco en el contenedor', () => {
    const root = setup('<p>solo texto</p>')
    const k = key()
    expect(trapTab(root, k.event)).toBe(true)
    expect(k.prevented()).toBe(true)
    expect(document.activeElement).toBe(root)
  })

  it('ignora otras teclas', () => {
    const root = setup('<button>a</button>')
    expect(trapTab(root, key(false, 'Enter').event)).toBe(false)
  })

  it('con miles de elementos sigue siendo correcto', () => {
    const root = setup(
      Array.from({ length: 2000 }, (_, i) => `<button id="b${i}">x</button>`).join(''),
    )
    document.getElementById('b1999')?.focus()
    expect(trapTab(root, key().event)).toBe(true)
    expect(document.activeElement?.id).toBe('b0')
  })
})
