import { METHOD_NAMES } from '@atalaya/contracts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { type AtalayaClient, CLIENT_PROTOCOL_VERSION } from './index.ts'

describe('client', () => {
  it('declara la version del protocolo y un metodo por entrada del registro', () => {
    expect(CLIENT_PROTOCOL_VERSION).toBe(1)
    expectTypeOf<keyof AtalayaClient>().toEqualTypeOf<(typeof METHOD_NAMES)[number]>()
  })
})
