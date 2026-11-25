import type { MethodName, MethodParams, MethodResult } from '@nexo/contracts'

// TODO(F1): implementar el cliente WebSocket (conexion, auth, peticiones con id, eventos con seq,
// validacion con parseServerMessage/parseResult). Por ahora solo los tipos derivados del registro.

export type { MethodName, MethodParams, MethodResult }

/** Forma del cliente: un metodo por entrada del registro, con tipos derivados de contracts. */
export type NexoClient = {
  [M in MethodName]: (params: MethodParams<M>) => Promise<MethodResult<M>>
}

export const CLIENT_PROTOCOL_VERSION = 1
