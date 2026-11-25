import { render } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { codeLanguage, Markdown, parseMarkdown } from './markdown.tsx'

const html = (text: string) => render(() => <Markdown text={text} />).container

describe('Markdown', () => {
  it('párrafos, énfasis, código en línea y saltos', () => {
    const c = html('Hola **fuerte** y *suave* con `código` y ~~tachado~~.\n\nOtro párrafo')
    expect(c.querySelectorAll('p')).toHaveLength(2)
    expect(c.querySelector('strong')?.textContent).toBe('fuerte')
    expect(c.querySelector('em')?.textContent).toBe('suave')
    expect(c.querySelector('del')?.textContent).toBe('tachado')
    expect(c.querySelector('code.md-inline-code')?.textContent).toBe('código')
  })

  it('títulos bajan de nivel dentro del panel', () => {
    const c = html('# Uno\n## Dos\n###### Seis')
    expect([...c.querySelectorAll('.md-heading')].map((h) => h.tagName)).toEqual(['H3', 'H4', 'H6'])
  })

  it('listas ordenadas, con inicio, anidadas y de tareas', () => {
    const c = html('3. tres\n4. cuatro\n\n- a\n  - anidado\n- [x] hecho\n- [ ] falta')
    expect(c.querySelector('ol')?.getAttribute('start')).toBe('3')
    expect(c.querySelectorAll('ul ul li')).toHaveLength(1)
    const boxes = [...c.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes.map((b) => b.checked)).toEqual([true, false])
    expect(boxes.every((b) => b.disabled)).toBe(true)
  })

  it('bloque de código con lenguaje saneado, sin interpretar su contenido', () => {
    const c = html('```ts\nconst a = <b>x</b> && 1\n```')
    expect(c.querySelector('.md-code-lang')?.textContent).toBe('ts')
    expect(c.querySelector('pre code')?.textContent).toBe('const a = <b>x</b> && 1')
    expect(c.querySelector('pre b')).toBeNull()
    expect(codeLanguage('js title="x"')).toBe('js')
    expect(codeLanguage('<script>')).toBeUndefined()
    expect(codeLanguage(undefined)).toBeUndefined()
  })

  it('tablas con alineación por clase (nunca por estilo en línea)', () => {
    const c = html('| a | b |\n|:-:|--:|\n| 1 | 2 |')
    expect(c.querySelectorAll('th')).toHaveLength(2)
    expect(c.querySelector('th')?.className).toBe('md-align-center')
    expect(c.querySelectorAll('td')[1]?.className).toBe('md-align-right')
    expect(c.querySelector('[style]')).toBeNull()
  })

  it('citas y reglas horizontales', () => {
    const c = html('> cita\n\n---\n\ntexto')
    expect(c.querySelector('blockquote')?.textContent).toContain('cita')
    expect(c.querySelector('hr')).not.toBeNull()
  })

  it('enlaces http(s) abren aparte con rel seguro', () => {
    const a = html('[sitio](https://example.com/x)').querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com/x')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(a?.getAttribute('title')).toBe('https://example.com/x')
  })

  it('un autoenlace GFM también pasa por el filtro', () => {
    const c = html('mira https://example.com/a?b=1&c=2 ya')
    expect(c.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a?b=1&c=2')
  })

  it('parseMarkdown informa del fallo en vez de lanzar', () => {
    expect(parseMarkdown('ok').failed).toBe(false)
    expect(parseMarkdown('x'.repeat(300_000)).failed).toBe(true)
  })

  it('texto vacío no pinta nada', () => {
    expect(html('').querySelector('p')).toBeNull()
  })
})
