import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ConfigError, DEFAULTS, loadConfig } from './config.ts'
import { SlidingWindowLimiter } from './limiter.ts'

describe('loadConfig', () => {
  it('por omisión no hay escritura y los topes son los de DEFAULTS', () => {
    expect(loadConfig({})).toEqual({ write: false, allowPermissions: false, ...DEFAULTS })
  })

  it('acepta 1/true y 0/false/vacío', () => {
    expect(loadConfig({ NEXO_MCP_WRITE: '1' }).write).toBe(true)
    expect(loadConfig({ NEXO_MCP_WRITE: 'true' }).write).toBe(true)
    expect(loadConfig({ NEXO_MCP_WRITE: '0' }).write).toBe(false)
    expect(loadConfig({ NEXO_MCP_WRITE: 'false' }).write).toBe(false)
    expect(loadConfig({ NEXO_MCP_WRITE: '' }).write).toBe(false)
  })

  it('los permisos exigen la escritura', () => {
    expect(() => loadConfig({ NEXO_MCP_ALLOW_PERMISSIONS: '1' })).toThrow(/exige NEXO_MCP_WRITE/)
    const c = loadConfig({ NEXO_MCP_WRITE: '1', NEXO_MCP_ALLOW_PERMISSIONS: '1' })
    expect(c.allowPermissions).toBe(true)
  })

  it('lee los topes numéricos', () => {
    const c = loadConfig({
      NEXO_MCP_MAX_WRITE_BYTES: '100',
      NEXO_MCP_WRITE_RATE: '5',
      NEXO_MCP_READ_RATE: '50',
      NEXO_MCP_MAX_OUTPUT_BYTES: '2048',
    })
    expect(c).toMatchObject({
      maxWriteBytes: 100,
      writePerMinute: 5,
      readPerMinute: 50,
      maxOutputBytes: 2048,
    })
  })

  it('ignora variables ajenas', () => {
    expect(loadConfig({ PATH: '/bin', NEXO_PORT: '1' }).write).toBe(false)
  })
})

describe('loadConfig (hostil)', () => {
  it.each([
    ['NEXO_MCP_WRITE', 'yes'],
    ['NEXO_MCP_WRITE', '2'],
    ['NEXO_MCP_WRITE', ' 1'],
    ['NEXO_MCP_MAX_WRITE_BYTES', '0'],
    ['NEXO_MCP_MAX_WRITE_BYTES', '999999999'],
    ['NEXO_MCP_MAX_WRITE_BYTES', '-5'],
    ['NEXO_MCP_MAX_WRITE_BYTES', '1e3'],
    ['NEXO_MCP_MAX_WRITE_BYTES', '12abc'],
    ['NEXO_MCP_WRITE_RATE', ''],
    ['NEXO_MCP_READ_RATE', '99999999999999999999'],
    ['NEXO_MCP_MAX_OUTPUT_BYTES', '10'],
  ])('%s=%j aborta con un mensaje claro', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(ConfigError)
    expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(name))
  })

  it('cualquier cadena rara o se acepta con valores en rango o lanza ConfigError', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (value) => {
        try {
          const c = loadConfig({ NEXO_MCP_MAX_WRITE_BYTES: value, NEXO_MCP_WRITE_RATE: value })
          expect(c.maxWriteBytes).toBeGreaterThanOrEqual(1)
          expect(c.writePerMinute).toBeLessThanOrEqual(600)
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError)
        }
      }),
      { numRuns: 300 },
    )
  })
})

describe('SlidingWindowLimiter', () => {
  it('deja pasar max usos por ventana y dice cuándo reintentar', () => {
    let now = 1000
    const l = new SlidingWindowLimiter(3, 1000, () => now)
    expect(l.take().ok).toBe(true)
    now += 100
    expect(l.take().ok).toBe(true)
    expect(l.take().ok).toBe(true)
    const denied = l.take()
    expect(denied).toEqual({ ok: false, retryAfterMs: 900 })
    now += 900
    expect(l.take().ok).toBe(true)
    expect(l.take().ok).toBe(false)
  })

  it('propiedad: en cualquier ventana nunca concede más de max', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.integer({ min: 0, max: 400 }), { maxLength: 80 }),
        (max, gaps) => {
          let now = 0
          const l = new SlidingWindowLimiter(max, 1000, () => now)
          const granted: number[] = []
          for (const gap of gaps) {
            now += gap
            if (l.take().ok) granted.push(now)
          }
          for (let i = 0; i < granted.length; i++) {
            const inWindow = granted.filter(
              (t) => t >= (granted[i] as number) && t < (granted[i] as number) + 1000,
            )
            expect(inWindow.length).toBeLessThanOrEqual(max)
          }
        },
      ),
      { numRuns: 200 },
    )
  })
})
