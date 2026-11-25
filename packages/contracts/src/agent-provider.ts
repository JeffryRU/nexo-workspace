import { z } from 'zod'
import {
  BlockDraft,
  PermissionMode,
  PermissionOptions,
  ProviderSessionToken,
  Questions,
  StopReason,
  Token,
  TurnUsage,
} from './agent.ts'
import { LIMITS } from './limits.ts'
import { bodyText, lineText } from './text.ts'

/**
 * Eventos normalizados que un proveedor emite al daemon (`AgentProviderPort.onEvent`). No cruzan la red,
 * pero un adaptador los construye a partir de salida ajena (SDK, JSON-RPC, JSONL), así que el servicio de
 * agentes los valida antes de usarlos: un evento inválido se descarta y se registra, nunca rompe la sesión.
 *
 * `ref` es una clave local del proveedor (índice del bloque de contenido, id de la llamada...): el servicio
 * asigna el `BlockId`, el `index` y el `seq`.
 */
const Ref = lineText(128)

export const ProviderError = z.strictObject({
  code: lineText(64),
  message: bodyText(8 * 1024, 1),
  /** Sin remedio: la sesión pasa a `error`. */
  fatal: z.boolean(),
  retryable: z.boolean().optional(),
})
export type ProviderError = z.infer<typeof ProviderError>

export const ProviderEvent = z.discriminatedUnion('type', [
  /** Datos que el proveedor revela al arrancar (modelo real, ficha para reanudar...). */
  z.strictObject({
    type: z.literal('session-info'),
    providerSessionId: ProviderSessionToken.optional(),
    model: Token.optional(),
    effort: Token.optional(),
    permissionMode: PermissionMode.optional(),
    title: lineText(LIMITS.maxTitleLength).optional(),
  }),
  /** Abre un bloque (alta). Mientras no llegue `block-end`, `ref` sigue abierta. */
  z.strictObject({ type: z.literal('block-start'), ref: Ref, block: BlockDraft }),
  /** Texto añadido a un bloque abierto. Nunca parte un par sustituto. */
  z.strictObject({
    type: z.literal('block-delta'),
    ref: Ref,
    field: z.enum(['text', 'output']),
    text: bodyText(LIMITS.maxDeltaBytes, 1),
  }),
  /** Sustituye el contenido de un bloque abierto (p. ej. la entrada completa de una herramienta). */
  z.strictObject({ type: z.literal('block-update'), ref: Ref, block: BlockDraft }),
  /** Cierra el bloque; `block` es su contenido final si cambió. */
  z.strictObject({ type: z.literal('block-end'), ref: Ref, block: BlockDraft.optional() }),
  z.strictObject({
    type: z.literal('permission-request'),
    requestId: Ref,
    tool: lineText(128),
    title: lineText(LIMITS.maxTitleLength),
    detail: bodyText(LIMITS.maxBlockInputBytes).optional(),
    options: PermissionOptions,
  }),
  z.strictObject({ type: z.literal('question-request'), requestId: Ref, questions: Questions }),
  /** El proveedor retiró la solicitud (p. ej. se interrumpió el turno). */
  z.strictObject({ type: z.literal('request-cancelled'), requestId: Ref }),
  /** Uso acumulado del turno en curso. */
  z.strictObject({ type: z.literal('usage'), usage: TurnUsage }),
  /** Fin del turno: siempre exactamente uno por `send` (salvo que el proceso muera). */
  z.strictObject({
    type: z.literal('turn-end'),
    stopReason: StopReason,
    usage: TurnUsage.optional(),
  }),
  z.strictObject({ type: z.literal('error'), error: ProviderError }),
  /** El proceso o la conexión del proveedor terminó; la sesión ya no acepta turnos. */
  z.strictObject({
    type: z.literal('exit'),
    exitCode: z.int().nullable(),
    signal: lineText(32).nullable(),
  }),
])
export type ProviderEvent = z.infer<typeof ProviderEvent>
