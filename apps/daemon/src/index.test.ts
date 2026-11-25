import { describe, expect, it } from 'vitest'
import { DAEMON_VERSION, describeDaemon } from './index.ts'

describe('daemon', () => {
  it('describe el esqueleto', () => {
    const info = describeDaemon()
    expect(info.name).toBe('nexo-daemon')
    expect(info.version).toBe(DAEMON_VERSION)
  })
})
