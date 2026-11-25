import { describe, expect, it } from 'vitest'
import { CLIENT_PROTOCOL_VERSION, NexoClient } from './index.ts'

describe('client', () => {
  it('declara la version del protocolo y exporta el cliente', () => {
    expect(CLIENT_PROTOCOL_VERSION).toBe(1)
    expect(typeof NexoClient).toBe('function')
  })
})
