#!/usr/bin/env node
// Raíz de composición del servidor MCP de Nexo: stdio hacia el cliente MCP, WebSocket hacia el daemon.
// stdout es el canal MCP: los diagnósticos van solo a stderr y pasan por el redactor de secretos.
import process from 'node:process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { connectToDaemon } from '@nexo/client/node'
import { ConfigError, loadConfig } from './config.ts'
import { DaemonLink } from './link.ts'
import { createNexoMcp } from './server.ts'
import { redact } from './text.ts'

const logger = (message: string): void => {
  process.stderr.write(`[nexo-mcp] ${redact(message)}\n`)
}

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig(process.env)
} catch (error) {
  logger(error instanceof ConfigError ? error.message : 'configuración no válida')
  process.exit(2)
}

const link = new DaemonLink({
  connect: () =>
    connectToDaemon({
      discovery: { env: process.env },
      client: { callTimeoutMs: 15_000 },
    }),
  logger,
})
const mcp = createNexoMcp({ link, config, logger })

let closing = false
const shutdown = (): void => {
  if (closing) return
  closing = true
  void mcp.close().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const)
  process.on(signal, shutdown)
// Cuando el cliente MCP cierra la tubería, el servidor termina.
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

await mcp.server.connect(new StdioServerTransport())
logger(
  `listo (escritura ${config.write ? 'permitida' : 'desactivada'}${config.write && config.allowPermissions ? ', con permisos' : ''})`,
)
