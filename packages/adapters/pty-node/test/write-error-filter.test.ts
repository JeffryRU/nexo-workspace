import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireWriteErrorFilter } from '../src/write-error-filter.ts'

const ebadf = Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' })
const eio = Object.assign(new Error('EIO'), { code: 'EIO' })

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('acquireWriteErrorFilter', () => {
  it('descarta solo el aviso EBADF de node-pty y deja pasar el resto', () => {
    vi.useFakeTimers()
    const base = vi.spyOn(console, 'error').mockImplementation(() => {})
    const release = acquireWriteErrorFilter()
    console.error('Unhandled pty write error', ebadf)
    console.error('Unhandled pty write error', eio)
    console.error('otro mensaje', ebadf)
    console.error('Unhandled pty write error')
    expect(base.mock.calls).toEqual([
      ['Unhandled pty write error', eio],
      ['otro mensaje', ebadf],
      ['Unhandled pty write error'],
    ])
    release()
    vi.advanceTimersByTime(1000)
    expect(console.error).toBe(base)
  })

  it('con dos usuarios simultáneos restaura console.error al soltar el último', () => {
    vi.useFakeTimers()
    const base = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = acquireWriteErrorFilter()
    const b = acquireWriteErrorFilter()
    a()
    a()
    vi.advanceTimersByTime(1000)
    console.error('Unhandled pty write error', ebadf)
    expect(base).not.toHaveBeenCalled()
    b()
    vi.advanceTimersByTime(1000)
    expect(console.error).toBe(base)
  })
})
