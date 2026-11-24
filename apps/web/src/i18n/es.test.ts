import { describe, expect, it } from 'vitest'
import { es } from './es.ts'

describe('i18n/es', () => {
  it('define el nombre de la app', () => {
    expect(es.appName).toBe('Atalaya')
  })
})
