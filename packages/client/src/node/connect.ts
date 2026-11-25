import { type ClientOptions, NexoClient } from '../client.ts'
import { webSocketTransport } from '../transport.ts'
import {
  type DaemonLocation,
  type DiscoveryOptions,
  discoverDaemon,
  type EnsureDaemonOptions,
  ensureDaemon,
} from './discovery.ts'

export type ConnectToDaemonOptions = {
  discovery?: DiscoveryOptions
  /** Si se da, un daemon ausente se arranca con este callback (ver ensureDaemon). */
  ensure?: Pick<EnsureDaemonOptions, 'start' | 'timeoutMs' | 'pollMs'>
  auth?: 'subprotocol' | 'message'
  client?: Omit<ClientOptions, 'transport'>
}

/** Descubre el daemon y conecta. Cada reconexión vuelve a descubrir (puerto y token pueden cambiar). */
export async function connectToDaemon(options: ConnectToDaemonOptions = {}): Promise<NexoClient> {
  const locate = (): Promise<DaemonLocation> =>
    options.ensure === undefined
      ? discoverDaemon(options.discovery)
      : ensureDaemon({ ...options.discovery, ...options.ensure })
  // El primer descubrimiento va fuera del cliente para que el error (NOT_RUNNING, STALE...) llegue tipado.
  let first: DaemonLocation | undefined = await locate()
  const client = new NexoClient({
    ...options.client,
    transport: async () => {
      const where = first ?? (await locate())
      first = undefined
      return webSocketTransport({
        url: where.url,
        token: where.token,
        ...(options.auth === undefined ? {} : { auth: options.auth }),
      })
    },
  })
  await client.connect()
  return client
}
