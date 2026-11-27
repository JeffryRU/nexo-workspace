import { COMPANION_STATES, CompanionAssetPath, type CompanionState } from '@nexo/contracts'
import { decodeUtf8, encodeUtf8, FakeClock, tinyCompanion } from '@nexo/testkit'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  COMPANION_PRIORITY,
  checkSvgSafety,
  companionTarget,
  inspectCompanionImage,
  manifestAssetPaths,
  parseCompanionManifest,
  parseCompanionManifestText,
} from './companion-rules.ts'
import { CompanionStateMachine, DEFAULT_COMPANION_TIMING } from './companion-state.ts'

const base = JSON.parse(decodeUtf8(tinyCompanion()['companion.json'] as Uint8Array))

const junk: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.string({ maxLength: 30 }),
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 10 }), tie('value'), { maxKeys: 4 }),
  ),
})).value

describe('parseCompanionManifest (propiedades)', () => {
  it('nunca lanza con entradas arbitrarias y, si acepta, el resultado cumple lo prometido', () => {
    fc.assert(
      fc.property(junk, (raw) => {
        const r = parseCompanionManifest(raw)
        if (r.ok) expect(r.value.states.idle).toBeDefined()
        else expect(r.reason.length).toBeLessThan(200)
      }),
      { numRuns: 300 },
    )
  })

  it('nunca lanza con texto arbitrario', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (t) => {
        expect(() => parseCompanionManifestText(t)).not.toThrow()
      }),
    )
  })

  it('un manifiesto válido con una ruta hostil o con un campo extra en cualquier nivel se rechaza', () => {
    const hostile = fc.oneof(
      fc.constantFrom('..', '.', '~', 'a b', 'a\\b', 'a:b', '', ' '),
      fc.string({ maxLength: 12 }),
    )
    fc.assert(
      fc.property(hostile, (seg) => {
        const src = `${seg}/x.png`
        const ok = CompanionAssetPath.safeParse(src).success
        const r = parseCompanionManifest({ ...base, states: { idle: { src } } })
        const reserved = seg.split('/').some((p) => /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))
        expect(r.ok).toBe(ok && !reserved)
      }),
      { numRuns: 300 },
    )
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 8 }), (key) => {
        fc.pre(!(key in base))
        expect(parseCompanionManifest({ ...base, [key]: 1 }).ok).toBe(false)
        expect(parseCompanionManifest({ ...base, author: { name: 'x', [key]: 1 } }).ok).toBe(false)
      }),
    )
  })

  it('las rutas aceptadas no salen del paquete: sin .., barras invertidas, unidad ni segmentos vacíos', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (p) => {
        if (!CompanionAssetPath.safeParse(p).success) return
        expect(p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')).toBe(true)
        expect(p).not.toMatch(/[\\:]/)
        expect([...p].some((c) => (c.codePointAt(0) as number) < 0x20)).toBe(false)
        expect(p.startsWith('/')).toBe(false)
      }),
      { numRuns: 1000 },
    )
  })

  it('manifestAssetPaths no repite rutas', () => {
    const r = parseCompanionManifest(base)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const paths = manifestAssetPaths(r.value)
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('imágenes y SVG (propiedades)', () => {
  it('inspectCompanionImage no lanza con bytes arbitrarios', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 200 }),
        fc.constantFrom('a.png', 'a.gif', 'a.webp', 'a.svg', 'a.jpg', ''),
        (bytes, name) => {
          expect(() => inspectCompanionImage(bytes, name)).not.toThrow()
        },
      ),
      { numRuns: 500 },
    )
  })

  it('inspectCompanionImage no se deja engañar por un prefijo mágico + basura', () => {
    const sigs = [
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      [...encodeUtf8('GIF89a')],
      [...encodeUtf8('RIFF'), 0, 0, 0, 0, ...encodeUtf8('WEBP')],
    ]
    fc.assert(
      fc.property(fc.constantFrom(...sigs), fc.uint8Array({ maxLength: 40 }), (sig, tail) => {
        const r = inspectCompanionImage(Uint8Array.from([...sig, ...tail]), 'a.png')
        if (r.ok) {
          expect(r.value.width).toBeGreaterThanOrEqual(1)
          expect(r.value.width).toBeLessThanOrEqual(4096)
        }
      }),
      { numRuns: 500 },
    )
  })

  it('un SVG al que se le inyecta cualquier construcción peligrosa se rechaza', () => {
    const danger = [
      '<script>x</script>',
      '<foreignObject/>',
      '<iframe/>',
      '<rect onload="x"/>',
      '<a href="javascript:x"/>',
      '<image href="https://x.example/a.png"/>',
      '<style>@import "x";</style>',
      '&#x41;',
    ]
    fc.assert(
      fc.property(
        fc.constantFrom(...danger),
        fc.constantFrom('', ' ', '\n', '<g/>', '<!-- c -->'),
        fc.constantFrom('', ' ', '\n', '<g/>'),
        (bad, before, after) => {
          const svg = `<svg xmlns="http://www.w3.org/2000/svg">${before}${bad}${after}</svg>`
          expect(checkSvgSafety(encodeUtf8(svg))).toBeDefined()
        },
      ),
    )
  })

  it('checkSvgSafety no lanza con bytes arbitrarios', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (b) => {
        expect(() => checkSvgSafety(b)).not.toThrow()
      }),
      { numRuns: 500 },
    )
  })
})

describe('companionTarget (propiedades)', () => {
  const attention = fc.constantFrom('idle', 'working', 'needs-input', 'done', 'error')

  it('no depende del orden y needs-input siempre gana', () => {
    fc.assert(
      fc.property(fc.array(attention, { maxLength: 12 }), (list) => {
        const target = companionTarget(list)
        expect(companionTarget([...list].reverse())).toBe(target)
        if (list.includes('needs-input')) expect(target).toBe('waiting')
        else if (list.includes('error')) expect(target).toBe('error')
      }),
    )
  })

  it('añadir una sesión nunca baja la prioridad del estado, salvo idle', () => {
    fc.assert(
      fc.property(fc.array(attention, { maxLength: 8 }), attention, (list, extra) => {
        const before = COMPANION_PRIORITY[companionTarget(list)]
        const after = COMPANION_PRIORITY[companionTarget([...list, extra])]
        expect(after).toBeGreaterThanOrEqual(before)
      }),
    )
  })
})

describe('CompanionStateMachine (propiedades)', () => {
  type Step =
    | { kind: 'target'; state: CompanionState; fresh: boolean }
    | { kind: 'wait'; ms: number }
  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({
      kind: fc.constant('target' as const),
      state: fc.constantFrom(...COMPANION_STATES),
      fresh: fc.boolean(),
    }),
    fc.record({ kind: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 8000 }) }),
  )
  const timing = DEFAULT_COMPANION_TIMING

  function run(steps: Step[]) {
    const clock = new FakeClock(0)
    const changes: { state: CompanionState; at: number }[] = []
    const machine = new CompanionStateMachine({
      clock,
      onChange: (state) => changes.push({ state, at: clock.now() }),
    })
    let target: CompanionState = 'idle'
    for (const s of steps) {
      if (s.kind === 'target') {
        target = s.state
        machine.setTarget(s.state, s.fresh)
      } else clock.advance(s.ms)
    }
    return { clock, changes, machine, target }
  }

  it('ninguna salida a un estado de igual o menor prioridad ocurre antes del tiempo mínimo', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        const { changes } = run(steps)
        let prev: CompanionState = 'idle'
        let since = 0
        for (const c of changes) {
          if (COMPANION_PRIORITY[c.state] <= COMPANION_PRIORITY[prev]) {
            expect(c.at - since).toBeGreaterThanOrEqual(timing.minShowMs[prev])
          }
          expect(c.state).not.toBe(prev)
          prev = c.state
          since = c.at
        }
      }),
      { numRuns: 300 },
    )
  })

  it('con el objetivo quieto, converge al objetivo (done decae a idle) y no deja temporizadores', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
        const { clock, machine, target } = run(steps)
        clock.advance(60_000)
        expect(machine.state).toBe(target === 'done' ? 'idle' : target)
        expect(clock.pending).toBe(0)
      }),
      { numRuns: 300 },
    )
  })

  it('un objetivo de mayor prioridad que el visible se muestra en el acto', () => {
    fc.assert(
      fc.property(
        fc.array(step, { maxLength: 30 }),
        fc.constantFrom(...COMPANION_STATES),
        (steps, next) => {
          const { machine } = run(steps)
          if (next !== 'done' && COMPANION_PRIORITY[next] > COMPANION_PRIORITY[machine.state]) {
            machine.setTarget(next)
            expect(machine.state).toBe(next)
          }
        },
      ),
      { numRuns: 300 },
    )
  })
})
