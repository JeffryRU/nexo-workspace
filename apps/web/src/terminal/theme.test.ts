import { describe, expect, it } from 'vitest'
import { withSymbolsFallback } from './theme.ts'

describe('withSymbolsFallback', () => {
  it('inserta las fuentes de símbolos antes de monospace', () => {
    expect(withSymbolsFallback('"Cascadia Code", Consolas, monospace')).toBe(
      '"Cascadia Code", Consolas, "Symbols Nerd Font Mono", "Symbols Nerd Font", monospace',
    )
  })

  it('las agrega al final si no hay genérica y es idempotente', () => {
    const once = withSymbolsFallback('Hack')
    expect(once).toBe('Hack, "Symbols Nerd Font Mono", "Symbols Nerd Font"')
    expect(withSymbolsFallback(once)).toBe(once)
  })

  it('no duplica una fuente que ya está (con otras comillas o mayúsculas)', () => {
    expect(withSymbolsFallback("'symbols nerd font mono', monospace")).toBe(
      '\'symbols nerd font mono\', "Symbols Nerd Font", monospace',
    )
  })

  it('entradas vacías o con comas sueltas no rompen la lista', () => {
    expect(withSymbolsFallback('')).toBe('"Symbols Nerd Font Mono", "Symbols Nerd Font"')
    expect(withSymbolsFallback(', ,monospace,')).toBe(
      '"Symbols Nerd Font Mono", "Symbols Nerd Font", monospace',
    )
  })
})
