import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { describeError, ToolError } from './errors.ts'
import type { LinkClient, LinkEvent } from './link.ts'
import { oneLine } from './text.ts'
import type { ToolsContext } from './tools.ts'
import {
  agentStatusUri,
  buildAgentStatus,
  buildAttention,
  buildLimits,
  buildWorkspaces,
  parseAgentStatusUri,
  URI,
} from './views.ts'

const MIME = 'application/json'
const MAX_REASONS = 256

/** Último motivo (`reason`) de cada sesión según `agent.status`; acotado. */
export class ReasonTracker {
  readonly #reasons = new Map<string, string>()

  handle(event: LinkEvent): void {
    if (event.name === 'agent.status') {
      const { sessionId, reason, status } = event.data
      if (reason === undefined || (status !== 'error' && status !== 'needs-input')) {
        this.#reasons.delete(sessionId)
        return
      }
      if (this.#reasons.size >= MAX_REASONS && !this.#reasons.has(sessionId)) {
        const oldest = this.#reasons.keys().next().value
        if (oldest !== undefined) this.#reasons.delete(oldest)
      }
      this.#reasons.set(sessionId, oneLine(reason, 300))
    } else if (event.name === 'agent.session' && 'removed' in event.data) {
      this.#reasons.delete(event.data.sessionId)
    } else if (event.name === 'resync') {
      this.#reasons.clear()
    }
  }

  get(sessionId: string): string | undefined {
    return this.#reasons.get(sessionId)
  }
}

function asMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error
  const d = describeError(error)
  const code = d.code === 'NOT_FOUND' ? ErrorCode.InvalidParams : ErrorCode.InternalError
  return new McpError(code, `${d.code}: ${d.message}`)
}

function json(uri: URL, value: unknown) {
  return { contents: [{ uri: uri.href, mimeType: MIME, text: JSON.stringify(value) }] }
}

/**
 * Recursos de estado suscribibles. Cada lectura va al daemon (no hay copia local que pueda quedar vieja);
 * los avisos de cambio salen de los eventos del daemon (ver `ChangeNotifier`).
 */
export function registerResources(ctx: ToolsContext, reasons: ReasonTracker): void {
  const server: McpServer = ctx.server

  async function withClient<T>(fn: (client: LinkClient) => Promise<T>): Promise<T> {
    try {
      const take = ctx.readLimiter.take()
      if (!take.ok)
        throw new ToolError('RATE_LIMITED', 'demasiadas lecturas; reintenta en unos segundos')
      return await fn(await ctx.link.get())
    } catch (error) {
      ctx.logger(`recurso: ${describeError(error).code}`)
      throw asMcpError(error)
    }
  }

  server.registerResource(
    'attention',
    URI.attention,
    {
      title: 'Atención',
      description:
        'Estado agregado de atención (needs-input > error > working > done > idle) y los paneles que no están en reposo. Pensado para que una mascota o un indicador reaccione.',
      mimeType: MIME,
    },
    (uri) =>
      withClient(async (client) => {
        const { workspaces } = await client.call('workspace.list', {})
        return json(uri, buildAttention(workspaces))
      }),
  )

  server.registerResource(
    'workspaces',
    URI.workspaces,
    {
      title: 'Espacios, pestañas y paneles',
      description: 'El árbol de espacios, pestañas y paneles con su estado de atención.',
      mimeType: MIME,
    },
    (uri) =>
      withClient(async (client) => {
        const { workspaces } = await client.call('workspace.list', {})
        return json(uri, { workspaces: buildWorkspaces(workspaces) })
      }),
  )

  server.registerResource(
    'agents',
    URI.agents,
    {
      title: 'Sesiones de agente',
      description: 'Estado de todas las sesiones de agente abiertas.',
      mimeType: MIME,
    },
    (uri) =>
      withClient(async (client) => {
        const { sessions } = await client.call('agent.list', {})
        ctx.rememberAgents(sessions.map((s) => s.id))
        return json(uri, {
          sessions: sessions.map((s) => buildAgentStatus(s, reasons.get(s.id))),
        })
      }),
  )

  server.registerResource(
    'limits',
    URI.limits,
    {
      title: 'Límites de uso',
      description: 'Límites de uso de los proveedores (último dato conocido; no fuerza consultas).',
      mimeType: MIME,
    },
    (uri) =>
      withClient(async (client) => {
        const r = await client.call('limits.status', {})
        return json(uri, buildLimits(r.providers))
      }),
  )

  server.registerResource(
    'agent-status',
    new ResourceTemplate('nexo://agents/{id}/status', {
      list: async () => {
        try {
          const client = await ctx.link.get()
          const { sessions } = await client.call('agent.list', {})
          ctx.rememberAgents(sessions.map((s) => s.id))
          return {
            resources: sessions.map((s) => ({
              uri: agentStatusUri(s.id),
              name: `agent-${s.id}`,
              title: `Estado de ${oneLine(s.title ?? s.id, 80)}`,
              mimeType: MIME,
            })),
          }
        } catch {
          // Sin daemon la lista de sesiones está vacía; los recursos fijos siguen ahí.
          return { resources: [] }
        }
      },
    }),
    {
      title: 'Estado de una sesión de agente',
      description:
        'Estado de una sesión: working, needs-input (espera permiso o respuesta), done (fin de turno), error o idle.',
      mimeType: MIME,
    },
    (uri) =>
      withClient(async (client) => {
        const id = parseAgentStatusUri(uri.href)
        if (id === undefined) throw new McpError(ErrorCode.InvalidParams, 'URI de sesión no válida')
        const { sessions } = await client.call('agent.list', {})
        const session = sessions.find((s) => s.id === id)
        if (session === undefined) {
          throw new McpError(ErrorCode.InvalidParams, 'NOT_FOUND: no existe esa sesión')
        }
        return json(uri, buildAgentStatus(session, reasons.get(id)))
      }),
  )
}
