import type { MethodParams, MethodResult } from '@nexo/contracts'
import type { CallOptions, NexoClient } from './client.ts'

type Caller = Pick<NexoClient, 'call'>

/** Métodos `agent.*` con nombre y tipos; delgado envoltorio de `client.call`. */
export function agentApi(client: Caller) {
  return {
    providers: (o?: CallOptions<MethodResult<'agent.providers'>>) =>
      client.call('agent.providers', {}, o),
    create: (p: MethodParams<'agent.create'>, o?: CallOptions<MethodResult<'agent.create'>>) =>
      client.call('agent.create', p, o),
    send: (p: MethodParams<'agent.send'>, o?: CallOptions<MethodResult<'agent.send'>>) =>
      client.call('agent.send', p, o),
    interrupt: (p: MethodParams<'agent.interrupt'>) => client.call('agent.interrupt', p),
    respond: (p: MethodParams<'agent.respond'>) => client.call('agent.respond', p),
    list: () => client.call('agent.list', {}),
    snapshot: (
      p: MethodParams<'agent.snapshot'>,
      o?: CallOptions<MethodResult<'agent.snapshot'>>,
    ) => client.call('agent.snapshot', p, o),
    close: (p: MethodParams<'agent.close'>) => client.call('agent.close', p),
    /** Renueva la sesión sembrándola con la memoria (F3.5.4); abrir la nueva puede tardar. */
    renew: (p: MethodParams<'agent.renew'>, o?: CallOptions<MethodResult<'agent.renew'>>) =>
      client.call('agent.renew', p, o),
  }
}

export type AgentApi = ReturnType<typeof agentApi>
