import { describe, expect, it, vi } from 'vitest'

const { getDocument, GlobalWorkerOptions } = vi.hoisted(() => ({
  getDocument: vi.fn((_options: Record<string, unknown>) => ({
    promise: Promise.resolve({ numPages: 1 }),
  })),
  GlobalWorkerOptions: {} as { workerSrc?: string },
}))

vi.mock('pdfjs-dist', () => ({ getDocument, GlobalWorkerOptions }))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/assets/pdf.worker.min-abc.mjs',
}))

describe('loadPdfDocument', () => {
  it('usa el worker empaquetado (mismo origen) y opciones cerradas', async () => {
    const { loadPdfDocument, PDF_MAX_IMAGE_PIXELS } = await import('./pdf.ts')
    const bytes = Uint8Array.from([1, 2, 3])
    await loadPdfDocument(bytes)
    expect(GlobalWorkerOptions.workerSrc).toBe('/assets/pdf.worker.min-abc.mjs')
    expect(GlobalWorkerOptions.workerSrc).not.toMatch(/^https?:/)
    const options = getDocument.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options).toMatchObject({
      useWasm: false,
      enableXfa: false,
      disableFontFace: true,
      maxImageSize: PDF_MAX_IMAGE_PIXELS,
    })
    // Sin URL (nada de red) y sin scripting; los datos son una copia (el original no se transfiere).
    expect(options).not.toHaveProperty('url')
    expect(options).not.toHaveProperty('enableScripting')
    expect(options.data).not.toBe(bytes)
    expect(Array.from(options.data as Uint8Array)).toEqual([1, 2, 3])
  })
})
