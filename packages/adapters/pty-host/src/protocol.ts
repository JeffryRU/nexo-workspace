import { z } from 'zod'

/** Protocolo IPC entre el adaptador (daemon) y el proceso «pty host». Se valida en ambos extremos. */

export const MAX_TERMINAL_ID = 2 ** 31 - 1
/** Una escritura por mensaje; el adaptador trocea las mayores. */
export const MAX_WRITE_CHARS = 64 * 1024
/** Un fragmento de salida por mensaje (node-pty entrega trozos de unos pocos KiB). */
export const MAX_DATA_CHARS = 1024 * 1024
export const MAX_SPAWN_ENV_BYTES = 1024 * 1024
const MAX_ARGS = 1024
const MAX_TEXT = 32 * 1024

const id = z.number().int().min(1).max(MAX_TERMINAL_ID)
const size = z.number().int().min(1).max(1000)
const text = z
  .string()
  .max(MAX_TEXT)
  .refine((s) => !s.includes('\u0000'), 'contiene NUL')

export const HostRequestSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('spawn'),
    id,
    file: text.min(1),
    args: z.array(text).max(MAX_ARGS),
    cwd: text.min(1),
    env: z.record(z.string().max(MAX_TEXT), z.string().max(MAX_TEXT)),
    name: text,
    cols: size,
    rows: size,
    conptyDll: z.boolean(),
  }),
  z.strictObject({ t: z.literal('write'), id, data: z.string().max(MAX_WRITE_CHARS) }),
  z.strictObject({ t: z.literal('resize'), id, cols: size, rows: size }),
  /** Cierre ordenado: el host mata todas las terminales y sale. */
  z.strictObject({ t: z.literal('shutdown') }),
  z.strictObject({
    t: z.literal('kill'),
    id,
    signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP']).optional(),
  }),
])
export type HostRequest = z.infer<typeof HostRequestSchema>

export const HostEventSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('ready') }),
  z.strictObject({ t: z.literal('spawned'), id, pid: z.number().int().min(1) }),
  z.strictObject({ t: z.literal('spawn-error'), id, message: z.string().max(MAX_TEXT) }),
  z.strictObject({ t: z.literal('data'), id, data: z.string().max(MAX_DATA_CHARS) }),
  z.strictObject({
    t: z.literal('exit'),
    id,
    /** `null` cuando node-pty no informó el código de salida (ocurre con ConPTY al cerrarse en plena operación). */
    exitCode: z.number().int().nullable(),
    signal: z.number().int().nullable(),
  }),
])
export type HostEvent = z.infer<typeof HostEventSchema>

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  const r = schema.safeParse(raw)
  if (r.success) return { ok: true, value: r.data }
  const issue = r.error.issues[0]
  return { ok: false, error: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'inválido'}` }
}

export const parseHostRequest = (raw: unknown): ParseResult<HostRequest> =>
  parseWith(HostRequestSchema, raw)
export const parseHostEvent = (raw: unknown): ParseResult<HostEvent> =>
  parseWith(HostEventSchema, raw)
