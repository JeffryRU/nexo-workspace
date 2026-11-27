import { fireEvent } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountApp } from '../test-app.tsx'
import { FakeClient, mkPane, mkTab, mkWorkspace, snapshotOf } from '../test-helpers.ts'
import { enc, type FakeFile, installFs, stubBlobUrls, tick, until } from '../viewer/test-helpers.ts'

vi.mock('../viewer/pdf.ts', () => ({
  loadPdfDocument: vi.fn(async () => ({
    numPages: 2,
    getPage: async () => ({
      getViewport: () => ({ width: 200, height: 300 }),
      render: () => ({ promise: Promise.resolve(), cancel() {} }),
    }),
    destroy: async () => {},
  })),
}))

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

let blobs: ReturnType<typeof stubBlobUrls>
beforeEach(() => {
  blobs = stubBlobUrls()
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never
})
afterEach(() => blobs.restore())

async function mountViewer(
  files: Record<string, FakeFile>,
  path: string | null = '/work/docs/LEEME.md',
) {
  const client = new FakeClient()
  installFs(client, new Map(Object.entries(files)))
  const tab = mkTab('t1', ['p1'])
  tab.panes = [
    mkPane('p1', {
      kind: 'viewer',
      title: 'visor',
      ...(path === null ? {} : { viewerPath: path }),
    }),
  ]
  const ws = mkWorkspace('w1', [tab], { cwd: '/work' })
  const app = await mountApp(snapshotOf([ws]), client)
  return { app, client }
}

const md = (text: string, extra: Partial<FakeFile> = {}): FakeFile => ({
  type: 'markdown',
  bytes: enc(text),
  ...extra,
})

describe('panel viewer en la web', () => {
  it('muestra el Markdown renderizado y no abre una terminal', async () => {
    const { app } = await mountViewer({
      '/work/docs/LEEME.md': md('# Hola\n\nTexto **fuerte** y `código`.'),
    })
    const root = await until(() => app.container.querySelector('.viewer-markdown'))
    expect(root.querySelector('h3')?.textContent).toBe('Hola')
    expect(root.querySelector('strong')?.textContent).toBe('fuerte')
    expect(app.container.querySelector('.terminal-host, .xterm')).toBeNull()
    expect(app.xterms.size).toBe(0)
  })

  it('un visor sin archivo lo dice', async () => {
    const { app } = await mountViewer({}, null)
    await tick()
    expect(app.container.querySelector('[data-testid="viewer"]')?.textContent).toContain(
      'Sin archivo',
    )
  })

  it('texto plano en un pre, sin interpretar nada', async () => {
    const { app } = await mountViewer(
      { '/work/a.txt': { type: 'text', bytes: enc('<b>no</b> # no') } },
      '/work/a.txt',
    )
    const pre = await until(() => app.container.querySelector('[data-testid="viewer-text"]'))
    expect(pre.textContent).toBe('<b>no</b> # no')
    expect(pre.querySelector('b')).toBeNull()
  })

  it('una imagen sale como img con una URL blob y se libera al cambiar', async () => {
    const { app } = await mountViewer({ '/work/a.png': { type: 'png', bytes: PNG } }, '/work/a.png')
    const img = await until(() =>
      app.container.querySelector<HTMLImageElement>('[data-testid="viewer-image"]'),
    )
    expect(img.getAttribute('src')).toMatch(/^blob:fake-/)
    const blob = blobs.blobs.get(img.getAttribute('src') as string) as Blob
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(PNG.length)
  })

  it('un SVG se muestra solo como img: nunca entra al DOM', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject/></svg>'
    const { app } = await mountViewer(
      { '/work/a.svg': { type: 'svg', bytes: enc(svg) } },
      '/work/a.svg',
    )
    const img = await until(() =>
      app.container.querySelector<HTMLImageElement>('[data-testid="viewer-image"]'),
    )
    expect(img.tagName).toBe('IMG')
    expect(app.container.querySelector('svg:not([data-icon]), script, foreignObject')).toBeNull()
    expect(blobs.blobs.get(img.getAttribute('src') as string)?.type).toBe('image/svg+xml')
  })

  it('un PDF se dibuja en canvas por página', async () => {
    const { app } = await mountViewer(
      { '/work/a.pdf': { type: 'pdf', bytes: enc('%PDF-1.4 x') } },
      '/work/a.pdf',
    )
    await until(() => app.container.querySelectorAll('canvas[data-rendered="true"]').length === 2)
    expect(app.container.querySelectorAll('canvas.viewer-pdf-page')).toHaveLength(2)
  })

  it('un binario, una carpeta y un archivo demasiado grande dan un mensaje claro y no se leen', async () => {
    const { app, client } = await mountViewer(
      {
        '/work/b.bin': { type: 'binary', bytes: new Uint8Array(10) },
        '/work/big.md': md('x', { size: 99 * 1024 * 1024, maxBytes: 8 * 1024 * 1024 }),
      },
      '/work/b.bin',
    )
    await until(() => app.container.textContent?.includes('Archivo binario'))
    expect(client.callsOf('fs.read')).toHaveLength(0)

    const second = await mountViewer(
      {
        '/work/big.md': md('x', { size: 99 * 1024 * 1024, maxBytes: 8 * 1024 * 1024 }),
      },
      '/work/big.md',
    )
    await until(() => second.app.container.textContent?.includes('El archivo pesa'))
    expect(second.client.callsOf('fs.read')).toHaveLength(0)
  })

  it('un error del daemon (fuera de la carpeta, no existe) se muestra como alerta', async () => {
    const { app } = await mountViewer({}, '/work/no-existe.md')
    const alert = await until(() => app.container.querySelector('.viewer-notice[role="alert"]'))
    expect(alert.textContent).toContain('No se pudo abrir el archivo')
  })

  it('una ruta hostil se pinta como texto, no como HTML', async () => {
    const evil = '/work/<img src=x onerror=alert(1)>.md'
    const { app } = await mountViewer({ [evil]: md('hola') }, evil)
    await until(() => app.container.querySelector('.viewer-markdown'))
    expect(app.container.querySelector('.viewer-bar img')).toBeNull()
    expect(app.container.querySelector('.viewer-path')?.textContent).toBe(evil)
  })

  it('«Recargar» vuelve a leer el archivo', async () => {
    const files = { '/work/docs/LEEME.md': md('# Uno') }
    const { app, client } = await mountViewer(files)
    await until(() => app.container.querySelector('.viewer-markdown h3'))
    files['/work/docs/LEEME.md'] = md('# Dos', { mtimeMs: 2000 })
    installFs(client, new Map(Object.entries(files)))
    fireEvent.click(app.getByText('Recargar'))
    await until(() => app.container.querySelector('.viewer-markdown h3')?.textContent === 'Dos')
  })

  it('al volver a la ventana solo se relee si el archivo cambió', async () => {
    const files = { '/work/docs/LEEME.md': md('# Uno') }
    const { app, client } = await mountViewer(files)
    await until(() => app.container.querySelector('.viewer-markdown h3'))
    const reads = client.callsOf('fs.read').length
    globalThis.dispatchEvent(new Event('focus'))
    await tick(20)
    expect(client.callsOf('fs.read')).toHaveLength(reads)
    files['/work/docs/LEEME.md'] = md('# Tres', { mtimeMs: 3000 })
    installFs(client, new Map(Object.entries(files)))
    globalThis.dispatchEvent(new Event('focus'))
    await until(() => app.container.querySelector('.viewer-markdown h3')?.textContent === 'Tres')
  })
})

describe('Markdown del visor: enlaces e imágenes', () => {
  it('un enlace a otro archivo abre en el visor (viewer.open con la ruta absoluta)', async () => {
    const { app, client } = await mountViewer({
      '/work/docs/LEEME.md': md('[guía](guia.md) y [arriba](../LEEME.md#x)'),
    })
    const link = await until(() => app.container.querySelector<HTMLElement>('.md-file-link'))
    fireEvent.click(link)
    await until(() => client.callsOf('viewer.open').length > 0)
    expect(client.callsOf('viewer.open')[0]?.params).toMatchObject({ path: '/work/docs/guia.md' })
    expect(app.container.querySelectorAll('.md-file-link')[1]?.getAttribute('title')).toBe(
      '/work/LEEME.md',
    )
  })

  it('un enlace externo se abre solo al pulsarlo, con noopener y en otra pestaña', async () => {
    const { app } = await mountViewer({
      '/work/docs/LEEME.md': md('[web](https://example.com/x)'),
    })
    const a = await until(() => app.container.querySelector<HTMLAnchorElement>('a[href^="https"]'))
    expect(a.target).toBe('_blank')
    expect(a.rel).toContain('noopener')
    expect(a.rel).toContain('noreferrer')
  })

  it('la imagen relativa se lee por fs.read y se muestra como blob; la remota no se carga', async () => {
    const { app, client } = await mountViewer({
      '/work/docs/LEEME.md': md('![logo](img/logo.png)\n\n![remota](https://evil.example/p.png)'),
      '/work/docs/img/logo.png': { type: 'png', bytes: PNG },
    })
    const img = await until(() => app.container.querySelector<HTMLImageElement>('img.md-img'))
    expect(img.src).toMatch(/^blob:fake-/)
    expect(
      client
        .callsOf('fs.read')
        .some((c) => (c.params as { path: string }).path === '/work/docs/img/logo.png'),
    ).toBe(true)
    expect(app.container.querySelectorAll('img')).toHaveLength(1)
    expect(app.container.querySelector('.md-image')?.textContent).toContain('remota')
  })

  it('una imagen que no existe o no es imagen queda como marcador', async () => {
    const { app } = await mountViewer({
      '/work/docs/LEEME.md': md('![falta](nada.png) ![texto](t.txt)'),
      '/work/docs/t.txt': { type: 'text', bytes: enc('x') },
    })
    await until(() => app.container.querySelectorAll('.md-image').length === 2)
    await tick(30)
    expect(app.container.querySelector('img')).toBeNull()
  })
})
