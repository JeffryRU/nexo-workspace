import { request } from 'node:http'

export const DAEMON_HEADER = 'x-nexo-daemon'

/** ¿Hay un daemon de Nexo vivo respondiendo `/health` en ese puerto de loopback? */
export function probeDaemon(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        let size = 0
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > 4096) res.destroy()
          else chunks.push(c)
        })
        res.on('error', () => resolve(false))
        res.on('close', () => {
          if (res.headers[DAEMON_HEADER] !== '1' || res.statusCode !== 200) return resolve(false)
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            resolve(typeof body === 'object' && body !== null && Reflect.get(body, 'ok') === true)
          } catch {
            resolve(false)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
    req.end()
  })
}
