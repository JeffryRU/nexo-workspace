import { LIMITS, utf8ByteLength } from '@nexo/contracts'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { describeApiError, looksLikeAuthFailure } from '../src/errors.ts'
import { createSecretRedactor, redactEnv } from '../src/redact.ts'
import { body, line, splitDelta, TextCarry } from '../src/text.ts'
import { describeTool, editPatch, inferKind, parseExitCode } from '../src/tools.ts'

describe('text', () => {
  it('line colapsa control y espacios y recorta sin partir un par', () => {
    expect(line('  a\n\tb   c\u0000d ', 50)).toBe('a b c�d')
    expect(line('😀😀😀', 3)).toBe('😀')
    expect(line('', 5, 'x')).toBe('x')
    expect(line('\n\n', 5, 'x')).toBe('x')
  })

  it('body limpia y recorta por bytes', () => {
    expect(body('a\u0000b', 100)).toEqual({ text: 'a�b', truncated: false })
    const r = body('é'.repeat(100), 11)
    expect(r.truncated).toBe(true)
    expect(utf8ByteLength(r.text)).toBeLessThanOrEqual(11)
  })

  it('splitDelta: los trozos respetan el tope y se concatenan al original', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', maxLength: 200 }),
        fc.integer({ min: 4, max: 40 }),
        (text, max) => {
          const chunks = splitDelta(text, max)
          expect(chunks.join('')).toBe(text)
          for (const c of chunks) expect(utf8ByteLength(c)).toBeLessThanOrEqual(max)
        },
      ),
    )
    expect(splitDelta('')).toEqual([])
    expect(splitDelta('hola')).toEqual(['hola'])
  })

  it('TextCarry: cualquier partición equivale al texto completo', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 60 }),
        fc.array(fc.nat(60), { maxLength: 8 }),
        (text, cuts) => {
          const carry = new TextCarry()
          const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b)
          let out = ''
          let last = 0
          for (const p of [...points, text.length]) {
            out += carry.push(text.slice(last, p))
            last = p
          }
          out += carry.flush()
          const whole = new TextCarry()
          const expected = whole.push(text) + whole.flush()
          expect(out).toBe(expected)
        },
      ),
    )
  })
})

describe('tools', () => {
  it('inferKind: las conocidas y todo lo demás como other', () => {
    expect(
      [
        'Read',
        'Edit',
        'Write',
        'MultiEdit',
        'Bash',
        'Grep',
        'Glob',
        'WebFetch',
        'mcp__a__b',
        'toString',
      ].map(inferKind),
    ).toEqual([
      'read',
      'edit',
      'edit',
      'edit',
      'exec',
      'search',
      'search',
      'other',
      'other',
      'other',
    ])
  })

  it('describeTool: títulos, rutas y diffs', () => {
    expect(describeTool('Read', { file_path: '/a/b.ts' })).toMatchObject({
      title: 'Leer /a/b.ts',
      path: '/a/b.ts',
    })
    expect(describeTool('Write', { file_path: '/n.md', content: 'x\ny' }).diff?.patch).toContain(
      '+y',
    )
    const multi = describeTool('MultiEdit', {
      file_path: '/m.ts',
      edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }, 7],
    })
    expect(multi.diff?.patch.match(/^@@/gm)).toHaveLength(2)
    expect(describeTool('Edit', { old_string: 'a' }).diff).toBeUndefined()
    expect(describeTool('Bash', { command: 'ls -la' }).title).toBe('ls -la')
    expect(describeTool('Bash', {}).title).toBe('Ejecutar un comando')
    expect(describeTool('Grep', { pattern: 'foo' }).title).toBe('Buscar foo')
    expect(describeTool('Glob', { pattern: '*.ts' }).title).toBe('Buscar archivos *.ts')
    expect(describeTool('mcp__x__y', 'texto').title).toBe('mcp__x__y')
    expect(describeTool('Read', null).title).toBe('Leer archivo')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(describeTool('Bash', circular).input).toBeUndefined()
    expect(
      describeTool('Bash', { command: 'x'.repeat(100_000) }).input?.length,
    ).toBeLessThanOrEqual(LIMITS.maxBlockInputBytes)
  })

  it('editPatch y parseExitCode', () => {
    expect(editPatch('/a', [{ old: '', next: 'n' }])).toBe('--- a//a\n+++ b//a\n@@ 1 -> 1 @@\n+n')
    expect(parseExitCode('Exit code 127\nno')).toBe(127)
    expect(parseExitCode('nada')).toBeUndefined()
    expect(parseExitCode('Exit code 123456')).toBeUndefined()
  })
})

describe('errors', () => {
  it('detecta fallos de credenciales por texto', () => {
    expect(looksLikeAuthFailure('Invalid API key · Please run /login')).toBe(true)
    expect(looksLikeAuthFailure('OAuth token has expired')).toBe(true)
    expect(looksLikeAuthFailure('Not logged in')).toBe(true)
    expect(looksLikeAuthFailure('todo bien')).toBe(false)
  })

  it('cada código de la API da un error legible; los de reintento lo marcan', () => {
    const codes = [
      'authentication_failed',
      'oauth_org_not_allowed',
      'cloud_credential_error',
      'billing_error',
      'account_on_hold',
      'verification_required',
      'rate_limit',
      'overloaded',
      'server_error',
      'invalid_request',
      'model_not_found',
      'max_output_tokens',
      'unknown',
      'algo\u0000nuevo',
    ]
    for (const c of codes) {
      const e = describeApiError(c)
      expect(e.message.length).toBeGreaterThan(10)
      expect(e.message).not.toContain('\u0000')
    }
    expect(describeApiError('rate_limit').retryable).toBe(true)
    expect(describeApiError('authentication_failed')).toMatchObject({
      code: 'AUTH_REQUIRED',
      fatal: true,
    })
  })
})

describe('redact', () => {
  const KEY = 'sk-ant-api03-abcdefghij1234567890'
  const OTHER = 'valor-secreto-largo-1'

  it('tacha valores literales de variables sensibles y patrones conocidos', () => {
    const r = createSecretRedactor({
      ANTHROPIC_API_KEY: KEY,
      CLAUDE_CODE_OAUTH_TOKEN: OTHER,
      PATH: '/usr/bin',
      CORTO: 'x',
      VACIA: undefined,
    })
    const out = r.redact(
      `k=${KEY} t=${OTHER} ruta=/usr/bin Authorization: Bearer abcdefgh12345 sk-proj-abcdefgh12 ghp_${'a'.repeat(30)} token=zzz`,
    )
    expect(out).not.toContain(KEY)
    expect(out).not.toContain(OTHER)
    expect(out).not.toContain('abcdefgh12345')
    expect(out).not.toContain('sk-proj')
    expect(out).not.toContain('ghp_')
    expect(out).not.toContain('zzz')
    expect(out).toContain('/usr/bin')
    expect(r.scrub(`a ${KEY} b`)).toBe('a [REDACTED] b')
    expect(r.scrub('sk-proj-abcdefgh12')).toBe('sk-proj-abcdefgh12')
  })

  it('acota textos enormes y redactEnv enmascara lo sensible', () => {
    const r = createSecretRedactor({})
    expect(r.redact('x'.repeat(100_000)).length).toBeLessThan(9000)
    const env = redactEnv({
      ANTHROPIC_API_KEY: KEY,
      CLAUDE_CODE_OAUTH_TOKEN: OTHER,
      HOME: '/home/u',
      MY_PASSWORD: 'p',
      VACIA: undefined,
    })
    expect(env).toEqual({
      ANTHROPIC_API_KEY: '[REDACTED]',
      CLAUDE_CODE_OAUTH_TOKEN: '[REDACTED]',
      HOME: '/home/u',
      MY_PASSWORD: '[REDACTED]',
    })
    expect(JSON.stringify(env)).not.toContain(KEY)
  })

  it('un secreto con caracteres de regex no rompe el redactor', () => {
    const secret = 'a.b*c+d?e(f)g[h]i{j}k|l^m$n\\o'
    const r = createSecretRedactor({ MI_TOKEN: secret })
    expect(r.scrub(`antes ${secret} después`)).toBe('antes [REDACTED] después')
  })
})
