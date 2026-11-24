import { describe, expect, it } from 'vitest'
import { HELP, main } from './index.ts'

describe('cli', () => {
  it('muestra la ayuda sin argumentos', () => {
    expect(main([])).toEqual({ code: 0, output: HELP })
  })
  it('rechaza comandos desconocidos', () => {
    expect(main(['xyz']).code).toBe(2)
  })
})
