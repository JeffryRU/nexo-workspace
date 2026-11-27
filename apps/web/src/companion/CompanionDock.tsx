import type { CompanionSheet } from '@nexo/contracts'
import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { es, format } from '../i18n/es.ts'
import { Icon } from '../ui/Icon.tsx'
import { useCompanion } from './model.tsx'
import { COMPANION_BOX, frameIntervalMs, frameOffset, frameScale, nextFrame } from './view.ts'
import './companion.css'

/** ¿El usuario pidió menos movimiento? Sigue los cambios de la preferencia mientras vive el componente. */
export function createReducedMotion(): () => boolean {
  const query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : undefined
  const [reduced, setReduced] = createSignal(query?.matches ?? false)
  if (query !== undefined) {
    const onChange = (e: { matches: boolean }) => setReduced(e.matches)
    query.addEventListener?.('change', onChange)
    onCleanup(() => query.removeEventListener?.('change', onChange))
  }
  return reduced
}

/**
 * La mascota en la esquina inferior izquierda de la ventana, debajo de la lista de espacios (no es una capa
 * encima del contenido: ocupa su propio sitio, así que no tapa pestañas, paneles, compositor ni barra de estado).
 * Sin mascota, oculta o sin nada que dibujar no ocupa nada.
 */
export function CompanionDock() {
  const companion = useCompanion()
  const reduced = createReducedMotion()
  return (
    <Show when={companion.shown()}>
      {(shown) => (
        <aside
          class="companion-dock"
          aria-label={es.companion.dockLabel}
          data-state={shown().drawnState}
          data-requested-state={shown().state}
          data-companion={shown().id}
        >
          <div class="companion-art">
            {/* Cada imagen nueva entra con un fundido; `keyed` la recrea al cambiar de URL (no hay dos a la vez). */}
            <Show when={shown().asset.url} keyed>
              {(url) => (
                <MascotImage
                  url={url}
                  sheet={shown().asset.sheet}
                  label={format(es.companion.image, {
                    name: shown().name,
                    state: es.companion.states[shown().state],
                  })}
                  reduced={reduced()}
                  onError={() => companion.markBroken(shown().drawnState)}
                />
              )}
            </Show>
          </div>
          <button
            type="button"
            class="icon-button subtle companion-hide"
            title={es.companion.hideHint}
            aria-label={es.companion.hide}
            onClick={() => companion.setHidden(true)}
          >
            <Icon name="x" />
          </button>
          {/* Aviso discreto del cambio de estado (educado: no interrumpe lo que se está leyendo). */}
          <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {format(es.companion.announce, {
              name: shown().name,
              state: es.companion.states[shown().state],
            })}
          </span>
        </aside>
      )}
    </Show>
  )
}

/**
 * La imagen, siempre como `<img>` (nunca el SVG incrustado, ni en `<object>`/`<iframe>`: dentro de un `<img>` el
 * navegador no ejecuta scripts ni carga recursos externos). Con hoja de sprites se recorta el cuadro actual con un
 * visor y se mueve la imagen; con `prefers-reduced-motion` queda fijo el primer cuadro.
 */
function MascotImage(props: {
  url: string
  sheet: CompanionSheet | undefined
  label: string
  reduced: boolean
  onError: () => void
}) {
  return (
    <Show
      when={props.sheet}
      fallback={
        <img
          class="companion-img"
          src={props.url}
          alt={props.label}
          width={COMPANION_BOX}
          height={COMPANION_BOX}
          draggable={false}
          decoding="async"
          onError={() => props.onError()}
        />
      }
    >
      {(sheet) => (
        <SheetImage
          url={props.url}
          sheet={sheet()}
          label={props.label}
          reduced={props.reduced}
          onError={props.onError}
        />
      )}
    </Show>
  )
}

function SheetImage(props: {
  url: string
  sheet: CompanionSheet
  label: string
  reduced: boolean
  onError: () => void
}) {
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    const sheet = props.sheet
    if (props.reduced) {
      setFrame(0)
      return
    }
    const timer = setInterval(
      () => setFrame((f) => nextFrame(sheet, f, false)),
      frameIntervalMs(sheet),
    )
    onCleanup(() => clearInterval(timer))
  })
  const scale = () => frameScale(props.sheet)
  const offset = () => frameOffset(props.sheet, frame())
  return (
    <span
      class="companion-sheet"
      data-frame={frame()}
      style={{
        width: `${props.sheet.frameWidth * scale()}px`,
        height: `${props.sheet.frameHeight * scale()}px`,
      }}
    >
      <img
        class="companion-img companion-sheet-img"
        src={props.url}
        alt={props.label}
        draggable={false}
        decoding="async"
        style={{
          transform: `scale(${scale()}) translate(${-offset().x}px, ${-offset().y}px)`,
        }}
        onError={() => props.onError()}
      />
    </span>
  )
}
