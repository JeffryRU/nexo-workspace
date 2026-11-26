import { z } from 'zod'
import { LIMITS } from './limits.ts'

export const ERROR_CODES = [
  'INVALID_PARAMS',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'CONFLICT',
  'INTERNAL',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
] as const

export const ErrorCode = z.enum(ERROR_CODES)
export type ErrorCode = z.infer<typeof ErrorCode>

export const ErrorBody = z.object({
  code: ErrorCode,
  message: z.string().max(LIMITS.maxErrorMessageLength),
  data: z.unknown().optional(),
})
export type ErrorBody = z.infer<typeof ErrorBody>
