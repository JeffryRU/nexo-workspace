import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import { es, format } from '../i18n/es.ts'
import { loadPdfDocument, type PdfDocument, type PdfLoader } from './pdf.ts'

/** Páginas que se dibujan como máximo (un PDF de miles de páginas no debe agotar la memoria). */
export const MAX_PDF_PAGES = 100
/** Lado máximo (píxeles) del canvas de una página; más grande se reduce. */
const MAX_CANVAS_SIDE = 8192
const MAX_SCALE = 2

type PageState = { n: number; canvas: HTMLCanvasElement | undefined }

/** Dibuja un PDF en canvas, página a página. No hay texto seleccionable, enlaces ni scripts a propósito. */
export function PdfView(props: { bytes: Uint8Array; loader?: PdfLoader }) {
  const [pages, setPages] = createSignal<PageState[]>([])
  const [total, setTotal] = createSignal(0)
  const [error, setError] = createSignal<string | undefined>()
  const [loading, setLoading] = createSignal(true)
  let host: HTMLDivElement | undefined

  createEffect(
    on(
      () => props.bytes,
      (bytes) => {
        let cancelled = false
        let doc: PdfDocument | undefined
        const running: { cancel(): void }[] = []
        setPages([])
        setError(undefined)
        setLoading(true)
        const load = props.loader ?? loadPdfDocument
        void (async () => {
          try {
            doc = await load(bytes)
            if (cancelled) return void doc.destroy()
            const count = Math.min(doc.numPages, MAX_PDF_PAGES)
            setTotal(doc.numPages)
            setPages(Array.from({ length: count }, (_, i) => ({ n: i + 1, canvas: undefined })))
            const width = Math.max(host?.clientWidth ?? 0, 320) - 24
            for (let n = 1; n <= count && !cancelled; n++) {
              const page = await doc.getPage(n)
              if (cancelled) return
              const base = page.getViewport({ scale: 1 })
              const fit = Math.min(MAX_SCALE, width / Math.max(base.width, 1))
              const dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
              const limit = MAX_CANVAS_SIDE / Math.max(base.width, base.height, 1)
              const scale = Math.max(0.1, Math.min(fit * dpr, limit))
              const viewport = page.getViewport({ scale })
              const canvas = host?.querySelector<HTMLCanvasElement>(`canvas[data-page="${n}"]`)
              const ctx = canvas?.getContext('2d')
              if (canvas == null || ctx == null) throw new Error(es.viewer.pdfNoCanvas)
              canvas.width = Math.max(1, Math.floor(viewport.width))
              canvas.height = Math.max(1, Math.floor(viewport.height))
              canvas.style.width = `${Math.floor(viewport.width / dpr)}px`
              canvas.style.height = `${Math.floor(viewport.height / dpr)}px`
              const task = page.render({ canvasContext: ctx, viewport })
              running.push(task)
              await task.promise
              page.cleanup?.()
              canvas.dataset.rendered = 'true'
            }
          } catch (e) {
            if (!cancelled) setError(e instanceof Error ? e.message : String(e))
          } finally {
            if (!cancelled) setLoading(false)
          }
        })()
        onCleanup(() => {
          cancelled = true
          for (const t of running) {
            try {
              t.cancel()
            } catch {
              // ya terminó
            }
          }
          void doc?.destroy().catch(() => {})
        })
      },
    ),
  )

  return (
    <div class="viewer-pdf" data-testid="viewer-pdf" ref={host}>
      <Show when={error()}>
        {(message) => (
          <p class="viewer-notice" role="alert">
            {format(es.viewer.pdfError, { message: message() })}
          </p>
        )}
      </Show>
      <Show when={loading() && error() === undefined}>
        <p class="viewer-notice">{es.viewer.loading}</p>
      </Show>
      <For each={pages()}>
        {(p) => (
          <canvas
            class="viewer-pdf-page"
            data-page={p.n}
            role="img"
            aria-label={format(es.viewer.pdfPage, { n: p.n, total: total() })}
          />
        )}
      </For>
      <Show when={total() > MAX_PDF_PAGES}>
        <p class="viewer-notice">
          {format(es.viewer.pdfTruncated, { max: MAX_PDF_PAGES, total: total() })}
        </p>
      </Show>
    </div>
  )
}
