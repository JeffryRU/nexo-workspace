import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'

/**
 * Proveedores falsos para las pruebas con varios proveedores a la vez (F3.4): los mismos procesos y servidores
 * de las pruebas de cada adaptador. Un proveedor por pestaña de agente; todos emiten a la vez con la orden
 * `stream` (o `lento` en el proveedor de prueba del daemon).
 */
const here = dirname(fileURLToPath(import.meta.url))
const adapterTest = (adapter: string, file: string) =>
  resolve(here, '..', 'packages', 'adapters', adapter, 'test', file)

export const FAKE_CODEX = adapterTest('provider-codex', 'fake-codex.mjs')
export const FAKE_ACP = adapterTest('provider-acp', 'fake-acp.mjs')
export const FAKE_AGY = adapterTest('provider-antigravity', 'fake-agy.mjs')

export type StreamingOllama = { url: string; server: Server; close: () => Promise<void> }

/** Servidor que imita a Ollama (`/api/tags` y `/api/chat` en NDJSON) y emite `chunks` trozos, uno cada `everyMs`. */
export async function streamingOllama(chunks: number, everyMs: number): Promise<StreamingOllama> {
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen3:8b' }] }))
      return
    }
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/x-ndjson')
      let sent = 0
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer)
        if (sent < chunks) {
          sent++
          res.write(
            `${JSON.stringify({ message: { role: 'assistant', content: 'palabra ' }, done: false })}\n`,
          )
          return
        }
        clearInterval(timer)
        res.end(
          `${JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 9, eval_count: sent })}\n`,
        )
      }, everyMs)
      res.on('close', () => clearInterval(timer))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

/** Entorno del daemon con los cinco proveedores: el de prueba, Ollama, Codex, Gemini (ACP) y Antigravity. */
export function multiProviderEnv(
  ollamaUrl: string,
  stream: { chunks: number; everyMs: number },
): Record<string, string> {
  return {
    NEXO_AGENT_PROVIDERS: 'fake,ollama,codex,gemini,antigravity',
    NEXO_OLLAMA_URL: ollamaUrl,
    NEXO_CODEX_EXECUTABLE: FAKE_CODEX,
    NEXO_AGY_EXECUTABLE: FAKE_AGY,
    NEXO_ACP_AGENTS: JSON.stringify([
      { id: 'gemini', name: 'Gemini', command: FAKE_ACP, args: ['--acp'] },
    ]),
    FAKE_CODEX_STREAM_N: String(stream.chunks),
    FAKE_CODEX_STREAM_MS: String(stream.everyMs),
    FAKE_ACP_STREAM_N: String(stream.chunks),
    FAKE_ACP_STREAM_MS: String(stream.everyMs),
    FAKE_AGY_STREAM_N: String(stream.chunks),
    FAKE_AGY_STREAM_MS: String(stream.everyMs),
  }
}

/** Proveedores que se abren, cada uno con su orden de salida continua. */
export const STREAMING_PROVIDERS: readonly {
  id: string
  name: string
  prompt: (n: number) => string
}[] = [
  { id: 'fake', name: 'Proveedor de prueba', prompt: (n) => `lento ${n}` },
  { id: 'ollama', name: 'Ollama', prompt: () => 'habla' },
  { id: 'codex', name: 'Codex', prompt: () => 'stream' },
  { id: 'gemini', name: 'Gemini', prompt: () => 'stream' },
  { id: 'antigravity', name: 'Antigravity', prompt: () => 'stream' },
]

/**
 * Abre una pestaña de agente nueva (la nueva queda activa), elige el proveedor y envía el mensaje. Devuelve
 * cuando el panel ya muestra al usuario; la respuesta sigue llegando mientras se hace otra cosa.
 */
export async function startAgentTab(app: Page, provider: string, prompt: string): Promise<void> {
  await app.getByRole('button', { name: 'Nueva pestaña de agente' }).click()
  const panel = app.locator('.agent-panel:visible')
  await expect(panel).toHaveCount(1)
  await panel.getByLabel('Proveedor').selectOption(provider)
  const composer = panel.getByLabel('Mensaje para el agente')
  await composer.fill(prompt)
  await composer.press('Enter')
  await expect(panel.locator('.bubble')).toHaveText(prompt)
}
