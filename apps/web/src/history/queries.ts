import { agentApi, historyApi } from '@nexo/client'
import type { HistoryBlock, HistoryProject, HistoryProviderStatus } from '@nexo/contracts'
import { useInfiniteQuery, useQuery } from '@tanstack/solid-query'
import { createMemo } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { es } from '../i18n/es.ts'
import { mergeBlocks, mergeProjects } from './view.ts'

const PAGE = 50
const BLOCKS_PAGE = 100
/** La lista de un proveedor real puede tardar (lanza un proceso): se espera más que una llamada normal. */
const LIST_TIMEOUT_MS = 60_000

/** Nombres de los proveedores (misma consulta que el panel de agente: se comparte por `queryKey`). */
export function useProviderNames() {
  const app = useModel()
  const providers = useQuery(() => ({
    queryKey: ['agent.providers'],
    queryFn: async () => {
      const client = app.agentClient()
      if (client === undefined) throw new Error(es.status.offline)
      return (await agentApi(client).providers({ timeoutMs: 60_000 })).providers
    },
    enabled: app.status() === 'open',
    staleTime: 5 * 60_000,
  }))
  const list = createMemo(() => providers.data ?? [])
  return {
    providers: list,
    name: (id: string): string => list().find((p) => p.id === id)?.name ?? id,
  }
}

/** Sesiones del historial, de a `PAGE`, con filtro de proveedor en el daemon. Las páginas se juntan por carpeta. */
export function useHistoryList(provider: () => string | undefined) {
  const app = useModel()
  const query = useInfiniteQuery(() => ({
    queryKey: ['history', 'list', provider() ?? null],
    queryFn: async ({ pageParam }) => {
      const client = app.agentClient()
      if (client === undefined) throw new Error(es.status.offline)
      const p = provider()
      return historyApi(client).list(
        {
          limit: PAGE,
          ...(p === undefined ? {} : { provider: p }),
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        { timeoutMs: LIST_TIMEOUT_MS },
      )
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor,
    enabled: app.status() === 'open',
    staleTime: 15_000,
    retry: false,
  }))
  const projects = createMemo((): HistoryProject[] =>
    mergeProjects((query.data?.pages ?? []).map((p) => p.projects)),
  )
  // El estado por proveedor de la última página (la lista puede salir de la caché del daemon).
  const statuses = createMemo((): HistoryProviderStatus[] => {
    const pages = query.data?.pages ?? []
    return pages[pages.length - 1]?.providers ?? []
  })
  return { query, projects, statuses }
}

/** Transcripción de una sesión antigua por páginas de bloques normalizados. */
export function useHistoryBlocks(
  session: () => { provider: string; sessionId: string; cwd?: string | undefined } | undefined,
) {
  const app = useModel()
  const query = useInfiniteQuery(() => {
    const s = session()
    return {
      queryKey: ['history', 'read', s?.provider ?? null, s?.sessionId ?? null],
      queryFn: async ({ pageParam }: { pageParam: string | null }) => {
        const client = app.agentClient()
        if (client === undefined || s === undefined) throw new Error(es.status.offline)
        return historyApi(client).read(
          {
            provider: s.provider,
            sessionId: s.sessionId,
            limit: BLOCKS_PAGE,
            ...(s.cwd === undefined ? {} : { cwd: s.cwd }),
            ...(pageParam === null ? {} : { cursor: pageParam }),
          },
          { timeoutMs: LIST_TIMEOUT_MS },
        )
      },
      initialPageParam: null as string | null,
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor,
      enabled: app.status() === 'open' && s !== undefined,
      staleTime: 30_000,
      retry: false,
    }
  })
  const blocks = createMemo((): HistoryBlock[] =>
    mergeBlocks((query.data?.pages ?? []).map((p) => p.blocks)),
  )
  const last = () => query.data?.pages[query.data.pages.length - 1]
  return {
    query,
    blocks,
    total: () => last()?.total ?? 0,
    truncated: () => query.data?.pages.some((p) => p.truncated) === true,
  }
}
