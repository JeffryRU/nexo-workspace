import { describe, expect, it } from 'vitest'
import { es, format } from './es.ts'

describe('i18n/es', () => {
  it('define el nombre de la app', () => {
    expect(es.appName).toBe('Nexo Workspace')
  })

  it('format sustituye marcadores y deja los desconocidos', () => {
    expect(format('código {code} {otro}', { code: 3 })).toBe('código 3 {otro}')
  })

  it('format no interpreta HTML', () => {
    expect(format('{x}', { x: '<img onerror=1>' })).toBe('<img onerror=1>')
  })
})
