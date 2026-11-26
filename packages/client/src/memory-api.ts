import type { MethodParams, MethodResult } from '@nexo/contracts'
import type { CallOptions, NexoClient } from './client.ts'

type Caller = Pick<NexoClient, 'call'>

/** Métodos `memory.*` (F3.5.2) con nombre y tipos; delgado envoltorio de `client.call`. */
export function memoryApi(client: Caller) {
  return {
    status: (p: MethodParams<'memory.status'> = {}) => client.call('memory.status', p),
    list: (p: MethodParams<'memory.list'>, o?: CallOptions<MethodResult<'memory.list'>>) =>
      client.call('memory.list', p, o),
    search: (p: MethodParams<'memory.search'>, o?: CallOptions<MethodResult<'memory.search'>>) =>
      client.call('memory.search', p, o),
    recall: (p: MethodParams<'memory.recall'>, o?: CallOptions<MethodResult<'memory.recall'>>) =>
      client.call('memory.recall', p, o),
  }
}

export type MemoryApi = ReturnType<typeof memoryApi>
