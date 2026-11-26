import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, Stack, test } from './stack.ts'

/**
 * Visor lateral (F4.2) contra un daemon real: Markdown (con enlaces, imagen local y contenido hostil), imagen,
 * SVG hostil como imagen, PDF dibujado en canvas (también uno con JavaScript) y `nexo open` desde la CLI.
 */

declare global {
  var __pwned: unknown
}

// PNG de 1x1 píxel.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const SVG_HOSTIL =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="globalThis.__pwned=1">' +
  '<script>globalThis.__pwned=1</script><rect width="40" height="40" fill="red"/>' +
  '<foreignObject width="40" height="40"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>'

/** PDF mínimo de una página con un rectángulo negro; con `js` lleva una acción de JavaScript al abrir. */
function minimalPdf(js: boolean): Buffer {
  const content = '0 0 0 rg 20 20 160 120 re f'
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${js ? " /OpenAction << /S /JavaScript /JS (app.alert('pwned')) >>" : ''} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const MARKDOWN = [
  '# Título del visor',
  '',
  'Un [enlace local](guia.md), uno [externo](https://example.com/x) y uno [malo](javascript:globalThis.__pwned=1).',
  '',
  '![logo](img/logo.png)',
  '',
  '![rastreo](https://evil.example/pixel.png)',
  '',
  '<script>globalThis.__pwned=1</script>',
  '<img src=x onerror="globalThis.__pwned=1">',
].join('\n')

async function openInViewer(stack: Stack, path: string): Promise<void> {
  const r = await stack.nexo(['open', path])
  if (r.code !== 0) throw new Error(`nexo open salió ${r.code}: ${r.stderr}`)
}

const viewer = (app: Page) => app.locator('[data-testid="viewer"]:visible')

test.describe('visor lateral', () => {
  let dir: string
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexo-e2e-viewer-'))
    mkdirSync(join(dir, 'img'))
    writeFileSync(join(dir, 'LEEME.md'), MARKDOWN)
    writeFileSync(join(dir, 'guia.md'), '# Guía\n\nSegundo documento.')
    writeFileSync(join(dir, 'img', 'logo.png'), PNG)
    writeFileSync(join(dir, 'hostil.svg'), SVG_HOSTIL)
    writeFileSync(join(dir, 'doc.pdf'), minimalPdf(false))
    writeFileSync(join(dir, 'js.pdf'), minimalPdf(true))
    writeFileSync(join(dir, 'notas.txt'), '<b>texto</b> plano')
  })
  test.afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('Markdown, enlaces, imagen local, SVG hostil y PDF (con y sin JavaScript)', async ({
    app,
  }) => {
    const stack = await Stack.start()
    try {
      const requests: string[] = []
      const dialogs: string[] = []
      app.on('request', (r) => requests.push(r.url()))
      app.on('dialog', (d) => {
        dialogs.push(d.message())
        void d.dismiss()
      })

      await stack.json([
        'new',
        '--cwd',
        dir,
        '--name',
        'visor',
        '--',
        process.execPath,
        '-e',
        'setInterval(()=>{},1000)',
      ])
      await openInViewer(stack, join(dir, 'LEEME.md'))
      await app.goto(stack.url())
      await app.getByRole('tab', { name: 'visor' }).click()

      // Markdown: título, imagen local como blob, nada remoto, nada activo.
      const md = viewer(app).locator('.viewer-markdown')
      await expect(md.locator('h3')).toHaveText('Título del visor')
      const logo = md.locator('img.md-img')
      await expect(logo).toHaveAttribute('src', /^blob:/)
      await expect
        .poll(() => logo.evaluate((i: HTMLImageElement) => i.naturalWidth))
        .toBeGreaterThan(0)
      await expect(md.locator('img')).toHaveCount(1)
      await expect(md.locator('script, iframe')).toHaveCount(0)
      await expect(md.locator('a[href^="javascript"]')).toHaveCount(0)
      await expect(md.locator('a[href^="https"]')).toHaveAttribute('rel', /noopener/)
      expect(await app.evaluate(() => globalThis.__pwned)).toBeUndefined()

      // El enlace local abre el otro archivo en el mismo visor.
      await md.getByRole('button', { name: 'enlace local' }).click()
      await expect(viewer(app).locator('.viewer-markdown h3')).toHaveText('Guía')

      // SVG hostil: solo una imagen, sin ejecutar nada.
      await openInViewer(stack, join(dir, 'hostil.svg'))
      const svg = viewer(app).locator('[data-testid="viewer-image"]')
      await expect(svg).toHaveAttribute('src', /^blob:/)
      await expect
        .poll(() => svg.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth))
        .toBeGreaterThan(0)
      await expect(viewer(app).locator('svg, script, foreignObject')).toHaveCount(0)
      expect(await app.evaluate(() => globalThis.__pwned)).toBeUndefined()

      // Texto plano.
      await openInViewer(stack, join(dir, 'notas.txt'))
      await expect(viewer(app).locator('[data-testid="viewer-text"]')).toHaveText(
        '<b>texto</b> plano',
      )

      // PDF: se dibuja en canvas (hay píxeles negros) y el de JavaScript no abre diálogos.
      for (const name of ['doc.pdf', 'js.pdf']) {
        await openInViewer(stack, join(dir, name))
        const canvas = viewer(app).locator('canvas[data-rendered="true"]')
        await expect(canvas).toHaveCount(1)
        const dark = await canvas.evaluate((c: HTMLCanvasElement) => {
          const ctx = c.getContext('2d')
          const data = ctx?.getImageData(0, 0, c.width, c.height).data
          if (data === undefined) return 0
          let n = 0
          for (let i = 0; i < data.length; i += 4) if ((data[i] as number) < 40) n++
          return n
        })
        expect(dark).toBeGreaterThan(100)
      }
      expect(dialogs).toEqual([])
      expect(await app.evaluate(() => globalThis.__pwned)).toBeUndefined()

      // Nada salió a la red: ni la imagen remota ni nada fuera del origen de la web y el daemon.
      expect(requests.filter((u) => u.includes('evil.example'))).toEqual([])
    } finally {
      await stack.dispose()
    }
  })

  test('un archivo fuera de las carpetas de los espacios no se abre', async () => {
    const stack = await Stack.start()
    try {
      await stack.json([
        'new',
        '--cwd',
        dir,
        '--name',
        'visor',
        '--',
        process.execPath,
        '-e',
        'setInterval(()=>{},1000)',
      ])
      const outside = mkdtempSync(join(tmpdir(), 'nexo-e2e-fuera-'))
      try {
        writeFileSync(join(outside, 'secreto.md'), '# secreto')
        const r = await stack.nexo(['open', join(outside, 'secreto.md')])
        expect(r.code).not.toBe(0)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    } finally {
      await stack.dispose()
    }
  })
})
