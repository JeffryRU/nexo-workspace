import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test as base, type Page } from '@playwright/test'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const DAEMON_MAIN = join(root, 'apps/daemon/src/main.ts')
const CLI_MAIN = join(root, 'apps/cli/src/main.ts')
export const WEB_ORIGIN = 'http://localhost:5173'

export type CliResult = { code: number; stdout: string; stderr: string }

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolveConnect(true)
    })
    socket.once('error', () => resolveConnect(false))
  })
}

/** Un daemon real con su directorio de estado y un puerto fijo (para poder reiniciarlo en el mismo sitio). */
export class Stack {
  readonly dir: string
  readonly port: number
  readonly #env: Record<string, string>
  #daemon: ChildProcess | undefined

  private constructor(dir: string, port: number, env: Record<string, string>) {
    this.dir = dir
    this.port = port
    this.#env = env
  }

  /** `env` añade o cambia variables del daemon (p. ej. `NEXO_AGENT_PROVIDERS`, `NEXO_OLLAMA_URL`). */
  static async start(env: Record<string, string> = {}): Promise<Stack> {
    const stack = new Stack(await mkdtemp(join(tmpdir(), 'nexo-e2e-')), await freePort(), env)
    await stack.startDaemon()
    return stack
  }

  /** `true` mientras el daemon lanzado por esta pila sigue vivo. */
  get running(): boolean {
    return this.#daemon !== undefined
  }

  get token(): string {
    return readFileSync(join(this.dir, 'token'), 'utf8').trim()
  }

  /** Dirección con puerto y token (como la que imprime `pnpm dev:web`). */
  url(extra = ''): string {
    return `${WEB_ORIGIN}/?port=${this.port}&t=${this.token}${extra}`
  }

  async startDaemon(): Promise<void> {
    const child = spawn(process.execPath, [DAEMON_MAIN], {
      env: {
        ...process.env,
        NEXO_STATE_DIR: this.dir,
        NEXO_PORT: String(this.port),
        NEXO_DEV: '1',
        NEXO_LOG_LEVEL: 'error',
        // Proveedor de agente determinista (sin red ni modelo) para las pruebas del panel de agente.
        NEXO_AGENT_PROVIDERS: 'fake',
        ...this.#env,
      },
      stdio: 'ignore',
      windowsHide: true,
    })
    this.#daemon = child
    const end = Date.now() + 30_000
    while (!(existsSync(join(this.dir, 'token')) && (await canConnect(this.port)))) {
      if (child.exitCode !== null) throw new Error('el daemon terminó al arrancar')
      if (Date.now() > end) throw new Error('el daemon no arrancó a tiempo')
      await sleep(50)
    }
  }

  /** Mata el daemon de golpe (sin apagado ordenado), como una caída. */
  async killDaemon(): Promise<void> {
    const child = this.#daemon
    this.#daemon = undefined
    if (child === undefined || child.exitCode !== null) return
    const exited = new Promise<void>((r) => child.once('exit', () => r()))
    child.kill('SIGKILL')
    await exited
    while (await canConnect(this.port)) await sleep(50)
  }

  /** Ejecuta la CLI (`nexo`) como proceso hijo contra el mismo directorio de estado. */
  nexo(args: string[], options: { input?: string } = {}): Promise<CliResult> {
    return new Promise((resolveRun) => {
      const child = execFile(
        process.execPath,
        [CLI_MAIN, ...args],
        {
          env: { ...process.env, NEXO_STATE_DIR: this.dir, NEXO_LOG_LEVEL: 'error' },
          windowsHide: true,
          maxBuffer: 64 * 1024 * 1024,
          timeout: 60_000,
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
          resolveRun({ code, stdout, stderr })
        },
      )
      child.stdin?.end(options.input)
    })
  }

  async json<T = Record<string, string>>(args: string[]): Promise<T> {
    const [command = '', ...rest] = args
    const r = await this.nexo([command, '--json', ...rest])
    if (r.code !== 0) throw new Error(`nexo ${args.join(' ')} salió ${r.code}: ${r.stderr}`)
    return JSON.parse(r.stdout) as T
  }

  /** Crea una pestaña con un panel que ejecuta `node -e <script>`. */
  async newTab(
    name: string,
    script: string,
    workspace = 'e2e',
  ): Promise<{ paneId: string; tabId: string }> {
    return this.json([
      'new',
      '--workspace',
      workspace,
      '--name',
      name,
      '--',
      process.execPath,
      '-e',
      script,
    ])
  }

  async dispose(): Promise<void> {
    await this.killDaemon()
    await sleep(300)
    await rm(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

/** Imprime LISTO y repite lo que recibe como `eco:<json>` (igual que las pruebas de la CLI). */
export const ECHO_SCRIPT =
  "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('eco:'+JSON.stringify(d)+'\\n'));console.log('LISTO');setInterval(()=>{},1000)"

/** Texto completo (con el scrollback) del xterm del panel, leído del búfer de xterm. */
export async function bufferText(page: Page, paneId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const term = globalThis.__NEXO_E2E_TERMS__?.find(
      (t) => t.element.closest(`[data-pane-id="${id}"]`) !== null,
    )
    return term === undefined ? null : term.text()
  }, paneId)
}

declare global {
  // Misma declaración que apps/web (solo existe con `__NEXO_E2E__`).
  var __NEXO_PERF__: { tabSwitch: number[]; tabSwitchRaw: number[] } | undefined
  var __NEXO_E2E__: boolean | undefined
  var __NEXO_E2E_TERMS__: { element: HTMLElement; text: () => string }[] | undefined
}

type Fixtures = { stack: Stack; app: Page }

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright exige el patrón de desestructuración
  stack: async ({}, use) => {
    const stack = await Stack.start()
    try {
      await use(stack)
    } finally {
      await stack.dispose()
    }
  },
  app: async ({ page }, use) => {
    await page.addInitScript(() => {
      globalThis.__NEXO_E2E__ = true
    })
    await use(page)
  },
})

export { expect } from '@playwright/test'
