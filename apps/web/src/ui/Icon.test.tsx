import { render } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { ICON_NAMES, Icon, type IconName } from './Icon.tsx'

const svgOf = (el: () => ReturnType<typeof Icon>) => render(el).container.querySelector('svg')

describe('Icon', () => {
  it('pinta un SVG decorativo con trazo uniforme y currentColor', () => {
    const svg = svgOf(() => <Icon name="plus" />)
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
    expect(svg?.getAttribute('stroke-width')).toBe('1.75')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.querySelectorAll('path').length).toBe(2)
  })

  it('el tamaño sale de una clase (variables de diseño), no de números sueltos', () => {
    const classes = (['sm', 'md', 'lg'] as const).map(
      (size) => svgOf(() => <Icon name="x" size={size} />)?.getAttribute('class') ?? '',
    )
    expect(classes).toEqual(['icon icon-sm', 'icon icon-md', 'icon icon-lg'])
    expect(svgOf(() => <Icon name="x" class="fold-chevron" />)?.getAttribute('class')).toBe(
      'icon icon-md fold-chevron',
    )
  })

  it('todos los iconos tienen trazos válidos, sin texto ni ancho fijo', () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(20)
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(() => <Icon name={name} />)
      const svg = container.querySelector('svg')
      const paths = svg?.querySelectorAll('path') ?? []
      expect(paths.length, name).toBeGreaterThan(0)
      for (const p of paths) {
        const d = p.getAttribute('d') ?? ''
        expect(d, name).toMatch(/^[Mm]/)
        expect(d, name).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9\s.,-]+$/)
      }
      expect(svg?.textContent, name).toBe('')
      expect(svg?.hasAttribute('width'), name).toBe(false)
      unmount()
    }
  })

  it('los iconos rellenos (stop, circle-half) usan currentColor y los demás no rellenan', () => {
    const fills = (name: IconName) =>
      Array.from(render(() => <Icon name={name} />).container.querySelectorAll('path')).map((p) =>
        p.getAttribute('fill'),
      )
    expect(fills('stop')).toEqual(['currentColor'])
    expect(fills('circle-half')).toEqual([null, 'currentColor'])
    expect(fills('check')).toEqual([null])
  })
})
