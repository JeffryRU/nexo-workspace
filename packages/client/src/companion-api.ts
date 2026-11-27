import type { CompanionStateView, MethodParams, MethodResult } from '@nexo/contracts'
import type { CallOptions, NexoClient } from './client.ts'

type Caller = Pick<NexoClient, 'call' | 'on'>

/**
 * Métodos `companion.*` (F5.2) con nombre y tipos. `asset` devuelve los bytes de un recurso en base64 con su tipo
 * ya comprobado por el daemon; quien lo dibuja (F5.3) debe usarlo siempre como imagen (`<img>` con un `Blob` o
 * `data:`), nunca incrustar un SVG. `onState` avisa del evento `companion.state` (estado y compañero elegido).
 */
export function companionApi(client: Caller) {
  return {
    list: (o?: CallOptions<MethodResult<'companion.list'>>) => client.call('companion.list', {}, o),
    get: (p: MethodParams<'companion.get'>, o?: CallOptions<MethodResult<'companion.get'>>) =>
      client.call('companion.get', p, o),
    select: (
      p: MethodParams<'companion.select'>,
      o?: CallOptions<MethodResult<'companion.select'>>,
    ) => client.call('companion.select', p, o),
    asset: (p: MethodParams<'companion.asset'>, o?: CallOptions<MethodResult<'companion.asset'>>) =>
      client.call('companion.asset', p, o),
    state: (o?: CallOptions<MethodResult<'companion.state'>>) =>
      client.call('companion.state', {}, o),
    onState: (handler: (state: CompanionStateView) => void): (() => void) =>
      client.on('companion.state', handler),
  }
}

export type CompanionApi = ReturnType<typeof companionApi>
