import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BlockDraft } from '@nexo/contracts'
import { type HistoryRig, runHistoryConformance } from '@nexo/testkit/conformance'
import { describe, expect, it } from 'vitest'
import { createCodexProvider } from '../src/index.ts'
import { agentItem, codexRig, dir, threadFrom, userItem } from './history-rig.ts'

runHistoryConformance('provider-codex (app-server falso)', (): HistoryRig => {
  const rig = codexRig()
  return {
    history: rig.history,
    unknownId: randomUUID(),
    seed: async (s) =>
      rig.add(
        threadFrom({ cwd: s.cwd, title: s.title, updatedAt: s.updatedAt, messages: s.messages }),
      ),
  }
})

describe('CodexHistory', () => {
  it('lista con título, carpeta y fechas (segundos a milisegundos) y pide los orígenes interactivos', async () => {
    const rig = codexRig()
    const id = rig.add(
      threadFrom({
        cwd: '/work/app',
        title: 'Arreglar el login',
        updatedAt: 1_700_000_100_000,
        messages: [{ role: 'user', text: 'hola' }],
      }),
    )
    const [s] = await rig.history.list({ limit: 10 })
    expect(s).toMatchObject({
      sessionId: id,
      title: 'Arreglar el login',
      cwd: '/work/app',
      updatedAt: 1_700_000_100_000,
      createdAt: 1_700_000_040_000,
      resumable: true,
    })
  })

  it('sin nombre usa la vista previa (el primer mensaje) como título', async () => {
    const rig = codexRig()
    rig.add(
      threadFrom({ updatedAt: 1_700_000_000_000, messages: [{ role: 'user', text: 'hacer X' }] }),
    )
    const [s] = await rig.history.list({ limit: 10 })
    expect(s?.title).toBe('hacer X')
  })

  it('recorre varias páginas con el cursor hasta el límite', async () => {
    const rig = codexRig({ FAKE_CODEX_PAGE: '2' })
    for (let i = 0; i < 5; i++) {
      rig.add(
        threadFrom({
          updatedAt: 1_700_000_000_000 + i * 1000,
          messages: [{ role: 'user', text: `m${i}` }],
        }),
      )
    }
    expect(await rig.history.list({ limit: 50 })).toHaveLength(5)
    expect(await rig.history.list({ limit: 3 })).toHaveLength(3)
  })

  it('traduce items de herramientas y razonamiento a bloques', async () => {
    const rig = codexRig()
    const id = randomUUID()
    rig.add({
      ...threadFrom({ id, updatedAt: 1_700_000_000_000, messages: [] }),
      turns: [
        {
          id: randomUUID(),
          status: 'completed',
          items: [
            userItem('corre ls'),
            { type: 'reasoning', id: 'r1', summary: ['pienso'], content: [] },
            {
              type: 'commandExecution',
              id: 'c1',
              command: 'ls',
              cwd: '/w',
              status: 'completed',
              aggregatedOutput: 'a\nb',
              exitCode: 0,
              durationMs: 5,
            },
            agentItem('listo'),
          ],
        },
      ],
    })
    const t = await rig.history.read({ sessionId: id, maxBlocks: 50 })
    expect(t.blocks.map((b) => b.block.type)).toEqual(['user', 'reasoning', 'action', 'text'])
    expect(t.blocks[2]?.block).toMatchObject({ kind: 'exec', status: 'ok', exitCode: 0 })
    for (const b of t.blocks) expect(BlockDraft.safeParse(b.block).success).toBe(true)
  })

  it('un servidor que no responde se corta con la cancelación, sin dejar procesos', async () => {
    const rig = codexRig({ FAKE_CODEX_HISTORY_HANG: '1' })
    let abort: (() => void) | undefined
    const signal = {
      aborted: false,
      addEventListener(_t: 'abort', l: () => void) {
        abort = () => {
          signal.aborted = true
          l()
        }
      },
      removeEventListener() {},
    }
    const pending = rig.history.list({ limit: 5, signal })
    setTimeout(() => abort?.(), 150)
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('un ejecutable que no existe da UNAVAILABLE', async () => {
    const provider = createCodexProvider({
      env: { ...process.env },
      executable: join(dir, 'no-existe-codex'),
    })
    await expect(provider.history?.list({ limit: 1 })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  })
})
