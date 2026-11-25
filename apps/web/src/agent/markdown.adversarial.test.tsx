import { render } from '@solidjs/testing-library'
import * as fc from 'fast-check'
import { createSignal } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { Markdown, splitChunks } from './markdown.tsx'

const SCALE = Math.max(1, Number(process.env.NEXO_TEST_TIMEOUT_SCALE ?? '1') || 1)
const mount = (text: string) => render(() => <Markdown text={text} />).container

/** Nada de lo que produce el Markdown puede ejecutar ni cargar cosas. */
function expectInert(c: HTMLElement) {
  expect(
    c.querySelector(
      'script, iframe, object, embed, img, svg, style, link, meta, form, video, audio, base',
    ),
  ).toBeNull()
  for (const el of c.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      expect(attr.name.startsWith('on')).toBe(false)
      expect(['style', 'srcdoc', 'src', 'srcset', 'formaction', 'xlink:href']).not.toContain(
        attr.name,
      )
    }
  }
  for (const a of c.querySelectorAll('a')) {
    expect(/^(https?:|mailto:)/.test(a.getAttribute('href') ?? '')).toBe(true)
  }
}

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
  '<style>*{display:none}</style>',
  '<div style="position:fixed;inset:0">cubre</div>',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](java\nscript:alert(1))',
  '[x](&#106;avascript:alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x](vbscript:msgbox(1))',
  '[x](//evil.example/a)',
  '[x]( javascript:alert(1))',
  '<javascript:alert(1)>',
  '<https://ok.example/a>',
  '[ref]\n\n[ref]: javascript:alert(1)',
  '![x](javascript:alert(1))',
  '![remota](https://evil.example/pixel.png)',
  '![remota][r]\n\n[r]: https://evil.example/p.gif',
  '<img src="https://evil.example/p.gif">',
  '[![img](https://evil.example/p.png)](https://ok.example)',
  '```html\n<script>alert(1)</script>\n```',
  '`<img src=x onerror=alert(1)>`',
  '| <script>alert(1)</script> |\n|---|\n| <img src=x onerror=1> |',
  '- <script>alert(1)</script>\n- [x](javascript:1)',
  '> <script>alert(1)</script>',
  '# <script>alert(1)</script>',
  '<!-- comentario --><script>alert(1)</script>',
  '<![CDATA[<script>alert(1)</script>]]>',
  '<details open ontoggle=alert(1)><summary>x</summary></details>',
]

describe('Markdown hostil', () => {
  it.each(PAYLOADS)('payload inerte: %j', (payload) => {
    const c = mount(payload)
    expectInert(c)
  })

  it('el HTML crudo se ve como texto literal, no como elementos', () => {
    const c = mount('<script>alert(1)</script>\n\nantes <b>negrita</b> después')
    expect(c.textContent).toContain('<script>alert(1)</script>')
    expect(c.textContent).toContain('<b>')
    expect(c.querySelector('b')).toBeNull()
  })

  it('las imágenes remotas no se cargan: queda su texto alternativo', () => {
    const c = mount('![logo](https://evil.example/p.png)')
    expect(c.querySelector('img')).toBeNull()
    expect(c.querySelector('.md-image')?.textContent).toContain('logo')
    expect(c.innerHTML).not.toContain('evil.example')
  })

  it('un enlace peligroso queda como texto, sin href', () => {
    const c = mount('[haz clic](javascript:alert(1))')
    expect(c.querySelector('a')).toBeNull()
    expect(c.querySelector('.md-link-blocked')?.textContent).toBe('haz clic')
    expect(c.innerHTML).not.toContain('javascript:')
  })

  it('texto del enlace que simula otro destino: el título muestra el real', () => {
    const c = mount('[https://banco.example](https://malo.example/login)')
    const a = c.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://malo.example/login')
    expect(a?.getAttribute('title')).toBe('https://malo.example/login')
  })

  it('50 000 citas anidadas no desbordan la pila', () => {
    const c = mount(`${'> '.repeat(50_000)}fin`)
    expectInert(c)
    expect(c.textContent).toContain('fin')
  })

  it('listas anidadas muy hondas se cortan a una profundidad razonable', () => {
    const text = Array.from({ length: 3000 }, (_, i) => `${'  '.repeat(i)}- n${i}`).join('\n')
    const c = mount(text)
    expectInert(c)
    expect(c.querySelectorAll('ul').length).toBeLessThan(200)
  })

  it('un documento de 120 KB (el tope de un bloque es 128 KiB) se analiza y se pinta a tiempo', {
    timeout: 120_000,
  }, () => {
    const para = 'Texto con **negrita**, `código`, [enlace](https://example.com) y más.\n\n'
    const big = para.repeat(Math.floor(120_000 / para.length))
    const t = performance.now()
    const c = mount(big)
    expect(performance.now() - t).toBeLessThan(40_000 * SCALE)
    expect(c.querySelectorAll('p').length).toBeGreaterThan(1000)
  })

  it('por encima del tope se muestra como texto plano acotado', () => {
    const c = mount('# x\n'.repeat(100_000))
    expect(c.querySelector('.md-heading')).toBeNull()
    expect(c.querySelector('pre.md-plain')).not.toBeNull()
  })

  it.each([
    ['corchetes sin cerrar', '['.repeat(20_000)],
    ['paréntesis sin cerrar', '[a]('.repeat(5_000)],
    ['asteriscos', '*a'.repeat(20_000)],
    ['guiones bajos', '_a'.repeat(20_000)],
    ['acentos graves', '`a'.repeat(20_000)],
    ['menores', '<a'.repeat(20_000)],
    ['tabla enorme', `|${' a |'.repeat(2_000)}\n|${'---|'.repeat(2_000)}\n`],
    ['enlaces de referencia', '[a][b]'.repeat(10_000)],
    ['espacios', `a${' '.repeat(100_000)}b`],
  ])('entrada patológica (%s) no se cuelga', (_name, text) => {
    const t = performance.now()
    const c = mount(text)
    expect(performance.now() - t).toBeLessThan(40_000 * SCALE)
    expectInert(c)
  })

  it('propiedad: con cualquier mezcla de símbolos de Markdown/HTML el resultado es inerte', () => {
    const pieces = fc.constantFrom(
      '<',
      '>',
      '[',
      ']',
      '(',
      ')',
      '!',
      '*',
      '_',
      '`',
      '#',
      '-',
      '|',
      '\n',
      ' ',
      'a',
      'javascript:',
      'data:',
      'http://x.y',
      '&lt;',
      '&#x6a;',
      'onerror=',
      '"',
      "'",
      '\\',
    )
    fc.assert(
      fc.property(
        fc.array(pieces, { maxLength: 80 }).map((p) => p.join('')),
        (text) => {
          expectInert(mount(text))
        },
      ),
      { numRuns: 150 },
    )
  })
})

const LF = String.fromCharCode(10)
const lines = (...l: string[]) => l.join(LF)

describe('Markdown: trozos y reutilización', () => {
  it('los trozos nunca parten un bloque de código con líneas en blanco', () => {
    const text = lines('uno', '', '```js', 'a', '', 'b', '```', '', 'dos', '', '~~~', 'x', '', 'y')
    const chunks = splitChunks(text)
    expect(chunks.map((c) => c.text)).toEqual([
      'uno',
      lines('```js', 'a', '', 'b', '```'),
      'dos',
      lines('~~~', 'x', '', 'y'),
    ])
    expect(chunks.map((c) => c.fenced)).toEqual([false, true, false, true])
  })

  it('un párrafo patológico enorme se muestra como texto sin interpretarse ni colgar', () => {
    const t = performance.now()
    const c = mount(lines('*a'.repeat(30_000), '', 'fin **ok**'))
    expect(performance.now() - t).toBeLessThan(20_000 * SCALE)
    expect(c.querySelector('pre.md-plain')).not.toBeNull()
    expect(c.querySelector('strong')?.textContent).toBe('ok')
  })

  it('un bloque de código largo sí se interpreta aunque supere el tope de trozo', () => {
    const code = lines('```', ...Array.from({ length: 2000 }, () => 'línea de código'), '```')
    const c = mount(lines('p '.repeat(7000), '', code))
    expect(c.querySelector('.md-code pre code')?.textContent?.startsWith('línea de código')).toBe(
      true,
    )
  })

  it('al crecer el texto, los bloques ya terminados conservan su nodo del DOM', () => {
    const [text, setText] = createSignal(lines('# Título', '', 'primero', '', 'segundo'))
    const view = render(() => <Markdown text={text()} />)
    const first = view.container.querySelector('p')
    setText(lines('# Título', '', 'primero', '', 'segundo y más'))
    expect(view.container.querySelector('p')).toBe(first)
    expect(view.container.textContent).toContain('segundo y más')
  })
})
