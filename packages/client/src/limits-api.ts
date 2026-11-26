import type { MethodParams, MethodResult, ProviderLimits } from '@nexo/contracts'
import type { CallOptions, NexoClient } from './client.ts'

type Caller = Pick<NexoClient, 'call' | 'on'>

/**
 * Métodos `limits.*` (F4.4) con nombre y tipos. `status` lee los límites de uso de los proveedores; `refresh` fuerza
 * a consultar a los que se pueden consultar; `onUpdated` avisa del evento `limits.updated` (el cliente sustituye lo
 * que tenía de ese proveedor).
 */
export function limitsApi(client: Caller) {
  return {
    status: (
      p: MethodParams<'limits.status'> = {},
      o?: CallOptions<MethodResult<'limits.status'>>,
    ) => client.call('limits.status', p, o),
    refresh: (
      p: Omit<MethodParams<'limits.status'>, 'refresh'> = {},
      o?: CallOptions<MethodResult<'limits.status'>>,
    ) => client.call('limits.status', { ...p, refresh: true }, o),
    onUpdated: (handler: (limits: ProviderLimits) => void): (() => void) =>
      client.on('limits.updated', handler),
  }
}

export type LimitsApi = ReturnType<typeof limitsApi>
