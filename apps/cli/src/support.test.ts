import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { intOption, parseArgv, splitDashDash } from './args.ts'
import {
  makeDaemonControl,
  resolveDaemonEntry,
  startDaemonDetached,
  startTimeoutMs,
} from './launcher.ts'
import { resolveRef, shortId } from './resolve.ts'
import { sampleWorkspaces } from './test-helpers.ts'

describe('args', () => {
  it('traduce los errores de parseArgs al español y sin eco peligroso', () => {
    expect(() => parseArgv(['--nada'])).toThrow(/opción desconocida/)
    expect(() => parseArgv(['--lines'], { lines: { type: 'string' } })).toThrow(/valor de opción/)
    expect(() => parseArgv(['--json=1'])).toThrow(/no válido|opción/)
    try {
      parseArgv([`--\u001b[31m`])
    } catch (error) {
      expect((error as Error).message).not.toContain('\u001b')
    }
  })

  it('splitDashDash corta en el primer --', () => {
    expect(splitDashDash(['a', '--', 'b', '--', 'c'])).toEqual({
      before: ['a'],
      after: ['b', '--', 'c'],
    })
    expect(splitDashDash(['a'])).toEqual({ before: ['a'], after: [] })
  })

  it('intOption valida rango y formato', () => {
    const p = (v: string) => parseArgv(['--n', v], { n: { type: 'string' } })
    expect(intOption(p('5'), 'n', 1, 1, 10)).toBe(5)
    expect(intOption(parseArgv([]), 'n', 7, 1, 10)).toBe(7)
    for (const bad of ['0', '11', '-1', '1e3', ' 5', '5 ', '0x10', '١٢']) {
      expect(() => intOption(p(bad), 'n', 1, 1, 10), bad).toThrow()
    }
  })
})

describe('resolveRef', () => {
  const ws = sampleWorkspaces()
  it('id exacto, nombre exacto y prefijo único', () => {
    expect(resolveRef(ws, 'tab-bbbb2222-0000', ['tab']).id).toBe('tab-bbbb2222-0000')
    expect(resolveRef(ws, 'servidor', ['tab']).id).toBe('tab-bbbb2222-0000')
    expect(resolveRef(ws, 'pane-eeee', ['pane']).id).toBe('pane-eeee5555-0000')
    expect(resolveRef(ws, 'eeee5555', ['pane']).id).toBe('pane-eeee5555-0000')
    expect(resolveRef(ws, 'proyecto', ['workspace', 'tab']).kind).toBe('workspace')
  })
  it('los paneles no se resuelven por título', () => {
    expect(() => resolveRef(ws, 'bash', ['pane'])).toThrow(/no se encontró/)
  })
  it('ids hostiles no encuentran nada y no se reflejan crudos', () => {
    try {
      resolveRef(ws, '\u001b[2J\u001b]0;x\u0007', ['pane'])
    } catch (error) {
      expect((error as Error).message).not.toContain('\u001b')
    }
  })
  it('shortId', () => {
    expect(shortId('pane-1a2b3c4d-1111-2222')).toBe('pane-1a2b3c4d')
    expect(shortId('abcdefghijklmnop')).toBe('abcdefghijkl')
  })
})

describe('launcher', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })
  const tmp = async () => {
    const d = await mkdtemp(join(tmpdir(), 'nexo-cli-'))
    dirs.push(d)
    return d
  }

  it('resolveDaemonEntry usa NEXO_DAEMON_ENTRY o la ruta relativa al paquete', () => {
    expect(resolveDaemonEntry({ NEXO_DAEMON_ENTRY: '/x/main.ts' })).toBe('/x/main.ts')
    const found = resolveDaemonEntry({})
    expect(found.replaceAll('\\', '/')).toMatch(/apps\/daemon\/src\/main\.ts$/)
    expect(
      resolveDaemonEntry({ NEXO_DAEMON_ENTRY: '' }, pathToFileURL(resolve('/a/b/c/d.ts')).href),
    ).toMatch(/main\.ts$/)
  })

  it('startTimeoutMs valida NEXO_START_TIMEOUT_MS', () => {
    expect(startTimeoutMs({})).toBe(10_000)
    expect(startTimeoutMs({ NEXO_START_TIMEOUT_MS: '500' })).toBe(500)
    for (const bad of ['0', '-1', 'x', '999999999', '1.5']) {
      expect(() => startTimeoutMs({ NEXO_START_TIMEOUT_MS: bad }), bad).toThrow(
        /NEXO_START_TIMEOUT_MS/,
      )
    }
  })

  it('startDaemonDetached lanza desacoplado, oculto, sin shell y con el registro en el estado', async () => {
    const dir = await tmp()
    const entry = join(dir, 'main.ts')
    await writeFile(entry, '')
    const calls: unknown[][] = []
    const handlers: Record<string, (e: Error) => void> = {}
    let unref = 0
    const fake = ((...args: unknown[]) => {
      calls.push(args)
      return {
        on: (event: string, h: (e: Error) => void) => {
          handlers[event] = h
        },
        unref: () => void unref++,
      }
    }) as never
    const state = join(dir, 'estado')
    const result = startDaemonDetached({
      entry,
      stateDir: state,
      env: { NEXO_PORT: '0' },
      spawnFn: fake,
    })
    expect(calls).toHaveLength(1)
    const [cmd, args, options] = calls[0] as [string, string[], Record<string, unknown>]
    expect(cmd).toBe(process.execPath)
    expect(args).toEqual([entry])
    expect(options).toMatchObject({ detached: true, windowsHide: true })
    expect((options.stdio as unknown[])[0]).toBe('ignore')
    expect(unref).toBe(1)
    expect(result.spawnError()).toBeUndefined()
    handlers.error?.(Object.assign(new Error('x'), { code: 'EACCES' }))
    expect(result.spawnError()).toBe('EACCES')
    expect(await readFile(join(state, 'daemon.log'), 'utf8')).toBe('')
  })

  it('startDaemonDetached rota un registro enorme y rechaza una entrada inexistente', async () => {
    const dir = await tmp()
    const entry = join(dir, 'main.ts')
    await writeFile(entry, '')
    await mkdir(join(dir, 's'))
    await writeFile(join(dir, 's', 'daemon.log'), 'x'.repeat(3 * 1024 * 1024))
    startDaemonDetached({
      entry,
      stateDir: join(dir, 's'),
      env: {},
      spawnFn: (() => ({ on() {}, unref() {} })) as never,
    })
    expect((await readFile(join(dir, 's', 'daemon.log.1'))).length).toBe(3 * 1024 * 1024)
    expect(() =>
      startDaemonDetached({ entry: join(dir, 'no-existe.ts'), stateDir: dir, env: {} }),
    ).toThrow(/NEXO_DAEMON_ENTRY/)
  })

  it('readLog lee la cola del registro y devuelve undefined si no existe', async () => {
    const dir = await tmp()
    const control = makeDaemonControl({ NEXO_STATE_DIR: dir })
    expect(control.stateDir()).toBe(dir)
    expect(await control.readLog(100)).toBeUndefined()
    await writeFile(join(dir, 'daemon.log'), 'abcdefghij')
    expect(await control.readLog(4)).toBe('ghij')
    expect(await control.readLog(1000)).toBe('abcdefghij')
    await expect(control.locate()).rejects.toThrow()
  })
})
