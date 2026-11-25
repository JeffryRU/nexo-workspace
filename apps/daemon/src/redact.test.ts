import { describe, expect, it } from 'vitest'
import { createRedactor } from './redact.ts'

describe('redactor de secretos', () => {
  const r = createRedactor()

  it('tacha claves tipo sk-', () => {
    expect(r.redactString('usando sk-ant-api03-abcdefgh12345678 ahora')).toBe(
      'usando [REDACTED] ahora',
    )
    expect(r.redactString('sk-proj_ABCDEFGH1234')).toBe('[REDACTED]')
  })

  it('tacha Authorization y Bearer', () => {
    expect(r.redactString('Authorization: Bearer abc.def.ghi123')).toBe('Authorization: [REDACTED]')
    expect(r.redactString('hola Bearer abcdefgh12345')).toBe('hola Bearer [REDACTED]')
    expect(r.redactString('{"authorization":"Basic dXNlcjpwYXNz"}')).toContain('[REDACTED]')
    expect(r.redactString('{"authorization":"Basic dXNlcjpwYXNz"}')).not.toContain('dXNlcjpwYXNz')
  })

  it('tacha ?t= y token= en URLs', () => {
    expect(r.redactString('GET /ws?t=SECRETO123&x=1')).toBe('GET /ws?t=[REDACTED]&x=1')
    expect(r.redactString('http://h/?a=1&token=SECRETO123')).toBe('http://h/?a=1&token=[REDACTED]')
  })

  it('tacha el subprotocolo con token', () => {
    expect(r.redactString('Sec-WebSocket-Protocol: nexo.v1, nexo.token.AbC-_123xyz')).toBe(
      'Sec-WebSocket-Protocol: nexo.v1, nexo.token.[REDACTED]',
    )
  })

  it('tacha secretos literales registrados y su forma codificada', () => {
    const own = createRedactor()
    own.addSecret('un/secreto+largo=')
    expect(own.redactString('x un/secreto+largo= y')).toBe('x [REDACTED] y')
    expect(own.redactString(`x ${encodeURIComponent('un/secreto+largo=')} y`)).toBe(
      'x [REDACTED] y',
    )
  })

  it('tacha campos sensibles por nombre, anidados y dentro de errores', () => {
    const out = r.redactValue({
      user: 'ana',
      token: 'abc',
      nested: { Authorization: 'x', list: [{ apiKey: 'k' }, 'sk-abcdefghijk'] },
      err: new Error('falló con sk-abcdefghijk'),
    }) as Record<string, unknown>
    const text = JSON.stringify(out)
    expect(out.user).toBe('ana')
    expect(text).not.toContain('abcdefghijk')
    expect(text).not.toContain('"abc"')
    expect(text).toContain('[REDACTED]')
  })

  it('no toca texto normal', () => {
    expect(r.redactString('terminal creada en el espacio')).toBe('terminal creada en el espacio')
  })
})
