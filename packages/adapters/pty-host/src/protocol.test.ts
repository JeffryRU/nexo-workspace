import { describe, expect, it } from 'vitest'
import { MAX_DATA_CHARS, MAX_WRITE_CHARS, parseHostEvent, parseHostRequest } from './protocol.ts'

const spawn = {
  t: 'spawn',
  id: 1,
  file: '/bin/sh',
  args: ['-c', 'true'],
  cwd: '/',
  env: { A: 'b' },
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  conptyDll: false,
}

describe('protocolo IPC del pty host: peticiones', () => {
  it('acepta cada tipo de petición válida', () => {
    for (const msg of [
      spawn,
      { t: 'write', id: 1, data: 'hola' },
      { t: 'resize', id: 1, cols: 10, rows: 10 },
      { t: 'kill', id: 1 },
      { t: 'kill', id: 1, signal: 'SIGKILL' },
    ]) {
      expect(parseHostRequest(msg).ok).toBe(true)
    }
  })

  it('rechaza ids, tamaños, señales y claves sobrantes inválidos', () => {
    for (const msg of [
      null,
      'spawn',
      { t: 'spawn' },
      { ...spawn, id: 0 },
      { ...spawn, id: 1.5 },
      { ...spawn, id: 2 ** 31 },
      { ...spawn, cols: 0 },
      { ...spawn, rows: 1001 },
      { ...spawn, file: '' },
      { ...spawn, file: 'a\u0000b' },
      { ...spawn, args: [1] },
      { ...spawn, env: { A: 1 } },
      { ...spawn, extra: true },
      { t: 'write', id: 1, data: 'x'.repeat(MAX_WRITE_CHARS + 1) },
      { t: 'resize', id: 1, cols: 0, rows: 10 },
      { t: 'kill', id: 1, signal: 'SIGUSR1' },
      { t: 'otro', id: 1 },
    ]) {
      expect(parseHostRequest(msg).ok, JSON.stringify(msg)?.slice(0, 80)).toBe(false)
    }
  })
})

describe('protocolo IPC del pty host: eventos', () => {
  it('acepta eventos válidos', () => {
    for (const msg of [
      { t: 'ready' },
      { t: 'spawned', id: 1, pid: 10 },
      { t: 'spawn-error', id: 1, message: 'no' },
      { t: 'data', id: 1, data: 'x' },
      { t: 'exit', id: 1, exitCode: 0, signal: null },
      { t: 'exit', id: 1, exitCode: 0, signal: 15 },
      { t: 'exit', id: 1, exitCode: null, signal: null },
    ]) {
      expect(parseHostEvent(msg).ok).toBe(true)
    }
  })

  it('rechaza eventos malformados o demasiado grandes', () => {
    for (const msg of [
      undefined,
      [],
      { t: 'spawned', id: 1, pid: 0 },
      { t: 'data', id: 1, data: 'x'.repeat(MAX_DATA_CHARS + 1) },
      { t: 'data', id: -1, data: 'x' },
      { t: 'exit', id: 1, exitCode: 'x', signal: null },
      { t: 'exit', id: 1, exitCode: 0 },
      { t: 'ready', extra: 1 },
    ]) {
      expect(parseHostEvent(msg).ok).toBe(false)
    }
  })

  it('el mensaje de error nombra el campo', () => {
    const r = parseHostEvent({ t: 'data', id: 'a', data: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('id')
  })
})
