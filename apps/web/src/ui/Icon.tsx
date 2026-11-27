import { For, type JSX } from 'solid-js'
import './icons.css'

/**
 * Iconos propios en SVG en línea: viewBox 24, trazo uniforme de 1.75 px, `currentColor`, sin dependencias.
 * Casi todos los trazos son del conjunto Lucide (https://lucide.dev, licencia ISC; ver NOTICE en la raíz del
 * repositorio); `sparkle` y `circle-half` son dibujos propios. Se pintan siempre `aria-hidden`: el nombre
 * accesible lo pone el botón o el elemento que los contiene (`aria-label` y `title`).
 */
type Shape = string | { d: string; fill: true }

const CIRCLE = 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0'
const FRAME = 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'

const ICONS = {
  plus: ['M5 12h14', 'M12 5v14'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  check: ['M20 6 9 17l-5-5'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'arrow-up': ['m5 12 7-7 7 7', 'M12 19V5'],
  'arrow-down': ['M12 5v14', 'm19 12-7 7-7-7'],
  'arrow-left': ['m12 19-7-7 7-7', 'M19 12H5'],
  swap: ['M8 3 4 7l4 4', 'M4 7h16', 'm16 21 4-4-4-4', 'M20 17H4'],
  'split-right': [FRAME, 'M12 3v18'],
  'split-down': [FRAME, 'M3 12h18'],
  'panel-left': [FRAME, 'M9 3v18'],
  stop: [
    { d: 'M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z', fill: true },
  ],
  sparkle: [
    'M10 3.5l1.9 5.1L17 10.5l-5.1 1.9L10 17.5l-1.9-5.1L3 10.5l5.1-1.9z',
    'M18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  ],
  circle: [CIRCLE],
  'circle-half': [CIRCLE, { d: 'M12 3a9 9 0 0 1 0 18z', fill: true }],
  clock: [CIRCLE, 'M12 7v5l3 2'],
  layers: ['m12 2 9 5-9 5-9-5z', 'm3 12 9 5 9-5', 'm3 17 9 5 9-5'],
  smile: [CIRCLE, 'M8 14s1.5 2 4 2 4-2 4-2', 'M9 9h.01', 'M15 9h.01'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  'bell-off': [
    'M8.7 3A6 6 0 0 1 18 8c0 2.7.5 4.6 1 6',
    'M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-2',
    'M10.3 21a1.94 1.94 0 0 0 3.4 0',
    'm2 2 20 20',
  ],
  gauge: ['m12 14 4-4', 'M3.3 19a10 10 0 1 1 17.4 0'],
} as const satisfies Record<string, readonly Shape[]>

export type IconName = keyof typeof ICONS
export type IconSize = 'sm' | 'md' | 'lg'

export const ICON_NAMES = Object.keys(ICONS) as IconName[]

/** Icono SVG decorativo; el tamaño sale de las variables `--icon-sm|md|lg`. */
export function Icon(props: { name: IconName; size?: IconSize; class?: string }): JSX.Element {
  const shapes = (): readonly Shape[] => (Object.hasOwn(ICONS, props.name) ? ICONS[props.name] : [])
  return (
    <svg
      class={`icon icon-${props.size ?? 'md'}${props.class === undefined ? '' : ` ${props.class}`}`}
      data-icon={props.name}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <For each={shapes()}>
        {(shape) =>
          typeof shape === 'string' ? <path d={shape} /> : <path d={shape.d} fill="currentColor" />
        }
      </For>
    </svg>
  )
}
