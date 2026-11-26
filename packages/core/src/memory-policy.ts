import type { ProjectMemory } from '@nexo/contracts'
import { estimateTokens } from './memory-tokens.ts'

/** Umbrales de la memoria. Los valores por omisión son los del ADR 0007. */
export type MemoryThresholds = {
  /** Tokens nuevos de una sesión que disparan al Observador. */
  observerBatchTokens: number
  /** Tokens de observaciones de un proyecto que disparan al Reflector. */
  reflectorTokens: number
  /** Tope de tokens de la transcripción que recibe una sola llamada del Observador. */
  maxBatchTokens: number
}

export const DEFAULT_MEMORY_THRESHOLDS: MemoryThresholds = {
  observerBatchTokens: 6_000,
  reflectorTokens: 40_000,
  maxBatchTokens: 24_000,
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Completa y acota unos umbrales parciales (por ejemplo, de variables de entorno). Garantiza
 * `observerBatchTokens <= maxBatchTokens` y `reflectorTokens >= 2 * observerBatchTokens`, para que el
 * Reflector nunca se dispare con cada lote.
 */
export function resolveThresholds(partial: Partial<MemoryThresholds> = {}): MemoryThresholds {
  const d = DEFAULT_MEMORY_THRESHOLDS
  const observerBatchTokens = clampInt(
    partial.observerBatchTokens,
    500,
    200_000,
    d.observerBatchTokens,
  )
  const maxBatchTokens = clampInt(
    partial.maxBatchTokens,
    observerBatchTokens,
    400_000,
    Math.max(d.maxBatchTokens, observerBatchTokens),
  )
  const reflectorTokens = clampInt(
    partial.reflectorTokens,
    observerBatchTokens * 2,
    2_000_000,
    Math.max(d.reflectorTokens, observerBatchTokens * 2),
  )
  return { observerBatchTokens, reflectorTokens, maxBatchTokens }
}

/** ¿Hay tokens nuevos suficientes en la sesión para llamar al Observador? */
export function shouldObserve(pendingTokens: number, thresholds: MemoryThresholds): boolean {
  return pendingTokens >= thresholds.observerBatchTokens
}

/** Tokens estimados de las observaciones de un proyecto (la reflexión no cuenta). */
export function observationTokens(memory: Pick<ProjectMemory, 'observations'>): number {
  let total = 0
  for (const o of memory.observations) total += estimateTokens(o.text) + 8
  return total
}

export function reflectionTokens(memory: Pick<ProjectMemory, 'reflection'>): number {
  return memory.reflection === null ? 0 : estimateTokens(memory.reflection.text)
}

/** ¿Las observaciones del proyecto pasan del umbral del Reflector? */
export function shouldReflect(
  memory: Pick<ProjectMemory, 'observations'>,
  thresholds: MemoryThresholds,
): boolean {
  return observationTokens(memory) > thresholds.reflectorTokens
}

/** Tamaño al que apunta una reflexión: la mitad del umbral. */
export function reflectionTargetTokens(thresholds: MemoryThresholds): number {
  return Math.floor(thresholds.reflectorTokens / 2)
}
