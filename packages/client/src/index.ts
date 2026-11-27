import type { MethodName, MethodParams, MethodResult } from '@nexo/contracts'
import { type ClientOptions, NexoClient } from './client.ts'
import { type WebSocketTransportOptions, webSocketTransport } from './transport.ts'

export { type AgentApi, agentApi } from './agent-api.ts'
export {
  AgentDocument,
  type AgentDocumentClient,
  type AgentDocumentEvent,
  type AgentDocumentOptions,
} from './agent-document.ts'
export { type BackoffOptions, backoffDelay } from './backoff.ts'
export {
  type CallOptions,
  type ClientOptions,
  type ClientState,
  NexoClient,
  type ReconnectOptions,
  type ResyncInfo,
  type ResyncReason,
  type Snapshot,
} from './client.ts'
export { type CompanionApi, companionApi } from './companion-api.ts'
export { type ClientErrorCode, NexoClientError } from './errors.ts'
export { type FsApi, type FsFile, type FsReadAllOptions, fsApi } from './fs-api.ts'
export {
  type HistoryApi,
  type HistoryReadAllOptions,
  type HistoryTranscriptAll,
  historyApi,
} from './history-api.ts'
export { type LimitsApi, limitsApi } from './limits-api.ts'
export { type MemoryApi, memoryApi } from './memory-api.ts'
export {
  SUBPROTOCOL,
  type Transport,
  type TransportFactory,
  type WebSocketConstructor,
  type WebSocketLike,
  type WebSocketTransportOptions,
  webSocketTransport,
} from './transport.ts'

export type { MethodName, MethodParams, MethodResult }

export const CLIENT_PROTOCOL_VERSION = 1

/** Cliente por WebSocket (navegador, WebView o Node 24) ya conectado. */
export async function connectWebSocket(
  options: WebSocketTransportOptions & { client?: Omit<ClientOptions, 'transport'> },
): Promise<NexoClient> {
  const { client: clientOptions, ...transportOptions } = options
  const client = new NexoClient({
    ...clientOptions,
    transport: () => webSocketTransport(transportOptions),
  })
  await client.connect()
  return client
}
