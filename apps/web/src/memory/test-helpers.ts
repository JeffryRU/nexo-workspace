import type { MethodResult, Observation } from '@nexo/contracts'
import { type AgentHarnessOptions, mountAgent, SID, settle } from '../agent/test-helpers.ts'

export const USAGE = { calls: 3, inputTokens: 1200, outputTokens: 90, costUsd: 0.0042 }
export const ZERO = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }

export const obs = (seq: number, over: Partial<Observation> = {}): Observation => ({
  seq,
  at: 1_700_000_000_000 + seq * 60_000,
  priority: 'medium',
  scope: 'project',
  sessionId: SID,
  range: { from: 1, to: 2 },
  text: `observación ${seq}`,
  ...over,
})

export type MemoryHarnessOptions = AgentHarnessOptions & {
  status?: Partial<MethodResult<'memory.status'>>
  observations?: Observation[]
  reflection?: MethodResult<'memory.list'>['reflection']
}

/** Aplicación con un panel de agente y un daemon falso que sirve los métodos `memory.*`. */
export async function mountMemory(options: MemoryHarnessOptions = {}) {
  const state = {
    status: {
      enabled: true,
      summarizer: 'fake',
      thresholds: { observerBatchTokens: 6000, reflectorTokens: 40000 },
      usage: { ...USAGE, calls: 5 },
      roles: { observer: { ...USAGE, calls: 4 }, reflector: { ...USAGE, calls: 1, costUsd: 0.01 } },
      projectUsage: { ...USAGE, calls: 9 },
      ...options.status,
    } as MethodResult<'memory.status'>,
    observations: options.observations ?? [obs(1), obs(2, { priority: 'high', scope: 'session' })],
    reflection: options.reflection ?? null,
  }
  const h = await mountAgent({
    ...options,
    session: { cwd: '/work', ...options.session },
    setup: (client) => {
      client.handlers.set('memory.status', () => structuredClone(state.status))
      client.handlers.set('memory.list', () => ({
        reflection: state.reflection,
        observations: structuredClone(state.observations),
        nextSeq: null,
      }))
      client.handlers.set('memory.configure', (p) => {
        const params = p as { enabled?: boolean; renewAtTokens?: number | null }
        if (params.enabled !== undefined) state.status.enabled = params.enabled
        if (params.renewAtTokens === null) delete state.status.renewAtTokens
        else if (params.renewAtTokens !== undefined)
          state.status.renewAtTokens = params.renewAtTokens
        return {
          enabled: state.status.enabled,
          ...(state.status.renewAtTokens === undefined
            ? {}
            : { renewAtTokens: state.status.renewAtTokens }),
        }
      })
      options.setup?.(client)
    },
  })
  return { ...h, memory: state }
}

export type MemoryHarness = Awaited<ReturnType<typeof mountMemory>>

/** Abre la ventana de memoria con el botón de la barra de estado y espera las consultas. */
export async function openMemory(h: MemoryHarness): Promise<void> {
  const button = h.container.querySelector<HTMLButtonElement>('.memory-toggle')
  if (button === null) throw new Error('falta el botón de memoria')
  button.click()
  await settle(8)
}
