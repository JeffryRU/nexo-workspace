import { describe, expect, it } from 'vitest'
import { parseAnsi, stripAnsi, tailLines } from './ansi.ts'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

describe('ANSI hostil', () => {
  it('un OSC sin terminador no se come lo que sigue', () => {
    const out = stripAnsi(`antes${ESC}]0;titulo sin cerrar y mucho texto después`)
    expect(out).toContain('antes')
    expect(out).toContain('mucho texto después')
    expect(out).not.toContain(ESC)
  })

  it('un OSC gigante (1 MiB) se descarta sin colgarse', () => {
    const big = `${ESC}]8;;${'a'.repeat(1_000_000)}${BEL}fin`
    const t = performance.now()
    const out = stripAnsi(big)
    expect(performance.now() - t).toBeLessThan(2000)
    expect(out).not.toContain(ESC)
    expect(out).not.toContain(BEL)
  })

  it('cien mil secuencias CSI seguidas se procesan en tiempo lineal', () => {
    const t = performance.now()
    const out = stripAnsi(`${`${ESC}[31m`.repeat(100_000)}x`)
    expect(out).toBe('x')
    expect(performance.now() - t).toBeLessThan(2000)
  })

  it('parámetros SGR absurdos no producen colores ni estilos fuera de lista', () => {
    const spans = parseAnsi(
      `${ESC}[38;5;99999;48;2;300;300;300;999999999999mA${ESC}[;;;;;mB${ESC}[1;mC`,
    )
    expect(spans.map((s) => s.text).join('')).toBe('ABC')
    for (const s of spans) {
      expect(s.fg === undefined || (s.fg >= 0 && s.fg <= 15)).toBe(true)
    }
  })

  it('intentos de inyectar HTML o estilos en la salida quedan como texto', () => {
    const payload = `<img src=x onerror=alert(1)>${ESC}[31m<script>alert(1)</script>${ESC}[0m`
    const spans = parseAnsi(payload)
    expect(spans.map((s) => s.text).join('')).toBe(
      '<img src=x onerror=alert(1)><script>alert(1)</script>',
    )
    expect(Object.keys(spans[1] ?? {}).sort()).toEqual(['fg', 'text'])
  })

  it('secuencias partidas y escapes sueltos al final no lanzan', () => {
    for (const s of [
      ESC,
      `${ESC}[`,
      `${ESC}[3`,
      `${ESC}]`,
      `${ESC}P`,
      `${ESC}[31`,
      '\u009b',
      '\u009d',
    ]) {
      expect(() => stripAnsi(`x${s}`)).not.toThrow()
      expect(stripAnsi(`x${s}`)).not.toContain(ESC)
    }
  })

  it('una salida enorme: tailLines acota las líneas que se pintan', () => {
    const lines = Array.from({ length: 200_000 }, (_, i) => `l${i}`).join('\n')
    const t = performance.now()
    const tail = tailLines(lines, 1500)
    expect(tail.text.split('\n')).toHaveLength(1500)
    expect(tail.hidden).toBe(198_500)
    expect(performance.now() - t).toBeLessThan(1000)
  })
})
