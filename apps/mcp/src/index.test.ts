import { describe, expect, it } from 'vitest'
import { listTools } from './index.ts'

describe('mcp', () => {
  it('no expone herramientas todavia', () => {
    expect(listTools()).toEqual([])
  })
})
