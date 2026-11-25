import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStaticHandler, safeSegments } from './static.ts'

describe('safeSegments', () => {
  it('acepta rutas normales', () => {
    expect(safeSegments('/')).toEqual([])
    expect(safeSegments('/assets/app.js')).toEqual(['assets', 'app.js'])
    expect(safeSegments('/a/')).toEqual(['a'])
  })

  it('rechaza rutas hostiles', () => {
    for (const p of [
      '/../x',
      '/a/../../x',
      '/%2e%2e/x',
      '/%2E%2E/x',
      '/a%2f..%2fb',
      '/a\\b',
      '/%5c..%5cx',
      '/C:/Windows/win.ini',
      '/C%3A/x',
      '//etc/passwd',
      '/a//b',
      '/%00',
      '/a%00.js',
      '/%252e%252e/x',
      '/.env',
      '/.git/config',
      '/con',
      '/NUL.txt',
      '/a./b',
      '/x ',
      '/%zz',
      'sin-barra',
      '/\\\\?\\C:\\x',
    ]) {
      expect(safeSegments(p), p).toBeUndefined()
    }
  })
})

describe('servidor estático', () => {
  let root: string
  let outside: string
  let server: Server
  let port: number

  const get = (path: string, method = 'GET') =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          )
        })
        req.on('error', reject)
        req.end()
      },
    )

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'nexo-static-'))
    root = join(base, 'dist')
    outside = join(base, 'secreto.txt')
    await mkdir(join(root, 'assets'), { recursive: true })
    await mkdir(join(root, 'vacia'), { recursive: true })
    await writeFile(join(root, 'index.html'), '<h1>nexo</h1>')
    await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)')
    await writeFile(outside, 'SECRETO')
    try {
      await symlink(outside, join(root, 'enlace.txt'))
    } catch {
      // Sin permisos para enlaces simbólicos (Windows sin modo desarrollador).
    }
    const handler = createStaticHandler(root)
    server = createServer((req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    server.close()
    await rm(join(root, '..'), { recursive: true, force: true })
  })

  it('sirve index.html en / con cabeceras de seguridad', async () => {
    const r = await get('/')
    expect(r.status).toBe(200)
    expect(r.body).toBe('<h1>nexo</h1>')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'self'")
    expect(String(r.headers['content-security-policy'])).toContain("object-src 'none'")
    expect(r.headers['content-type']).toContain('text/html')
  })

  it('sirve archivos con su tipo y HEAD sin cuerpo', async () => {
    const r = await get('/assets/app.js')
    expect(r.headers['content-type']).toContain('text/javascript')
    const h = await get('/assets/app.js', 'HEAD')
    expect(h.status).toBe(200)
    expect(h.body).toBe('')
  })

  it('no lista directorios', async () => {
    expect((await get('/assets/')).status).toBe(404)
    expect((await get('/vacia')).status).toBe(404)
  })

  it('rechaza recorridos de ruta', async () => {
    for (const p of [
      '/..%2fsecreto.txt',
      '/%2e%2e/secreto.txt',
      '/..\\secreto.txt',
      '/C:/Windows/win.ini',
      '/%5c..%5csecreto.txt',
    ]) {
      const r = await get(p)
      expect([400, 404], p).toContain(r.status)
      expect(r.body).not.toContain('SECRETO')
    }
  })

  it('un enlace simbólico no escapa de la raíz', async () => {
    const r = await get('/enlace.txt')
    expect(r.body).not.toContain('SECRETO')
  })

  it('solo GET y HEAD', async () => {
    expect((await get('/', 'POST')).status).toBe(405)
    expect((await get('/', 'DELETE')).status).toBe(405)
  })

  it('sin raíz no maneja nada', async () => {
    const h = createStaticHandler(join(root, 'no-existe'))
    const res = await h({ method: 'GET', url: '/' } as never, {} as never)
    expect(res).toBe(false)
  })
})
