import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireLock,
  defaultStateDir,
  ensureStateDir,
  isPidAlive,
  readDaemonFile,
  removeDiscovery,
  statePaths,
  writeAtomic,
  writeDiscovery,
} from './state-dir.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexo-state-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const info = { version: '0.0.0', port: 4317, pid: process.pid, startedAt: '2026-01-01T00:00:00Z' }

describe('directorio de estado', () => {
  it('Linux usa XDG_STATE_HOME o ~/.local/state; Windows LOCALAPPDATA', () => {
    expect(defaultStateDir({ XDG_STATE_HOME: '/s' }, 'linux', '/h')).toBe(join('/s', 'nexo'))
    expect(defaultStateDir({}, 'linux', '/h')).toBe(join('/h', '.local', 'state', 'nexo'))
    expect(defaultStateDir({ XDG_STATE_HOME: 'relativo' }, 'linux', '/h')).toBe(
      join('/h', '.local', 'state', 'nexo'),
    )
    expect(defaultStateDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\h')).toBe(join('C:\\L', 'Nexo'))
    expect(defaultStateDir({}, 'win32', 'C:\\h')).toBe(join('C:\\h', 'AppData', 'Local', 'Nexo'))
  })

  it('crea el directorio con permisos 700 en Linux', async () => {
    const target = join(dir, 'a', 'b')
    await ensureStateDir(target)
    expect((await stat(target)).isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o700)
  })

  it('escribe de forma atómica sin dejar temporales y reemplaza', async () => {
    const p = join(dir, 'f')
    await writeAtomic(p, 'uno')
    await writeAtomic(p, 'dos')
    expect(await readFile(p, 'utf8')).toBe('dos')
    expect(await readdir(dir)).toEqual(['f'])
  })

  it('daemon.json y token se escriben y se leen', async () => {
    const paths = statePaths(dir)
    await writeDiscovery(paths, 'tok', info)
    expect(await readFile(paths.token, 'utf8')).toBe('tok')
    expect(await readDaemonFile(paths)).toEqual(info)
    if (process.platform !== 'win32') expect((await stat(paths.token)).mode & 0o777).toBe(0o600)
  })

  it('un daemon.json corrupto, vacío o con forma errónea se trata como ausente', async () => {
    const paths = statePaths(dir)
    for (const body of [
      '',
      '{',
      'null',
      '[]',
      '{"port":"x"}',
      '{"version":"1","port":1,"pid":1,"startedAt":"x","extra":1}',
      '\u0000\u0000',
    ]) {
      await writeFile(paths.daemon, body)
      expect(await readDaemonFile(paths), body).toBeUndefined()
    }
    await rm(paths.daemon)
    expect(await readDaemonFile(paths)).toBeUndefined()
  })

  it('removeDiscovery borra los archivos propios pero no los de otro pid', async () => {
    const paths = statePaths(dir)
    await writeDiscovery(paths, 'tok', { ...info, pid: 999999 })
    await removeDiscovery(paths, process.pid)
    expect(await readDaemonFile(paths)).toBeDefined()
    await removeDiscovery(paths, 999999)
    expect(await readDaemonFile(paths)).toBeUndefined()
    await expect(stat(paths.token)).rejects.toThrow()
  })
})

describe('isPidAlive', () => {
  it('distingue vivos y muertos', () => {
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-5)).toBe(false)
    expect(isPidAlive(1.5)).toBe(false)
    expect(isPidAlive(2 ** 31 - 2)).toBe(false)
  })
})

describe('cerrojo', () => {
  it('solo uno lo toma mientras el dueño viva y se libera', async () => {
    const paths = statePaths(dir)
    const alive = async () => true
    const a = await acquireLock(paths, alive)
    expect(a.acquired).toBe(true)
    const b = await acquireLock(paths, alive)
    expect(b).toMatchObject({ acquired: false, holderPid: process.pid })
    if (a.acquired) await a.release()
    expect((await acquireLock(paths, alive)).acquired).toBe(true)
  })

  it('reemplaza un cerrojo de un dueño muerto, vacío o ilegible', async () => {
    const paths = statePaths(dir)
    for (const body of ['999999:abc', 'basura', '']) {
      await writeFile(paths.lock, body)
      const r = await acquireLock(paths, async () => false)
      expect(r.acquired, body).toBe(true)
      if (r.acquired) await r.release()
    }
  })

  it('arranques simultáneos: exactamente uno gana', async () => {
    await mkdir(dir, { recursive: true })
    const paths = statePaths(dir)
    const results = await Promise.all(
      Array.from({ length: 10 }, () => acquireLock(paths, async () => true)),
    )
    expect(results.filter((r) => r.acquired)).toHaveLength(1)
  })

  it('release no borra el cerrojo de otro', async () => {
    const paths = statePaths(dir)
    const a = await acquireLock(paths, async () => true)
    await writeFile(paths.lock, '1234:otro')
    if (a.acquired) await a.release()
    expect(await readFile(paths.lock, 'utf8')).toBe('1234:otro')
  })
})
