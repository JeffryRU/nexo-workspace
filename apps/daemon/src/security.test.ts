import { describe, expect, it } from 'vitest'
import { generateToken, parseSubprotocols, tokensEqual } from './auth.ts'
import { parseEnv } from './config.ts'
import { isHostAllowed, isOriginAllowed } from './origin.ts'
import { RateLimiter } from './rate-limiter.ts'

describe('token', () => {
  it('son 32 bytes en base64url y distintos cada vez', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
  })

  it('tokensEqual acepta solo el idéntico', () => {
    const t = generateToken()
    expect(tokensEqual(t, t)).toBe(true)
    expect(tokensEqual(t, `${t}x`)).toBe(false)
    expect(tokensEqual(t, t.slice(0, -1))).toBe(false)
    expect(tokensEqual(t, '')).toBe(false)
    expect(tokensEqual(t, undefined)).toBe(false)
    expect(tokensEqual(t, 42)).toBe(false)
    expect(
      tokensEqual(
        t,
        t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
      ),
    ).toBe(false)
  })

  it('tokensEqual no se confunde con unicode ni con tokens larguísimos', () => {
    const t = generateToken()
    expect(tokensEqual(t, 'ñ'.repeat(t.length))).toBe(false)
    expect(tokensEqual(t, '\u0000'.repeat(t.length))).toBe(false)
    expect(tokensEqual(t, t.repeat(10000))).toBe(false)
  })
})

describe('subprotocolos', () => {
  it('lee versión y token', () => {
    expect(parseSubprotocols('nexo.v1, nexo.token.abc')).toEqual({
      versionOffered: true,
      token: 'abc',
      tokenCount: 1,
    })
    expect(parseSubprotocols(undefined)).toEqual({
      versionOffered: false,
      token: undefined,
      tokenCount: 0,
    })
    expect(parseSubprotocols(['nexo.v1', 'nexo.token.a, nexo.token.b']).tokenCount).toBe(2)
    expect(parseSubprotocols('nexo.v1,,  ,').token).toBeUndefined()
  })
})

describe('Origin', () => {
  it('permite Tauri y la ausencia de Origin', () => {
    for (const o of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']) {
      expect(isOriginAllowed(o, false)).toBe(true)
    }
    expect(isOriginAllowed(undefined, false)).toBe(true)
  })

  it('Vite solo con dev', () => {
    expect(isOriginAllowed('http://localhost:5173', false)).toBe(false)
    expect(isOriginAllowed('http://localhost:5173', true)).toBe(true)
    expect(isOriginAllowed('http://127.0.0.1:5173', true)).toBe(true)
    expect(isOriginAllowed('http://localhost:5174', true)).toBe(false)
  })

  it('rechaza lo demás, incluido null y variantes', () => {
    for (const o of [
      'null',
      '',
      'http://evil.example',
      'https://localhost:5173',
      'tauri://localhost.evil.com',
      'TAURI://LOCALHOST',
      'http://tauri.localhost/',
      'http://localhost',
    ]) {
      expect(isOriginAllowed(o, true), o).toBe(false)
    }
    expect(isOriginAllowed(['tauri://localhost'], true)).toBe(false)
  })

  it('Host debe ser el loopback del puerto', () => {
    expect(isHostAllowed('127.0.0.1:4317', 4317)).toBe(true)
    expect(isHostAllowed('localhost:4317', 4317)).toBe(true)
    expect(isHostAllowed('evil.com:4317', 4317)).toBe(false)
    expect(isHostAllowed('127.0.0.1:1', 4317)).toBe(false)
    expect(isHostAllowed(undefined, 4317)).toBe(false)
  })
})

describe('RateLimiter', () => {
  it('limita y luego marca abuso, y se reinicia con la ventana', () => {
    let now = 0
    const rl = new RateLimiter(3, 1000, () => now)
    expect([1, 2, 3].map(() => rl.take())).toEqual(['ok', 'ok', 'ok'])
    expect(rl.take()).toBe('limited')
    for (let i = 0; i < 8; i++) rl.take()
    expect(rl.take()).toBe('abuse')
    now = 1000
    expect(rl.take()).toBe('ok')
  })
})

describe('entorno', () => {
  it('valores por omisión', () => {
    expect(parseEnv({})).toMatchObject({ port: 4317, dev: false, maxConnections: 128 })
  })

  it('NEXO_PTY_MODE: host, direct o sin valor', () => {
    expect(parseEnv({}).ptyMode).toBeUndefined()
    expect(parseEnv({ NEXO_PTY_MODE: '' }).ptyMode).toBeUndefined()
    expect(parseEnv({ NEXO_PTY_MODE: 'host' }).ptyMode).toBe('host')
    expect(parseEnv({ NEXO_PTY_MODE: 'direct' }).ptyMode).toBe('direct')
  })

  it('lee y valida', () => {
    expect(parseEnv({ NEXO_PORT: '0', NEXO_DEV: '1', NEXO_STATE_DIR: '/x' })).toMatchObject({
      port: 0,
      dev: true,
      stateDir: '/x',
    })
  })

  it('rechaza valores inválidos con mensaje claro', () => {
    for (const env of [
      { NEXO_PORT: 'abc' },
      { NEXO_PORT: '70000' },
      { NEXO_PORT: '-1' },
      { NEXO_PORT: '1.5' },
      { NEXO_DEV: 'sí' },
      { NEXO_LOG_LEVEL: 'ruidoso' },
      { NEXO_MAX_CONNECTIONS: '0' },
      { NEXO_PTY_MODE: 'otro' },
    ]) {
      expect(() => parseEnv(env), JSON.stringify(env)).toThrow(/variable de entorno inválida/)
    }
  })
})
