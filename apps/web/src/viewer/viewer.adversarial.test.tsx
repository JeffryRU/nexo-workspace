import { render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown, type MarkdownEnv } from '../agent/markdown.tsx'
import { loadViewerFile } from './load.ts'
import { MAX_PDF_PAGES, PdfView } from './PdfView.tsx'
import type { PdfDocument } from './pdf.ts'
import { enc, stubBlobUrls, tick, until } from './test-helpers.ts'

function mountMd(text: string, over: Partial<MarkdownEnv> = {}) {
  const opened: string[] = []
  const loaded: string[] = []
  const env: MarkdownEnv = {
    baseDir: '/work/docs',
    openFile: (p) => void opened.push(p),
    loadImage: async (p) => {
      loaded.push(p)
      return undefined
    },
    ...over,
  }
  const view = render(() => <Markdown text={text} env={env} />)
  return { ...view, opened, loaded }
}

/** Nada del Markdown hostil crea elementos activos ni atributos de eventos. */
function expectInert(c: HTMLElement) {
  expect(
    c.querySelector('script, iframe, object, embed, svg, style, link, meta, form, base, video'),
  ).toBeNull()
  for (const el of c.querySelectorAll('*')) {
    for (const attr of el.attributes) expect(attr.name.startsWith('on')).toBe(false)
  }
  for (const a of c.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? ''
    expect(href === '#' || /^(https?:|mailto:)/.test(href)).toBe(true)
  }
}

describe('Markdown del visor con contenido hostil', () => {
  it('HTML crudo, script y onerror se ven como texto', () => {
    const { container } = mountMd(
      '<script>globalThis.__x=1</script>\n\n<img src=x onerror="globalThis.__x=1">\n\n<iframe src="javascript:1"></iframe>',
    )
    expectInert(container)
    expect(container.querySelector('img')).toBeNull()
    expect((globalThis as { __x?: number }).__x).toBeUndefined()
    expect(container.textContent).toContain('<script>')
  })

  it('enlaces javascript:, data:, file: y UNC quedan sin href', () => {
    const { container, opened } = mountMd(
      [
        '[a](javascript:alert(1))',
        '[b](JaVaScRiPt:alert(1))',
        '[c](java%0ascript:alert(1))',
        '[d](data:text/html,<script>1</script>)',
        '[e](file:///etc/passwd)',
        '[f](//evil.example/x)',
        '[g](\\\\srv\\share\\x)',
      ].join('\n\n'),
    )
    expectInert(container)
    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(opened).toEqual([])
  })

  it('una ruta con ../ que sale de la raíz no es un enlace; una que no sale, sí', () => {
    const { container, opened } = mountMd('[x](../../../../etc/passwd) [y](../ok.md)')
    const links = container.querySelectorAll<HTMLElement>('.md-file-link')
    expect(links).toHaveLength(1)
    links[0]?.click()
    expect(opened).toEqual(['/work/ok.md'])
  })

  it('las rutas codificadas (%2e%2e, %00) no se saltan la comprobación', () => {
    const { container } = mountMd('[a](%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd) [b](x%00.md)')
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('las imágenes remotas y con esquemas raros nunca se piden', () => {
    const { container, loaded } = mountMd(
      [
        '![a](https://evil.example/p.png)',
        '![b](//evil.example/p.png)',
        '![c](data:image/svg+xml,<svg onload=alert(1)>)',
        '![d](javascript:alert(1))',
        '![e](file:///etc/passwd)',
        '![f](http://127.0.0.1:1/x)',
      ].join('\n\n'),
    )
    expect(container.querySelector('img')).toBeNull()
    expect(loaded).toEqual([])
    expect(container.querySelectorAll('.md-image').length).toBeGreaterThanOrEqual(5)
  })

  it('una imagen local que escapa con ../ no se pide', () => {
    const { loaded } = mountMd('![x](../../../../../etc/shadow)')
    expect(loaded).toEqual([])
  })

  it('un nombre de imagen con HTML se pinta como texto', () => {
    const { container } = mountMd('![<img src=x onerror=alert(1)>](nada.png)')
    expect(container.querySelector('img')).toBeNull()
  })

  it('un documento enorme (1 MiB) no cuelga y cae a texto plano', () => {
    const t0 = Date.now()
    const { container } = mountMd('*a*a'.repeat(300_000))
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(container.querySelector('.md-plain')).not.toBeNull()
  })
})

describe('loadViewerFile con archivos y daemons hostiles', () => {
  const stat = (over: Record<string, unknown> = {}) => ({
    path: '/w/a.md',
    kind: 'file' as const,
    size: 10,
    mtimeMs: 1,
    type: 'markdown' as const,
    mime: 'text/markdown',
    maxBytes: 100,
    tooLarge: false,
    ...over,
  })
  const file = (over: Record<string, unknown> = {}) => ({
    path: '/w/a.md',
    type: 'markdown' as const,
    mime: 'text/markdown',
    size: 3,
    mtimeMs: 1,
    bytes: enc('abc'),
    truncated: false,
    ...over,
  })

  it('un archivo gigante no se lee: solo se hace fs.stat', async () => {
    const readAll = vi.fn()
    const r = await loadViewerFile(
      { stat: async () => stat({ size: 5e9, tooLarge: true }), readAll },
      '/w/a.md',
    )
    expect(r.status).toBe('too-large')
    expect(readAll).not.toHaveBeenCalled()
  })

  it('un binario y una carpeta tampoco se leen', async () => {
    const readAll = vi.fn()
    expect(
      (await loadViewerFile({ stat: async () => stat({ type: 'binary' }), readAll }, '/w/x'))
        .status,
    ).toBe('binary')
    expect(
      (await loadViewerFile({ stat: async () => stat({ kind: 'directory' }), readAll }, '/w'))
        .status,
    ).toBe('directory')
    expect(readAll).not.toHaveBeenCalled()
  })

  it('un archivo que cambia mientras se lee (CONFLICT) se reintenta y termina fallando si no para', async () => {
    let calls = 0
    const conflict = Object.assign(new Error('cambió'), { code: 'CONFLICT' })
    const ok = await loadViewerFile(
      {
        stat: async () => stat(),
        readAll: async () => {
          if (++calls < 3) throw conflict
          return file()
        },
      },
      '/w/a.md',
    )
    expect(ok.status).toBe('ok')
    expect(calls).toBe(3)

    let always = 0
    await expect(
      loadViewerFile(
        {
          stat: async () => stat(),
          readAll: async () => {
            always++
            throw conflict
          },
        },
        '/w/a.md',
      ),
    ).rejects.toBe(conflict)
    expect(always).toBe(3)
  })

  it('otros errores (FORBIDDEN) no se reintentan', async () => {
    let calls = 0
    const forbidden = Object.assign(new Error('no'), { code: 'FORBIDDEN' })
    await expect(
      loadViewerFile(
        {
          stat: async () => stat(),
          readAll: async () => {
            calls++
            throw forbidden
          },
        },
        '/w/a.md',
      ),
    ).rejects.toBe(forbidden)
    expect(calls).toBe(1)
  })

  it('si al leer resulta ser binario, se informa sin mostrar nada', async () => {
    const r = await loadViewerFile(
      { stat: async () => stat(), readAll: async () => file({ type: 'binary' }) },
      '/w/a.md',
    )
    expect(r.status).toBe('binary')
  })
})

describe('PdfView con PDF hostiles', () => {
  let blobs: ReturnType<typeof stubBlobUrls>
  beforeEach(() => {
    blobs = stubBlobUrls()
    HTMLCanvasElement.prototype.getContext = (() => ({})) as never
  })
  afterEach(() => blobs.restore())

  const doc = (pages: number, over: Partial<PdfDocument> = {}): PdfDocument => ({
    numPages: pages,
    getPage: async () => ({
      getViewport: () => ({ width: 100, height: 100 }),
      render: () => ({ promise: Promise.resolve(), cancel() {} }),
    }),
    destroy: async () => {},
    ...over,
  })

  it('un PDF de 100 000 páginas se acota y avisa', async () => {
    const view = render(() => <PdfView bytes={enc('%PDF')} loader={async () => doc(100_000)} />)
    await until(
      () =>
        view.container.querySelectorAll('canvas[data-rendered="true"]').length === MAX_PDF_PAGES,
    )
    expect(view.container.querySelectorAll('canvas')).toHaveLength(MAX_PDF_PAGES)
    expect(view.container.textContent).toContain('primeras 100 páginas')
  })

  it('un PDF corrupto (el cargador falla) muestra el error como texto', async () => {
    const view = render(() => (
      <PdfView
        bytes={enc('basura')}
        loader={async () => {
          throw new Error('<img src=x onerror=alert(1)> Invalid PDF')
        }}
      />
    ))
    const alert = await until(() => view.container.querySelector('[role="alert"]'))
    expect(alert.textContent).toContain('Invalid PDF')
    expect(alert.querySelector('img')).toBeNull()
  })

  it('al desmontar durante la carga se destruye el documento y no se pinta nada más', async () => {
    const destroy = vi.fn(async () => {})
    let release: (d: PdfDocument) => void = () => {}
    const pending = new Promise<PdfDocument>((r) => {
      release = r
    })
    const view = render(() => <PdfView bytes={enc('%PDF')} loader={() => pending} />)
    view.unmount()
    release(doc(3, { destroy }))
    await tick(20)
    expect(destroy).toHaveBeenCalled()
  })

  it('una página que no se deja dibujar da un error, no un cuelgue', async () => {
    const view = render(() => (
      <PdfView
        bytes={enc('%PDF')}
        loader={async () =>
          doc(2, {
            getPage: async () => {
              throw new Error('página rota')
            },
          })
        }
      />
    ))
    const alert = await until(() => view.container.querySelector('[role="alert"]'))
    expect(alert.textContent).toContain('página rota')
  })
})
