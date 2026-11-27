import { es } from '../i18n/es.ts'

/**
 * Panel `viewer` mínimo (F4.1): solo dice qué archivo apunta. No lee ni muestra nada: el visor real
 * (Markdown, imágenes, PDF, texto) llega con la F4.2 y leerá por `fs.read`.
 */
export function ViewerPlaceholder(props: { path: string | undefined }) {
  return (
    <div class="viewer-placeholder" data-testid="viewer-placeholder">
      <p>{es.viewer.placeholder}</p>
      <p class="viewer-path">{props.path ?? es.viewer.noFile}</p>
    </div>
  )
}
