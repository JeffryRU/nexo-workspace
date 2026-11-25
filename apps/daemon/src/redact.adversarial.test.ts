import { describe, expect, it } from 'vitest'
import { JsonLogger } from './adapters/logger.ts'
import { createRedactor } from './redact.ts'

describe('redactor: entradas hostiles', () => {
  it('sobrevive a objetos circulares, muy profundos y con __proto__', () => {
    const r = createRedactor()
    const loop: Record<string, unknown> = { a: 1 }
    loop.self = loop
    expect(() => r.redactValue(loop)).not.toThrow()
    let deep: Record<string, unknown> = { leaf: 'sk-abcdefghijkl' }
    for (let i = 0; i < 5000; i++) deep = { deep }
    expect(() => r.redactValue(deep)).not.toThrow()
    const proto = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as unknown
    const out = r.redactValue(proto) as Record<string, unknown>
    expect(Object.hasOwn(out, '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('no explota con cadenas enormes ni con patrones patológicos', () => {
    const r = createRedactor()
    const start = Date.now()
    const out = r.redactString(`${'sk-'.repeat(200000)}${'?t='.repeat(50000)}`)
    expect(out.length).toBeLessThan(10000)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('un secreto con metacaracteres de regex se tacha literalmente', () => {
    const r = createRedactor()
    r.addSecret('.*(a+)+$[x]\\1')
    expect(r.redactString('antes .*(a+)+$[x]\\1 despues')).toBe('antes [REDACTED] despues')
    expect(r.redactString('aaaa')).toBe('aaaa')
  })

  it('el token del daemon nunca sale por el logger, ni en mensaje, campos, errores o URL', () => {
    const redactor = createRedactor()
    const token = 'tok_ABCdef123-_456789xyzQWERTY'
    redactor.addSecret(token)
    const lines: string[] = []
    const log = new JsonLogger({ redactor, level: 'debug', sink: (l) => lines.push(l) })
    log.info(`conectó con ${token}`)
    log.warn('auth', {
      token,
      headers: { authorization: `Bearer ${token}` },
      url: `/ws?t=${token}`,
    })
    log.error('boom', { error: new Error(`fallo ${token}`), proto: `nexo.v1, nexo.token.${token}` })
    log.debug('x', { nested: [{ k: `a${token}b` }] })
    expect(lines).toHaveLength(4)
    for (const l of lines) expect(l).not.toContain(token)
  })

  it('un campo no puede suplantar time, level ni msg', () => {
    const lines: string[] = []
    const log = new JsonLogger({ redactor: createRedactor(), sink: (l) => lines.push(l) })
    log.info('real', { level: 'fake', msg: 'fake', time: 'fake' })
    const rec = JSON.parse(lines[0] as string) as Record<string, string>
    expect(rec.msg).toBe('real')
    expect(rec.level).toBe('info')
  })

  it('el logger respeta el nivel y no lanza si el sink falla', () => {
    const lines: string[] = []
    const log = new JsonLogger({
      redactor: createRedactor(),
      level: 'warn',
      sink: (l) => lines.push(l),
    })
    log.info('no')
    log.error('sí')
    expect(lines).toHaveLength(1)
    const bad = new JsonLogger({
      redactor: createRedactor(),
      sink: () => {
        throw new Error('disco lleno')
      },
    })
    expect(() => bad.info('x')).not.toThrow()
  })
})
