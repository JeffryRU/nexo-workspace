import { z } from 'zod'
import { ErrorBody } from './errors.ts'
import { LIMITS } from './limits.ts'

export const PROTOCOL_VERSION = 1

export const RequestId = z.string().min(1).max(128)

/** cliente -> daemon. `params` se valida después, según `method`. */
export const RequestEnvelope = z.strictObject({
  v: z.literal(1),
  id: RequestId,
  method: z.string().min(1).max(LIMITS.maxMethodLength),
  params: z.unknown().optional(),
})
export type RequestEnvelope = z.infer<typeof RequestEnvelope>

/** daemon -> cliente. Los receptores toleran claves extra (compatibilidad hacia delante). */
export const OkResponse = z.object({
  v: z.literal(1),
  id: RequestId,
  ok: z.literal(true),
  result: z.unknown(),
})
export type OkResponse = z.infer<typeof OkResponse>

export const ErrorResponse = z.object({
  v: z.literal(1),
  id: RequestId,
  ok: z.literal(false),
  error: ErrorBody,
})
export type ErrorResponse = z.infer<typeof ErrorResponse>

export const EventEnvelope = z.object({
  v: z.literal(1),
  event: z.string().min(1).max(LIMITS.maxMethodLength),
  seq: z.int().nonnegative(),
  data: z.unknown(),
})
export type EventEnvelope = z.infer<typeof EventEnvelope>
