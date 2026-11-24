// TODO(F1): comandos ls, new, split, send, read, focus sobre @nexo/client.

export const HELP = 'nexo: CLI de Nexo (esqueleto, sin comandos todavia)'

/** Punto de entrada: devuelve el codigo de salida. */
export function main(argv: readonly string[]): { code: number; output: string } {
  if (argv.length === 0 || argv.includes('--help')) return { code: 0, output: HELP }
  return { code: 2, output: `comando desconocido: ${argv[0] ?? ''}` }
}
