import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEFG'

/** Directorio de estado temporal con servidores /health falsos. */
export class StateFixture {
  readonly dir: string
  readonly #servers: Server[] = []

  private constructor(dir: string) {
    this.dir = dir
  }

  static async create(): Promise<StateFixture> {
    return new StateFixture(await mkdtemp(join(tmpdir(), 'nexo-client-')))
  }

  async cleanup(): Promise<void> {
    for (const s of this.#servers.splice(0)) {
      s.closeAllConnections()
      await new Promise((r) => s.close(r))
    }
    await rm(this.dir, { recursive: true, force: true })
  }

  /** Imita GET /health del daemon (o no, según las opciones); devuelve el puerto. */
  async health(
    options: { header?: string | null; status?: number; body?: string } = {},
  ): Promise<number> {
    const server = createServer((req, res) => {
      if (req.url !== '/health') {
        res.writeHead(404).end()
        return
      }
      const headers: Record<string, string> = {}
      if (options.header !== null) headers['x-nexo-daemon'] = options.header ?? '1'
      res.writeHead(options.status ?? 200, headers)
      res.end(options.body ?? '{"ok":true,"version":"0"}')
    })
    this.#servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return (server.address() as AddressInfo).port
  }

  async write(port: number, extra: Record<string, unknown> = {}): Promise<void> {
    await writeFile(
      join(this.dir, 'daemon.json'),
      JSON.stringify({
        version: '0',
        port,
        pid: 4242,
        startedAt: '2026-01-01T00:00:00.000Z',
        ...extra,
      }),
    )
    await writeFile(join(this.dir, 'token'), TOKEN)
  }
}
