import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ChatCall = {
  model: string
  stream?: boolean
  format?: string
  messages: { role: string; content: string }[]
  options?: { temperature?: number; num_ctx?: number }
}

export type ChatHandler = (call: ChatCall, res: ServerResponse, req: IncomingMessage) => void

/** Contenido que devolvería un modelo sensato según lo que se le pide. */
export function sensibleChat(call: ChatCall, res: ServerResponse): void {
  const asksJson = call.format === 'json'
  const system = call.messages[0]?.content ?? ''
  const reflecting = system.includes('Reflector')
  const content = reflecting
    ? '- Resumen: el proyecto usa pnpm y vitest.'
    : asksJson
      ? JSON.stringify({
          observations: [
            { priority: 'high', scope: 'project', text: '2026-11-26 el proyecto usa pnpm' },
            { priority: 'medium', scope: 'session', text: '2026-11-26 se añadieron pruebas' },
          ],
        })
      : '- [alta] [proyecto] 2026-11-26 el proyecto usa pnpm'
  res.setHeader('content-type', 'application/json')
  res.end(
    JSON.stringify({
      model: call.model,
      message: { role: 'assistant', content },
      done: true,
      prompt_eval_count: 321,
      eval_count: 45,
      total_duration: 1_500_000_000,
    }),
  )
}

/** Servidor HTTP local que imita `/api/tags` y `/api/chat` (sin streaming). */
export class FakeOllama {
  readonly server: Server
  models: string[] = ['llama3.2:3b', 'qwen3:latest']
  tagsHandler: ((res: ServerResponse) => void) | undefined
  chatHandler: ChatHandler = sensibleChat
  readonly calls: ChatCall[] = []
  readonly paths: string[] = []
  #url = ''

  constructor() {
    this.server = createServer((req, res) => void this.#handle(req, res))
  }

  get url(): string {
    return this.#url
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.#url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.paths.push(`${req.method} ${req.url}`)
    if (req.url === '/api/tags' && req.method === 'GET') {
      if (this.tagsHandler !== undefined) return this.tagsHandler(res)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ models: this.models.map((name) => ({ name, model: name })) }))
      return
    }
    if (req.url === '/api/chat' && req.method === 'POST') {
      const body = await new Promise<string>((resolve) => {
        let s = ''
        req.on('data', (d: Buffer) => {
          s += d.toString('utf8')
        })
        req.on('end', () => resolve(s))
      })
      const call = JSON.parse(body) as ChatCall
      this.calls.push(call)
      this.chatHandler(call, res, req)
      return
    }
    res.statusCode = 404
    res.end('{}')
  }
}
