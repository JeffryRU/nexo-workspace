import type { ProviderLimits, UsageWindow } from '@nexo/contracts'
import { es, format } from '../i18n/es.ts'

/** Funciones puras del indicador de límites (F4.5): peor porcentaje, umbrales de color, formato y reinicio. */

export type Level = 'ok' | 'warn' | 'high'

/** Desde aquí el indicador pasa a «alto» (ámbar) y a «crítico» (rojo). */
export const WARN_AT = 70
export const HIGH_AT = 90

/** Porcentaje usado de una ventana, acotado a 0-100; `undefined` si no es un número (valor absurdo del daemon). */
export function percentOf(w: Pick<UsageWindow, 'usedPercent'>): number | undefined {
  const p = w.usedPercent
  if (typeof p !== 'number' || Number.isNaN(p)) return undefined
  return Math.min(100, Math.max(0, p))
}

export function levelOf(percent: number | undefined): Level {
  if (percent === undefined) return 'ok'
  if (percent >= HIGH_AT) return 'high'
  if (percent >= WARN_AT) return 'warn'
  return 'ok'
}

/** El mayor porcentaje de las ventanas válidas; `undefined` si no hay ninguna. */
export function worstPercent(
  windows: readonly Pick<UsageWindow, 'usedPercent'>[],
): number | undefined {
  let worst: number | undefined
  for (const w of windows) {
    const p = percentOf(w)
    if (p !== undefined && (worst === undefined || p > worst)) worst = p
  }
  return worst
}

/** `83,5` -> `84 %`; nunca `NaN`. */
export function formatPercent(percent: number | undefined): string {
  if (percent === undefined || Number.isNaN(percent)) return '?'
  return `${Math.round(Math.min(100, Math.max(0, percent)))} %`
}

export type ProviderSummary = {
  provider: string
  limits: ProviderLimits
  /** Peor porcentaje, si hay ventanas con dato. */
  worst: number | undefined
  level: Level
  /** `true` si no hay porcentaje que mostrar. */
  unknown: boolean
  /** `true` si el límite se alcanzó o el proveedor marca una ventana en `limit`. */
  reached: boolean
}

/** Resumen por proveedor, ordenado por id, sin los que no ofrecen límites (`unsupported`). */
export function summarize(all: readonly ProviderLimits[]): ProviderSummary[] {
  const out: ProviderSummary[] = []
  for (const limits of all) {
    if (limits.status === 'unsupported') continue
    const windows = Array.isArray(limits.windows) ? limits.windows : []
    const worst = worstPercent(windows)
    out.push({
      provider: limits.provider,
      limits,
      worst,
      level: levelOf(worst),
      unknown: worst === undefined,
      reached: limits.reached === true || windows.some((w) => w.state === 'limit'),
    })
  }
  return out.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
}

/** Sustituye (o añade) lo que se sabía de un proveedor por la lectura nueva. */
export function replaceProvider(
  current: readonly ProviderLimits[],
  next: ProviderLimits,
): ProviderLimits[] {
  const i = current.findIndex((p) => p.provider === next.provider)
  if (i < 0) return [...current, next]
  const copy = [...current]
  copy[i] = next
  return copy
}

/** Nombre de una ventana para mostrar: el etiquetado por el proveedor o uno conocido por su id. */
export function windowName(w: Pick<UsageWindow, 'id' | 'label'>): string {
  if (w.label !== undefined && w.label !== '') return w.label
  const names: Record<string, string> = es.limits.windowNames
  return Object.hasOwn(names, w.id) ? (names[w.id] as string) : w.id
}

/** Duración de una ventana en palabras cortas (`5 h`, `7 d`); `undefined` si no se conoce. */
export function windowDuration(minutes: number | undefined): string | undefined {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return undefined
  if (minutes % 1440 === 0) return `${minutes / 1440} d`
  if (minutes % 60 === 0) return `${minutes / 60} h`
  if (minutes > 60) return `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`
  return `${Math.round(minutes)} min`
}

/** Fecha y hora **locales** a minutos; `?` si no es una fecha válida. */
export function formatResetAt(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '?'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '?'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Tiempo que falta hasta `resetsAt` en palabras (`en 2 h 5 min`); `ya pasó` si es anterior a `now`. */
export function formatRemaining(resetsAt: number | undefined, now: number): string | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || !Number.isFinite(now))
    return undefined
  const diff = resetsAt - now
  // La resta de dos finitos puede desbordar a ±Infinity (p. ej. MAX_VALUE − (−MAX_VALUE)).
  if (!Number.isFinite(diff)) return undefined
  if (diff <= 0) return es.limits.already
  const minutes = Math.ceil(diff / 60_000)
  if (minutes < 60) return format(es.limits.inMinutes, { minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return format(es.limits.inHours, { hours, minutes: minutes % 60 })
  return format(es.limits.inDays, { days: Math.floor(hours / 24), hours: hours % 24 })
}

/** Texto corto del indicador de un proveedor: `83 %` o `desconocido`. */
export function summaryText(s: ProviderSummary): string {
  return s.unknown ? es.limits.unknown : formatPercent(s.worst)
}
