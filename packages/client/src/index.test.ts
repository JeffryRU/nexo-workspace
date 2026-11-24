import type { METHOD_NAMES } from '@nexo/contracts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { CLIENT_PROTOCOL_VERSION, type NexoClient } from './index.ts'

describe('client', () => {
  it('declara la version del protocolo y un metodo por entrada del registro', () => {
    expect(CLIENT_PROTOCOL_VERSION).toBe(1)
    expectTypeOf<keyof NexoClient>().toEqualTypeOf<(typeof METHOD_NAMES)[number]>()
  })
})
