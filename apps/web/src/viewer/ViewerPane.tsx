import { fsApi } from '@nexo/client'
import type { PaneId } from '@nexo/contracts'
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from 'solid-js'
import { Markdown, type MarkdownEnv } from '../agent/markdown.tsx'
import { useModel } from '../app/model.tsx'
import { es, format } from '../i18n/es.ts'
import {
  decodeText,
  imageBlobType,
  isImageType,
  loadViewerFile,
  MAX_TEXT_CHARS,
  type ViewerLoad,
} from './load.ts'
import { PdfView } from './PdfView.tsx'
import { basename, dirname } from './paths.ts'
import type { PdfLoader } from './pdf.ts'
import './viewer.css'

/** Imágenes de un Markdown: más grandes que esto no se cargan dentro del texto. */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

/**
 * Panel `viewer` (F4.2): lee el archivo por `fs.read` (dentro del sandbox del daemon) y lo muestra según su tipo.
 * Nada del contenido llega al DOM como HTML: el Markdown pasa por el analizador seguro, el texto va en un
 * `<pre>`, las imágenes (SVG incluido) solo como `<img>` con una URL `blob:` y el PDF como canvas.
 */
export function ViewerPane(props: {
  paneId: PaneId
  path: string | undefined
  pdfLoader?: PdfLoader
}) {
  const app = useModel()
  const [version, setVersion] = createSignal(0)
  let abort: AbortController | undefined

  const reader = () => {
    const client = app.agentClient()
    return client === undefined ? undefined : fsApi(client)
  }

  const [file] = createResource(
    () => (props.path === undefined ? undefined : { path: props.path, v: version() }),
    async (key): Promise<ViewerLoad> => {
      abort?.abort()
      const controller = new AbortController()
      abort = controller
      const fs = reader()
      if (fs === undefined) throw new Error(es.status.offline)
      return loadViewerFile(fs, key.path, { signal: controller.signal })
    },
  )
  onCleanup(() => abort?.abort())

  const loaded = () => (file.error ? undefined : file.latest)
  const ok = createMemo(() => {
    const f = loaded()
    return f?.status === 'ok' ? f : undefined
  })

  // Al volver a la ventana se mira el archivo (`fs.stat`, barato) y solo se relee si cambió en disco.
  const checkChanged = async () => {
    const current = ok()
    const fs = reader()
    if (current === undefined || fs === undefined || props.path === undefined) return
    try {
      const st = await fs.stat(props.path)
      if (st.mtimeMs !== current.mtimeMs || st.size !== current.size) setVersion((v) => v + 1)
    } catch {
      // si ya no existe, se queda lo que se muestra
    }
  }
  createEffect(() => {
    const onFocus = () => void checkChanged()
    globalThis.addEventListener('focus', onFocus)
    onCleanup(() => globalThis.removeEventListener('focus', onFocus))
  })

  const env = createMemo<MarkdownEnv>(() => {
    const urls = new Map<string, Promise<string | undefined>>()
    const created: string[] = []
    onCleanup(() => {
      for (const u of created) URL.revokeObjectURL(u)
    })
    return {
      baseDir: props.path === undefined ? undefined : dirname(props.path),
      openFile: (path) => void app.actions.openInViewer(props.paneId, path),
      loadImage: (path) => {
        let pending = urls.get(path)
        if (pending === undefined) {
          pending = (async () => {
            const fs = reader()
            if (fs === undefined) return undefined
            const f = await loadViewerFile(fs, path)
            if (f.status !== 'ok' || !isImageType(f.type)) return undefined
            if (f.bytes.length > MAX_INLINE_IMAGE_BYTES) return undefined
            const blob = new Blob([f.bytes as BlobPart], { type: imageBlobType(f.mime) })
            const url = URL.createObjectURL(blob)
            created.push(url)
            return url
          })().catch(() => undefined)
          urls.set(path, pending)
        }
        return pending
      },
    }
  })

  const errorMessage = () => {
    const e = file.error as unknown
    return e instanceof Error ? e.message : String(e)
  }

  return (
    <div class="viewer" data-testid="viewer" aria-busy={file.loading}>
      <Show when={props.path} fallback={<p class="viewer-notice">{es.viewer.noFile}</p>}>
        {(path) => (
          <>
            <div class="viewer-bar">
              <span class="viewer-path ellipsis" title={path()}>
                {path()}
              </span>
              <Show when={ok()}>
                {(f) => <span class="viewer-meta">{humanSize(f().size)}</span>}
              </Show>
              <button
                type="button"
                class="text-button"
                title={es.viewer.reloadTitle}
                onClick={() => setVersion((v) => v + 1)}
              >
                {es.viewer.reload}
              </button>
            </div>
            <div class="viewer-body">
              <Show when={file.error}>
                <p class="viewer-notice" role="alert">
                  {format(es.viewer.error, { message: errorMessage() })}
                </p>
              </Show>
              <Show when={file.loading && loaded() === undefined}>
                <p class="viewer-notice">{es.viewer.loading}</p>
              </Show>
              <Show when={loaded()}>
                {(f) => <Content load={f()} env={env()} pdfLoader={props.pdfLoader} />}
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

function Content(props: { load: ViewerLoad; env: MarkdownEnv; pdfLoader: PdfLoader | undefined }) {
  const ok = () => (props.load.status === 'ok' ? props.load : undefined)
  return (
    <Switch>
      <Match when={props.load.status === 'directory'}>
        <p class="viewer-notice">{es.viewer.directory}</p>
      </Match>
      <Match when={props.load.status === 'too-large'}>
        <p class="viewer-notice">
          {format(es.viewer.tooLarge, {
            size: humanSize((props.load as { size: number }).size),
            max: humanSize((props.load as { max: number }).max),
          })}
        </p>
      </Match>
      <Match when={props.load.status === 'binary'}>
        <p class="viewer-notice">
          {format(es.viewer.binary, {
            mime: (props.load as { mime: string }).mime || '?',
            size: humanSize((props.load as { size: number }).size),
          })}
        </p>
      </Match>
      <Match when={ok()}>
        {(f) => (
          <>
            <Show when={f().truncated}>
              <p class="viewer-notice">{es.viewer.truncated}</p>
            </Show>
            <Switch>
              <Match when={f().type === 'markdown'}>
                <article class="viewer-markdown">
                  <Markdown text={decodeText(f().bytes)} env={props.env} />
                </article>
              </Match>
              <Match when={f().type === 'text'}>
                <TextView text={decodeText(f().bytes)} />
              </Match>
              <Match when={isImageType(f().type)}>
                <ImageView bytes={f().bytes} mime={f().mime} name={basename(f().path)} />
              </Match>
              <Match when={f().type === 'pdf'}>
                <PdfView
                  bytes={f().bytes}
                  {...(props.pdfLoader === undefined ? {} : { loader: props.pdfLoader })}
                />
              </Match>
            </Switch>
          </>
        )}
      </Match>
    </Switch>
  )
}

function TextView(props: { text: string }) {
  const shown = () =>
    props.text.length > MAX_TEXT_CHARS ? props.text.slice(0, MAX_TEXT_CHARS) : props.text
  return (
    <>
      <Show when={props.text.length > MAX_TEXT_CHARS}>
        <p class="viewer-notice">{format(es.viewer.textTruncated, { max: MAX_TEXT_CHARS })}</p>
      </Show>
      <pre class="viewer-text" data-testid="viewer-text">
        {shown()}
      </pre>
    </>
  )
}

/** Imagen (y SVG) solo como `<img>` con URL `blob:`: un `<img>` no ejecuta scripts ni carga recursos externos. */
function ImageView(props: { bytes: Uint8Array; mime: string; name: string }) {
  const url = createMemo(() => {
    const u = URL.createObjectURL(
      new Blob([props.bytes as BlobPart], { type: imageBlobType(props.mime) }),
    )
    onCleanup(() => URL.revokeObjectURL(u))
    return u
  })
  return (
    <div class="viewer-image-wrap">
      <img
        class="viewer-image"
        data-testid="viewer-image"
        src={url()}
        alt={format(es.viewer.imageAlt, { name: props.name })}
        decoding="async"
      />
    </div>
  )
}
