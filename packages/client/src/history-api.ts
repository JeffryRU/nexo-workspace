import type { HistoryBlock, HistoryProject, MethodParams, MethodResult } from '@nexo/contracts'
import type { CallOptions, NexoClient } from './client.ts'

type Caller = Pick<NexoClient, 'call'>

export type HistoryReadAllOptions = {
  /** Tope de bloques a juntar (por omisión, todos los que devuelva el daemon). */
  maxBlocks?: number
  signal?: AbortSignal
}

export type HistoryTranscriptAll = {
  blocks: HistoryBlock[]
  total: number
  truncated: boolean
  /** `true` si se paró en `maxBlocks` antes del final. */
  partial: boolean
}

/**
 * Métodos `history.*` (F4.3) con nombre y tipos. `listAll` y `readAll` siguen los cursores hasta el final (o hasta un
 * tope); `listAll` junta las carpetas partidas entre dos páginas.
 */
export function historyApi(client: Caller) {
  return {
    list: (p: MethodParams<'history.list'> = {}, o?: CallOptions<MethodResult<'history.list'>>) =>
      client.call('history.list', p, o),
    read: (p: MethodParams<'history.read'>, o?: CallOptions<MethodResult<'history.read'>>) =>
      client.call('history.read', p, o),
    async listAll(
      p: Omit<MethodParams<'history.list'>, 'cursor'> = {},
      options: { maxSessions?: number; signal?: AbortSignal } = {},
    ): Promise<{
      projects: HistoryProject[]
      providers: MethodResult<'history.list'>['providers']
    }> {
      const max = options.maxSessions ?? Number.MAX_SAFE_INTEGER
      const byFolder = new Map<string, HistoryProject>()
      let providers: MethodResult<'history.list'>['providers'] = []
      let cursor: string | undefined
      let count = 0
      for (;;) {
        const page = await client.call(
          'history.list',
          { ...p, ...(cursor === undefined ? {} : { cursor }) },
          options.signal === undefined ? undefined : { signal: options.signal },
        )
        providers = page.providers
        for (const project of page.projects) {
          const key = project.cwd ?? '\u0000'
          const known = byFolder.get(key)
          if (known === undefined)
            byFolder.set(key, { ...project, sessions: [...project.sessions] })
          else known.sessions.push(...project.sessions)
          count += project.sessions.length
        }
        if (page.nextCursor === null || count >= max) break
        cursor = page.nextCursor
      }
      return { projects: [...byFolder.values()], providers }
    },
    async readAll(
      p: Omit<MethodParams<'history.read'>, 'cursor'>,
      options: HistoryReadAllOptions = {},
    ): Promise<HistoryTranscriptAll> {
      const max = options.maxBlocks ?? Number.MAX_SAFE_INTEGER
      const blocks: HistoryBlock[] = []
      let cursor: string | undefined
      let total = 0
      let truncated = false
      let partial = false
      for (;;) {
        const page = await client.call(
          'history.read',
          { ...p, ...(cursor === undefined ? {} : { cursor }) },
          options.signal === undefined ? undefined : { signal: options.signal },
        )
        total = page.total
        truncated = page.truncated
        blocks.push(...page.blocks)
        if (page.nextCursor === null) break
        if (blocks.length >= max) {
          partial = true
          break
        }
        cursor = page.nextCursor
      }
      return { blocks: blocks.slice(0, max), total, truncated, partial }
    },
  }
}

export type HistoryApi = ReturnType<typeof historyApi>
