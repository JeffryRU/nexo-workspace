import { memoryApi } from '@nexo/client'
import { AgentSessionId } from '@nexo/contracts'
import { useQuery, useQueryClient } from '@tanstack/solid-query'
import { createEffect, onCleanup } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { es } from '../i18n/es.ts'

/** Consultas de memoria compartidas por la vista y el panel de agente; todas cuelgan de la clave `['memory']`. */
const LIST_LIMIT = 100

export function useMemoryStatus(cwd: () => string | undefined) {
  const app = useModel()
  return useQuery(() => ({
    queryKey: ['memory', 'status', cwd() ?? null],
    queryFn: async () => {
      const client = app.agentClient()
      if (client === undefined) throw new Error(es.status.offline)
      const dir = cwd()
      return memoryApi(client).status(dir === undefined ? {} : { cwd: dir })
    },
    enabled: app.status() === 'open',
    staleTime: 30_000,
  }))
}

export function useMemoryList(cwd: () => string | undefined) {
  const app = useModel()
  return useQuery(() => ({
    queryKey: ['memory', 'list', cwd() ?? null],
    queryFn: async () => {
      const client = app.agentClient()
      const dir = cwd()
      if (client === undefined || dir === undefined) throw new Error(es.status.offline)
      return memoryApi(client).list({ cwd: dir, limit: LIST_LIMIT })
    },
    enabled: app.status() === 'open' && cwd() !== undefined,
    staleTime: 30_000,
  }))
}

/** Texto original detrás de un rango (`memory.recall`); solo se pide con `enabled`. */
export function useMemoryRecall(
  source: () => { sessionId: string; from: number; to: number } | undefined,
) {
  const app = useModel()
  return useQuery(() => {
    const s = source()
    return {
      queryKey: ['memory', 'recall', s?.sessionId ?? null, s?.from ?? null, s?.to ?? null],
      queryFn: async () => {
        const client = app.agentClient()
        if (client === undefined || s === undefined) throw new Error(es.status.offline)
        return memoryApi(client).recall({
          sessionId: AgentSessionId.parse(s.sessionId),
          range: { from: s.from, to: s.to },
        })
      },
      enabled: app.status() === 'open' && s !== undefined,
      staleTime: 60_000,
      retry: false,
    }
  })
}

/** Refresca lo que se ve cuando el daemon avisa de que la memoria cambió (`memory.updated`). */
export function useMemoryEvents(): void {
  const app = useModel()
  const queryClient = useQueryClient()
  createEffect(() => {
    const client = app.status() === 'open' ? app.agentClient() : undefined
    if (client === undefined) return
    const off = client.on('memory.updated', () => {
      void queryClient.invalidateQueries({ queryKey: ['memory'] })
    })
    onCleanup(off)
  })
}
