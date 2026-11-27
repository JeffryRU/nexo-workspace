/**
 * PDF local (F4.2) con pdf.js. El módulo y su worker se cargan solo al abrir un PDF (`import()` dinámico: no pesan
 * en el arranque) y salen del propio paquete, empaquetados por Vite y servidos por el mismo origen: nada de CDN.
 * Aquí se cierra lo que pdf.js admite de más: sin XFA (pdf.js 6 ya no evalúa código de las funciones del PDF), sin WebAssembly (que
 * pediría `wasm-unsafe-eval`), sin tipografías por `FontFace` (los glifos se dibujan como trazos) y con un tope de
 * píxeles por imagen. Tampoco se monta capa de anotaciones ni de texto ni el gestor de scripts: un PDF con
 * JavaScript, enlaces o formularios se ve como una imagen y nada de eso se ejecuta.
 */

export type PdfViewport = { width: number; height: number }

export type PdfPage = {
  getViewport(o: { scale: number }): PdfViewport
  render(o: {
    canvasContext: CanvasRenderingContext2D
    viewport: PdfViewport
    transform?: number[]
  }): {
    promise: Promise<void>
    cancel(): void
  }
  cleanup?(): void
}

export type PdfDocument = {
  numPages: number
  getPage(n: number): Promise<PdfPage>
  destroy(): Promise<void>
}

export type PdfLoader = (bytes: Uint8Array) => Promise<PdfDocument>

/** Píxeles de imagen incrustada que se decodifican como máximo (evita bombas de descompresión). */
export const PDF_MAX_IMAGE_PIXELS = 16 * 1024 * 1024

export const loadPdfDocument: PdfLoader = async (bytes) => {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  // `data` se copia: pdf.js transfiere el búfer al worker y lo dejaría vacío.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    enableXfa: false,
    useWasm: false,
    disableFontFace: true,
    maxImageSize: PDF_MAX_IMAGE_PIXELS,
    verbosity: 0,
  })
  return (await task.promise) as unknown as PdfDocument
}
