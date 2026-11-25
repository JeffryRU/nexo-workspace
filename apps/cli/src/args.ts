import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import { usageError } from './errors.ts'
import { sanitize } from './text.ts'

export type OptionSpec = Record<string, { type: 'boolean' | 'string'; short?: string }>

/** Opciones globales: valen en cualquier comando y en cualquier posición. */
export const GLOBAL_OPTIONS: OptionSpec = {
  json: { type: 'boolean' },
  'no-start': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

export type Parsed = {
  values: Record<string, string | boolean | undefined>
  positionals: string[]
}

const PARSE_MESSAGES: Record<string, string> = {
  ERR_PARSE_ARGS_UNKNOWN_OPTION: 'opción desconocida',
  ERR_PARSE_ARGS_INVALID_OPTION_VALUE: 'valor de opción no válido (¿falta el valor?)',
  ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: 'argumento inesperado',
}

/** `parseArgs` estricto con las globales; los errores salen como errores de uso en español. */
export function parseArgv(args: readonly string[], spec: OptionSpec = {}): Parsed {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { ...GLOBAL_OPTIONS, ...spec } as ParseArgsOptionsConfig,
      allowPositionals: true,
      strict: true,
    })
    return { values: values as Parsed['values'], positionals }
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    const detail = sanitize(String((error as Error).message ?? ''), 120)
    throw usageError(`${PARSE_MESSAGES[code] ?? 'argumentos no válidos'}: ${detail}`)
  }
}

/** Separa `args` en lo anterior y posterior al primer `--`. */
export function splitDashDash(args: readonly string[]): { before: string[]; after: string[] } {
  const i = args.indexOf('--')
  if (i === -1) return { before: [...args], after: [] }
  return { before: args.slice(0, i), after: args.slice(i + 1) }
}

export const str = (p: Parsed, name: string): string | undefined => {
  const v = p.values[name]
  return typeof v === 'string' ? v : undefined
}

export const flag = (p: Parsed, name: string): boolean => p.values[name] === true

/** Entero positivo acotado desde una opción de texto. */
export function intOption(
  p: Parsed,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = str(p, name)
  if (raw === undefined) return fallback
  if (!/^\d{1,9}$/.test(raw)) throw usageError(`--${name} debe ser un entero entre ${min} y ${max}`)
  const n = Number(raw)
  if (n < min || n > max) throw usageError(`--${name} debe ser un entero entre ${min} y ${max}`)
  return n
}

export function expectPositionals(p: Parsed, min: number, max: number, usage: string): string[] {
  if (p.positionals.length < min || p.positionals.length > max) {
    throw usageError(`uso: ${usage}`)
  }
  return p.positionals
}
