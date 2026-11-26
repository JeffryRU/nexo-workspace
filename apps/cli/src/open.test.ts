import { resolve } from 'node:path'
import type { MethodResult } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { OpenOutput } from './schemas.ts'
import { makeEnv, sampleWorkspaces, type TestEnv, WORK } from './test-helpers.ts'

const run = (env: TestEnv, ...args: string[]) => runCli(args, env.deps)

const file = resolve(WORK, 'docs/LEEME.md')

const stat = (over: Partial<MethodResult<'fs.stat'>> = {}): MethodResult<'fs.stat'> => ({
  path: file,
  kind: 'file',
  size: 12,
  mtimeMs: 1,
  type: 'markdown',
  mime: 'text/markdown',
  maxBytes: 8 * 1024 * 1024,
  tooLarge: false,
  ...over,
})

function setup() {
  const env = makeEnv()
  env.client.workspaces = sampleWorkspaces()
  env.client.handlers.set('fs.stat', () => stat())
  env.client.handlers.set('pane.split', () => ({
    pane: { id: 'pane-9999aaaa-0000', kind: 'viewer', title: 'LEEME.md', attention: 'idle' },
    layout: { type: 'leaf', paneId: 'pane-9999aaaa-0000' },
  }))
  return env
}

describe('nexo open', () => {
  it('sin visor en la pestaña divide el panel enfocado con uno nuevo', async () => {
    const env = setup()
    expect(await run(env, 'open', 'docs/LEEME.md')).toBe(0)
    expect(env.client.callsTo('fs.stat')[0]).toEqual({ path: file })
    expect(env.client.callsTo('pane.split')[0]).toEqual({
      paneId: 'pane-cccc3333-0000',
      direction: 'row',
      kind: 'viewer',
      path: file,
    })
    expect(env.client.callsTo('viewer.open')).toHaveLength(0)
    expect(env.client.callsTo('pane.focus')[0]).toEqual({ paneId: 'pane-9999aaaa-0000' })
    expect(env.cap.out).toContain('creado el visor')
  })

  it('con un visor en la pestaña lo reutiliza con viewer.open', async () => {
    const env = setup()
    const tab = env.client.workspaces[0]?.tabs[0]
    const pane = tab?.panes[1]
    if (pane !== undefined) pane.kind = 'viewer'
    expect(await run(env, 'open', file)).toBe(0)
    expect(env.client.callsTo('viewer.open')[0]).toEqual({
      paneId: 'pane-cccc3333-1111',
      path: file,
    })
    expect(env.client.callsTo('pane.split')).toHaveLength(0)
  })

  it('--pane elige la pestaña del panel indicado', async () => {
    const env = setup()
    expect(await run(env, 'open', file, '--pane', 'pane-eeee5555-0000')).toBe(0)
    expect(env.client.callsTo('pane.split')[0]).toMatchObject({ paneId: 'pane-eeee5555-0000' })
  })

  it('--json emite el resultado validado', async () => {
    const env = setup()
    expect(await run(env, 'open', '--json', file)).toBe(0)
    const out = OpenOutput.parse(JSON.parse(env.cap.out))
    expect(out).toMatchObject({ paneId: 'pane-9999aaaa-0000', path: file, created: true })
  })

  it('una carpeta se rechaza', async () => {
    const env = setup()
    env.client.handlers.set('fs.stat', () => stat({ kind: 'directory' }))
    expect(await run(env, 'open', 'docs')).toBe(1)
    expect(env.client.callsTo('pane.split')).toHaveLength(0)
  })

  it('sin espacios con pestañas no hay dónde mostrarlo (no encontrado)', async () => {
    const env = setup()
    env.client.workspaces = []
    expect(await run(env, 'open', file)).toBe(2)
  })

  it('exige una ruta', async () => {
    const env = setup()
    expect(await run(env, 'open')).toBe(1)
  })
})
