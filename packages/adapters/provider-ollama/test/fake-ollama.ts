import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Una petición `/api/chat` ya leída. */
export type ChatCall = {
  model: string
  messages: { role: string; content: string }[]
  think?: boolean
  stream?: boolean
}

export type ChatHandler = (call: ChatCall, res: ServerResponse, req: IncomingMessage) => void

export const nd = (...objects: unknown[]) => `${objects.map((o) => JSON.stringify(o)).join('\n')}\n`
export const chunk = (content: string, extra: Record<string, unknown> = {}) => ({
  model: 'm',
  message: { role: 'assistant', content, ...extra },
  done: false,
})
export const final = (extra: Record<string, unknown> = {}) => ({
  model: 'm',
  message: { role: 'assistant', content: '' },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 7,
  eval_count: 3,
  total_duration: 2_500_000,
  ...extra,
})

/** Servidor HTTP local que imita lo que usa el adaptador de Ollama (`/api/tags` y `/api/chat`). */
export class FakeOllama {
  readonly server: Server
  models: string[] = ['llama3.2:latest', 'qwen3:8b']
  /** Respuesta de `/api/tags` (sustituye a la lista de `models`). */
  tagsHandler: ((res: ServerResponse) => void) | undefined
  chatHandler: ChatHandler = defaultChat
  readonly calls: ChatCall[] = []
  readonly tagsHits: number[] = []
  /** Conexiones de `/api/chat` que el cliente cerró antes de que el servidor terminara. */
  aborted = 0
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
    if (req.url === '/api/tags' && req.method === 'GET') {
      this.tagsHits.push(Date.now())
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
      res.on('close', () => {
        if (!res.writableEnded) this.aborted++
      })
      this.chatHandler(call, res, req)
      return
    }
    res.statusCode = 404
    res.end('{"error":"not found"}')
  }
}

const lastUser = (call: ChatCall) => call.messages[call.messages.length - 1]?.content ?? ''

/** `long` no termina (hasta que el cliente corta); cualquier otro mensaje responde con razonamiento y texto. */
export const defaultChat: ChatHandler = (call, res) => {
  res.setHeader('content-type', 'application/x-ndjson')
  if (lastUser(call) === 'long') {
    res.write(nd(chunk('empiezo ')))
    return
  }
  res.write(nd(chunk('', { thinking: 'pienso' }), chunk('ho'), chunk('la')))
  res.end(nd(final()))
}
