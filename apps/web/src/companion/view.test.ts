import type { CompanionSheet, CompanionStateView } from '@nexo/contracts'
import { COMPANION_STATES } from '@nexo/contracts'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mkManifest } from './test-helpers.ts'
import {
  type DrawableAsset,
  decodeBase64,
  frameIntervalMs,
  frameOffset,
  frameScale,
  isCompanionMime,
  manifestPaths,
  mergeState,
  nextFrame,
  resolveAsset,
  sanitizeView,
  sheetLayout,
} from './view.ts'

const view = (
  state: CompanionStateView['state'],
  since: number,
  selected: string | null = 'tiny',
): CompanionStateView => ({ state, since, selected })

const sheet = (over: Partial<CompanionSheet> = {}): CompanionSheet => ({
  frameWidth: 8,
  frameHeight: 4,
  frames: 6,
  columns: 4,
  fps: 10,
  ...over,
})

describe('decodeBase64', () => {
  it('decodifica y comprueba el tamaño declarado', () => {
    expect([...(decodeBase64('AQID', 3) as Uint8Array)]).toEqual([1, 2, 3])
    expect(decodeBase64('AQID', 4)).toBeUndefined()
    expect(decodeBase64('AQID')).toBeDefined()
  })

  it('rechaza lo que no es base64 estricto', () => {
    for (const bad of [
      'AQI',
      'AQID=',
      'AQ ID',
      'AQID\n',
      '@@@@',
      'AQI=\u0000',
      '=AQI',
      'AQ==AQ==',
    ]) {
      expect(decodeBase64(bad)).toBeUndefined()
    }
    expect(decodeBase64(42)).toBeUndefined()
    expect(decodeBase64(undefined)).toBeUndefined()
    expect(decodeBase64('A'.repeat(800_000))).toBeUndefined()
  })

  it('propiedad: ida y vuelta con btoa', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (bytes) => {
        const text = btoa(String.fromCharCode(...bytes))
        const out = decodeBase64(text, bytes.length)
        return (
          out !== undefined && out.length === bytes.length && out.every((b, i) => b === bytes[i])
        )
      }),
    )
  })

  it('propiedad: nunca lanza con texto cualquiera', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        decodeBase64(s)
        decodeBase64(s, 3)
        return true
      }),
    )
    fc.assert(
      fc.property(fc.anything(), (v) => {
        decodeBase64(v)
        return true
      }),
    )
  })
})

describe('isCompanionMime', () => {
  it('solo los cuatro tipos de imagen', () => {
    for (const ok of ['image/png', 'image/webp', 'image/gif', 'image/svg+xml']) {
      expect(isCompanionMime(ok)).toBe(true)
    }
    for (const bad of ['text/html', 'image/png; charset=x', 'IMAGE/PNG', '', undefined, 5, null]) {
      expect(isCompanionMime(bad)).toBe(false)
    }
  })
})

describe('sanitizeView', () => {
  it('acepta un estado válido y rechaza lo raro', () => {
    expect(sanitizeView(view('idle', 5))).toEqual(view('idle', 5))
    expect(sanitizeView(view('busy', 5, null))).toEqual(view('busy', 5, null))
    for (const bad of [
      null,
      42,
      'x',
      [],
      {},
      { state: 'dormido', since: 1, selected: null },
      { state: 'idle', since: -1, selected: null },
      { state: 'idle', since: Number.NaN, selected: null },
      { state: 'idle', since: Number.POSITIVE_INFINITY, selected: null },
      { state: 'idle', since: '1', selected: null },
      { state: 'idle', since: 1, selected: '' },
      { state: 'idle', since: 1, selected: 7 },
      { state: 'idle', since: 1 },
    ]) {
      expect(sanitizeView(bad)).toBeUndefined()
    }
  })
})

describe('mergeState', () => {
  it('el primero siempre vale', () => {
    expect(mergeState(undefined, view('idle', 1))).toEqual(view('idle', 1))
  })

  it('un evento repetido conserva la misma referencia (no repinta)', () => {
    const cur = view('thinking', 10)
    expect(mergeState(cur, { ...cur })).toBe(cur)
  })

  it('un evento fuera de orden (más viejo, mismo compañero) se descarta', () => {
    const cur = view('done', 20)
    expect(mergeState(cur, view('thinking', 10))).toBe(cur)
  })

  it('un evento más nuevo o con otro compañero se acepta, aunque su since sea viejo', () => {
    expect(mergeState(view('idle', 10), view('busy', 11)).state).toBe('busy')
    expect(mergeState(view('idle', 10), view('idle', 5, 'otra')).selected).toBe('otra')
    expect(mergeState(view('idle', 10), view('idle', 5, null)).selected).toBeNull()
  })

  it('propiedad: el resultado es siempre el actual o el entrante y el mismo compañero nunca retrocede en el tiempo', () => {
    const arb = fc.record({
      state: fc.constantFrom(...COMPANION_STATES),
      since: fc.integer({ min: 0, max: 50 }),
      selected: fc.constantFrom<string | null>(null, 'a', 'b'),
    })
    fc.assert(
      fc.property(arb, fc.array(arb, { maxLength: 30 }), (first, events) => {
        let cur = first
        for (const e of events) {
          const next = mergeState(cur, e)
          if (next !== cur && next !== e) return false
          if (next.selected === cur.selected && next.since < cur.since) return false
          cur = next
        }
        return true
      }),
    )
  })
})

describe('resolveAsset', () => {
  const a = (url: string): DrawableAsset => ({ url })
  it('usa el estado, luego idle, luego nada', () => {
    const assets = { idle: a('i'), thinking: a('t') }
    expect(resolveAsset(assets, 'thinking')).toEqual({ state: 'thinking', asset: a('t') })
    expect(resolveAsset(assets, 'error')).toEqual({ state: 'idle', asset: a('i') })
    expect(resolveAsset({ thinking: a('t') }, 'error')).toBeUndefined()
    expect(resolveAsset({}, 'idle')).toBeUndefined()
  })

  it('salta los estados rotos', () => {
    const assets = { idle: a('i'), thinking: a('t') }
    expect(resolveAsset(assets, 'thinking', new Set(['thinking']))?.state).toBe('idle')
    expect(resolveAsset(assets, 'thinking', new Set(['thinking', 'idle']))).toBeUndefined()
  })

  it('propiedad: nunca devuelve un estado roto ni uno que no tiene imagen', () => {
    const states = fc.constantFrom(...COMPANION_STATES)
    fc.assert(
      fc.property(
        fc.subarray([...COMPANION_STATES]),
        fc.subarray([...COMPANION_STATES]),
        states,
        (have, bad, want) => {
          const assets = Object.fromEntries(have.map((s) => [s, a(s)]))
          const r = resolveAsset(assets, want, new Set(bad))
          if (r === undefined) return true
          return (
            have.includes(r.state) &&
            !bad.includes(r.state) &&
            (r.state === want || r.state === 'idle')
          )
        },
      ),
    )
  })
})

describe('manifestPaths', () => {
  it('rutas distintas en orden de estados; una imagen compartida cuenta una vez', () => {
    expect(manifestPaths(mkManifest('tiny'))).toEqual([
      'idle.png',
      'think.png',
      'sheet.png',
      'error.svg',
    ])
    const m = mkManifest('tiny', { thinking: { src: 'idle.png' } })
    expect(manifestPaths(m)).toEqual(['idle.png', 'sheet.png', 'error.svg'])
  })
})

describe('hojas de sprites', () => {
  it('geometría por filas de `columns`', () => {
    expect(sheetLayout(sheet())).toEqual({ columns: 4, rows: 2 })
    expect(sheetLayout(sheet({ columns: undefined }))).toEqual({ columns: 6, rows: 1 })
    expect(frameOffset(sheet(), 0)).toEqual({ x: 0, y: 0 })
    expect(frameOffset(sheet(), 3)).toEqual({ x: 24, y: 0 })
    expect(frameOffset(sheet(), 4)).toEqual({ x: 0, y: 4 })
    expect(frameOffset(sheet(), 5)).toEqual({ x: 8, y: 4 })
  })

  it('un índice fuera de rango o raro se acota', () => {
    expect(frameOffset(sheet(), 99)).toEqual({ x: 8, y: 4 })
    expect(frameOffset(sheet(), -3)).toEqual({ x: 0, y: 0 })
    expect(frameOffset(sheet(), Number.NaN)).toEqual({ x: 0, y: 0 })
  })

  it('nextFrame: da la vuelta, se queda en el último sin loop y con reduced-motion es el primero', () => {
    expect(nextFrame(sheet(), 0, false)).toBe(1)
    expect(nextFrame(sheet(), 5, false)).toBe(0)
    expect(nextFrame(sheet({ loop: false }), 5, false)).toBe(5)
    expect(nextFrame(sheet(), 3, true)).toBe(0)
  })

  it('intervalo y escala razonables', () => {
    expect(frameIntervalMs(sheet({ fps: 10 }))).toBe(100)
    expect(frameIntervalMs(sheet({ fps: 60 }))).toBe(17)
    expect(frameIntervalMs(sheet({ fps: Number.NaN }))).toBe(1000)
    expect(frameIntervalMs(sheet({ fps: 0 }))).toBe(10_000)
    expect(frameScale(sheet({ frameWidth: 32, frameHeight: 32 }))).toBe(3)
    expect(frameScale(sheet({ frameWidth: 40, frameHeight: 20 }))).toBe(2)
    expect(frameScale(sheet({ frameWidth: 400, frameHeight: 400 }))).toBeCloseTo(0.24)
  })

  it('propiedad: el cuadro siempre queda dentro de la hoja', () => {
    const arb = fc
      .record({
        frameWidth: fc.integer({ min: 1, max: 64 }),
        frameHeight: fc.integer({ min: 1, max: 64 }),
        frames: fc.integer({ min: 1, max: 64 }),
        fps: fc.double({ min: 0.1, max: 60, noNaN: true }),
        loop: fc.boolean(),
      })
      .chain((base) =>
        fc.integer({ min: 1, max: base.frames }).map((columns) => ({ ...base, columns })),
      )
    fc.assert(
      fc.property(arb, fc.integer({ min: -5, max: 200 }), fc.boolean(), (s, i, reduced) => {
        const { columns, rows } = sheetLayout(s)
        const { x, y } = frameOffset(s, i)
        const n = nextFrame(s, Math.min(Math.max(i, 0), s.frames - 1), reduced)
        return (
          x >= 0 &&
          y >= 0 &&
          x + s.frameWidth <= columns * s.frameWidth &&
          y + s.frameHeight <= rows * s.frameHeight &&
          n >= 0 &&
          n < s.frames
        )
      }),
    )
  })
})
