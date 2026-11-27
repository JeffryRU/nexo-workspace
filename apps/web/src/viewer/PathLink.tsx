import { type JSX, Show, useContext } from 'solid-js'
import { MarkdownEnvContext } from '../agent/markdown.tsx'
import { es } from '../i18n/es.ts'
import { resolveLocalPath } from './paths.ts'

/**
 * Una ruta de archivo de un bloque del agente (acciones `edit`, diffs). Si se puede resolver contra la carpeta del
 * espacio se ofrece abrirla en el visor; si no (ruta rara, sin entorno) se muestra como texto. Nunca abre nada solo.
 */
export function PathLink(props: { path: string; class?: string }): JSX.Element {
  const env = useContext(MarkdownEnvContext)
  const resolved = () => (env === undefined ? undefined : resolveLocalPath(env.baseDir, props.path))
  return (
    <Show
      when={resolved()}
      fallback={
        <span class={props.class} title={props.path}>
          {props.path}
        </span>
      }
    >
      {(abs) => (
        <button
          type="button"
          class={`path-link ${props.class ?? ''}`.trim()}
          title={`${es.viewer.openInViewer}: ${abs()}`}
          onClick={() => env?.openFile(abs())}
        >
          {props.path}
        </button>
      )}
    </Show>
  )
}
