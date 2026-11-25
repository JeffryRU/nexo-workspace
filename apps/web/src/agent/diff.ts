export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'
export type DiffLine = { kind: DiffLineKind; text: string }

/** Líneas que se pintan como mucho; el resto se resume ("N líneas más"). */
export const MAX_DIFF_LINES = 2000

/** Clasifica un diff unificado línea a línea. Es texto: nunca se interpreta nada. */
export function parseDiff(patch: string): { lines: DiffLine[]; hidden: number } {
  const all = patch.replace(/\r\n/g, '\n').split('\n')
  if (all.length > 1 && all[all.length - 1] === '') all.pop()
  let inHunk = false
  const lines: DiffLine[] = []
  for (const text of all.slice(0, MAX_DIFF_LINES)) {
    let kind: DiffLineKind
    if (text.startsWith('@@')) {
      kind = 'hunk'
      inHunk = true
    } else if (
      !inHunk &&
      (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity )/.test(text) || text === '')
    ) {
      kind = 'meta'
    } else if (text.startsWith('+')) kind = 'add'
    else if (text.startsWith('-')) kind = 'del'
    else if (text.startsWith('\\')) kind = 'meta'
    else kind = 'ctx'
    lines.push({ kind, text })
  }
  return { lines, hidden: Math.max(0, all.length - MAX_DIFF_LINES) }
}

/** Cuántas líneas se añaden y se quitan (para el resumen del encabezado). */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'add') added++
    else if (l.kind === 'del') removed++
  }
  return { added, removed }
}
