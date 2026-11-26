/**
 * Diff unificado de dos textos (ACP da `oldText` y `newText` completos, no un parche). Puro y acotado: se
 * recortan el prefijo y el sufijo comunes y, si lo que queda es grande, se muestra como un solo bloque
 * reemplazado (sin LCS, que sería cuadrático).
 */

/** Celdas máximas de la tabla LCS (alto x ancho de lo que difiere). */
const MAX_CELLS = 1_000_000
const CONTEXT = 3

type Op = { kind: ' ' | '-' | '+'; text: string }

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Secuencia de operaciones entre dos listas de líneas (ya sin prefijo ni sufijo comunes). */
function middleOps(a: string[], b: string[]): Op[] {
  if (a.length === 0) return b.map((text) => ({ kind: '+', text }))
  if (b.length === 0) return a.map((text) => ({ kind: '-', text }))
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text): Op => ({ kind: '-', text })),
      ...b.map((text): Op => ({ kind: '+', text })),
    ]
  }
  const w = b.length + 1
  const table = new Uint32Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const idx = i * w + j
      table[idx] =
        a[i] === b[j]
          ? (table[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * w + j] ?? 0, table[i * w + j + 1] ?? 0)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] ?? '' })
      i++
      j++
    } else if ((table[(i + 1) * w + j] ?? 0) >= (table[i * w + j + 1] ?? 0)) {
      ops.push({ kind: '-', text: a[i] ?? '' })
      i++
    } else {
      ops.push({ kind: '+', text: b[j] ?? '' })
      j++
    }
  }
  while (i < a.length) ops.push({ kind: '-', text: a[i++] ?? '' })
  while (j < b.length) ops.push({ kind: '+', text: b[j++] ?? '' })
  return ops
}

/**
 * Parche unificado de `oldText` (o `null`/`undefined` si el archivo es nuevo) a `newText`. Vacío si no hay
 * cambios.
 */
export function unifiedDiff(
  path: string,
  oldText: string | null | undefined,
  newText: string,
): string {
  const a = splitLines(oldText ?? '')
  const b = splitLines(newText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const ops: Op[] = [
    ...a.slice(0, start).map((text): Op => ({ kind: ' ', text })),
    ...middleOps(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map((text): Op => ({ kind: ' ', text })),
  ]
  if (!ops.some((op) => op.kind !== ' ')) return ''

  // Agrupa los cambios en bloques con CONTEXT líneas de contexto a cada lado.
  const keep = new Array<boolean>(ops.length).fill(false)
  ops.forEach((op, index) => {
    if (op.kind === ' ') return
    for (
      let k = Math.max(0, index - CONTEXT);
      k <= Math.min(ops.length - 1, index + CONTEXT);
      k++
    ) {
      keep[k] = true
    }
  })
  // Una ruta absoluta no lleva barra de más: `a/proyecto/x.ts`, no `a//proyecto/x.ts`.
  const rel = path.startsWith('/') ? path : `/${path}`
  const header = [`--- ${oldText == null ? '/dev/null' : `a${rel}`}`, `+++ b${rel}`]
  const out: string[] = [...header]
  let index = 0
  let oldLine = 1
  let newLine = 1
  while (index < ops.length) {
    if (keep[index] !== true) {
      const kind = ops[index]?.kind
      if (kind !== '+') oldLine++
      if (kind !== '-') newLine++
      index++
      continue
    }
    const hunkOld = oldLine
    const hunkNew = newLine
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    while (index < ops.length && keep[index] === true) {
      const op = ops[index]
      if (op === undefined) break
      body.push(`${op.kind}${op.text}`)
      if (op.kind !== '+') {
        oldCount++
        oldLine++
      }
      if (op.kind !== '-') {
        newCount++
        newLine++
      }
      index++
    }
    out.push(
      `@@ -${oldCount === 0 ? hunkOld - 1 : hunkOld},${oldCount} +${newCount === 0 ? hunkNew - 1 : hunkNew},${newCount} @@`,
      ...body,
    )
  }
  return out.join('\n')
}
