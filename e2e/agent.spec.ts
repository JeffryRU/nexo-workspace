import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { ECHO_SCRIPT, expect, Stack, test } from './stack.ts'

declare global {
  var __pwned: unknown
}

/** Abre la interfaz con una pestaña de agente nueva (botón de la barra) y espera su redactor. */
async function openAgentTab(stack: Stack, app: Page): Promise<void> {
  await stack.newTab('base', ECHO_SCRIPT)
  await app.goto(stack.url())
  await expect(app.getByRole('tab', { name: 'base' })).toBeVisible()
  await app.getByRole('button', { name: 'Nueva pestaña de agente' }).click()
  await expect(app.locator('.agent-panel')).toBeVisible()
  // Los chips salen de `agent.providers` (proveedor falso del daemon).
  await expect(app.getByLabel('Proveedor')).toBeVisible()
}

const composer = (app: Page) => app.getByLabel('Mensaje para el agente')

async function say(app: Page, text: string): Promise<void> {
  await composer(app).fill(text)
  await composer(app).press('Enter')
}

test.describe('panel de agente', () => {
  test('conversación: el primer mensaje crea la sesión y la respuesta llega por deltas', async ({
    stack,
    app,
  }) => {
    await openAgentTab(stack, app)
    await say(app, 'hola agente')
    await expect(app.locator('.bubble')).toHaveText('hola agente')
    await expect(app.locator('.blk-text')).toContainText('Eco: hola agente')
    // Terminado el turno: sin botón de interrumpir, con el uso del turno y el redactor libre.
    await expect(app.locator('.usage')).toBeVisible()
    await expect(app.getByRole('button', { name: 'Interrumpir' })).toHaveCount(0)
    // Los chips pasan a ser de solo lectura al existir la sesión.
    await expect(app.locator('select.chip')).toHaveCount(0)
    await expect(app.locator('.chip.fixed').first()).toHaveText('fake')

    // Segundo turno, y el documento sobrevive a recargar la página (se vuelve a abrir la sesión).
    await say(app, 'otra vez')
    await expect(app.locator('.blk-text')).toHaveCount(2)
    await app.reload()
    await expect(app.locator('.bubble')).toHaveCount(2)
    await expect(app.locator('.blk-text').last()).toContainText('Eco: otra vez')
  })

  test('el Markdown de la respuesta se pinta y el HTML hostil no se ejecuta', async ({
    stack,
    app,
  }) => {
    await openAgentTab(stack, app)
    const md = [
      'Resumen',
      '## Título',
      'Hay **negrita**, `código` y un [enlace](https://example.com).',
      '<img src=x onerror="globalThis.__pwned=1"> [malo](javascript:globalThis.__pwned=2)',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n')
    await say(app, md)
    const answer = app.locator('.blk-text')
    await expect(answer.locator('strong')).toHaveText('negrita')
    await expect(answer.locator('table')).toBeVisible()
    await expect(answer.locator('a[href="https://example.com/"]')).toBeVisible()
    await expect(answer.locator('img, script, a[href^="javascript"]')).toHaveCount(0)
    expect(await app.evaluate(() => globalThis.__pwned)).toBeUndefined()
  })

  test('permiso: se responde con el teclado y la acción termina', async ({ stack, app }) => {
    await openAgentTab(stack, app)
    await say(app, 'permiso')
    const perm = app.locator('section.perm.pending')
    await expect(perm).toBeVisible()
    await expect(perm.locator('.perm-option')).toHaveCount(2)
    await expect(app.locator('.agent-banner.pending')).toContainText('1 pendiente')
    await expect(composer(app)).toBeEnabled()
    // El atajo de navegación lleva el foco al permiso; «1» elige Permitir.
    await composer(app).press('Alt+Shift+ArrowDown')
    await expect(perm.locator('.perm-option').first()).toBeFocused()
    await app.keyboard.press('1')
    await expect(app.locator('.perm-result')).toContainText('Permitido')
    await expect(app.locator('.blk-text').last()).toContainText('Permiso concedido')
    await expect(app.locator('.blk-action .status-icon')).toHaveAttribute('aria-label', 'Correcta')
    await app.locator('.blk-action .fold-head').click()
    await expect(app.locator('.blk-action .fold-body')).toContainText('a.txt')
  })

  test('permiso rechazado con el ratón', async ({ stack, app }) => {
    await openAgentTab(stack, app)
    await say(app, 'permiso')
    await app.getByRole('button', { name: /Rechazar/ }).click()
    await expect(app.locator('.blk-text').last()).toContainText('Permiso rechazado')
    await expect(app.locator('.perm-result')).toContainText('Rechazado')
  })

  test('pregunta: se elige una opción y se responde', async ({ stack, app }) => {
    await openAgentTab(stack, app)
    await say(app, 'pregunta')
    const form = app.locator('form.ask.pending')
    await expect(form).toBeVisible()
    await expect(form.getByRole('button', { name: 'Responder' })).toBeDisabled()
    await form.getByLabel('B', { exact: true }).check()
    await form.getByRole('button', { name: 'Responder' }).click()
    await expect(app.locator('.blk-text').last()).toContainText('Elegiste: B')
    await expect(app.locator('form.ask[data-state="answered"]')).toBeVisible()
  })

  test('interrupción: el botón corta un turno que no termina', async ({ stack, app }) => {
    await openAgentTab(stack, app)
    await say(app, 'largo')
    const stop = app.getByRole('button', { name: 'Interrumpir' })
    await expect(stop).toBeVisible()
    await expect(app.locator('.blk-text')).toContainText('pensando')
    await stop.click()
    await expect(stop).toHaveCount(0)
    await expect(app.locator('.usage')).toContainText('Interrumpido')
    // Tras interrumpir se puede seguir conversando.
    await say(app, 'ya')
    await expect(app.locator('.blk-text').last()).toContainText('Eco: ya')
  })

  test('un documento largo en streaming: solo se dibuja una ventana y se sigue el final', async ({
    stack,
    app,
  }) => {
    await openAgentTab(stack, app)
    await say(app, 'lento 400')
    await expect(app.locator('.usage')).toBeVisible({ timeout: 60_000 })
    await expect(app.locator('.blk-text')).toContainText('palabra palabra')
  })

  test('el atajo Alt+Mayús+A abre una pestaña de agente', async ({ stack, app }) => {
    await stack.newTab('base', ECHO_SCRIPT)
    await app.goto(stack.url())
    await expect(app.getByRole('tab', { name: 'base' })).toBeVisible()
    await app.locator('.xterm').first().click()
    await app.keyboard.press('Alt+Shift+A')
    await expect(app.locator('.agent-panel')).toBeVisible()
    await expect(app.getByRole('tab')).toHaveCount(2)
  })
})

type FakeNotice = { title: string; body: string; tag: string }
type NoticeApi = { __notices: FakeNotice[]; __noticeClicks: (() => void)[]; __blurred: boolean }

/**
 * Sustituye la API `Notification` por una falsa que anota lo que se mostraría (un navegador sin cabeza no puede
 * mostrar avisos del sistema) y deja simular que la ventana pierde o recupera el foco.
 */
async function installFakeNotifications(app: Page): Promise<void> {
  await app.addInitScript(() => {
    const w = globalThis as unknown as NoticeApi & { Notification: unknown }
    w.__notices = []
    w.__noticeClicks = []
    w.__blurred = false
    document.hasFocus = () => !w.__blurred
    class FakeNotification {
      static permission = 'default'
      static async requestPermission() {
        FakeNotification.permission = 'granted'
        return 'granted'
      }
      onclick: (() => void) | null = null
      constructor(title: string, options?: { body?: string; tag?: string }) {
        w.__notices.push({ title, body: options?.body ?? '', tag: options?.tag ?? '' })
        w.__noticeClicks.push(() => this.onclick?.())
      }
      close() {}
    }
    Object.defineProperty(w, 'Notification', { value: FakeNotification, configurable: true })
  })
}

/** La ventana pierde (`false`) o recupera (`true`) el foco, como lo verían el navegador y el WebView. */
async function setWindowFocus(app: Page, focused: boolean): Promise<void> {
  await app.evaluate((f) => {
    ;(globalThis as unknown as NoticeApi).__blurred = !f
    window.dispatchEvent(new Event(f ? 'focus' : 'blur'))
  }, focused)
}

const notices = (app: Page) =>
  app.evaluate(() => (globalThis as unknown as NoticeApi).__notices.map((n) => ({ ...n })))

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Con una terminal («base») y una pestaña de agente, el agente es la segunda. */
const agentTab = (app: Page) => app.getByRole('tab').nth(1)
const baseTab = (app: Page) => app.getByRole('tab', { name: 'base' })
const agentTabWrap = (app: Page) => app.locator('.tablist .tab-wrap').nth(1)

test.describe('acciones con diff y salida ANSI', () => {
  test('editar: la acción edit muestra su diff unificado con líneas añadidas y borradas', async ({
    stack,
    app,
  }) => {
    await openAgentTab(stack, app)
    await say(app, 'editar')
    await expect(app.locator('.blk-text').last()).toContainText('Edición aplicada')
    await app.locator('.blk-action .fold-head').click()
    const diff = app.locator('.blk-action .diff')
    await expect(diff.locator('.diff-stats .add')).toHaveText('+1')
    await expect(diff.locator('.diff-stats .del')).toHaveText('−1')
    await expect(diff.locator('.diff-add')).toContainText('const port = 4317')
    await expect(diff.locator('.diff-del')).toContainText('const port = 3000')
    await expect(diff.locator('.diff-hunk')).toContainText('@@ -1,4 +1,4 @@')
  })

  test('ansi: los colores se traducen a clases y las secuencias de control no se ven', async ({
    stack,
    app,
  }) => {
    await openAgentTab(stack, app)
    await say(app, 'ansi')
    await expect(app.locator('.blk-text').last()).toContainText('Salida con colores')
    await app.locator('.blk-action .fold-head').click()
    const out = app.locator('.blk-action pre.output')
    await expect(out.locator('.ansi-fg-1')).toHaveText('error')
    await expect(out.locator('.ansi-fg-2.ansi-bold')).toHaveText('ok')
    await expect(out.locator('.ansi-fg-3.ansi-dim')).toHaveText('aviso')
    const text = (await out.textContent()) ?? ''
    expect(text).not.toContain('[')
    expect(text).toContain('error: falló')
  })
})

test.describe('atención en la barra y en las pestañas', () => {
  test('un permiso pendiente se ve en la pestaña, la barra y el título; el atajo lleva al panel', async ({
    stack,
    app,
  }) => {
    await openAgentTab(stack, app)
    await say(app, 'permiso')
    await expect(app.locator('section.perm.pending')).toBeVisible()
    // Se aleja a la terminal: la pestaña del agente queda en segundo plano pidiendo respuesta.
    await baseTab(app).click()
    const tab = agentTabWrap(app)
    await expect(tab).toHaveAttribute('data-attention', 'needs-input')
    await expect(tab.locator('.attention-count')).toHaveText('1')
    await expect(app.locator('.tab-row .attention-dot[data-attention="needs-input"]')).toHaveCount(
      1,
    )
    await expect(app.locator('.ws-row .attention-count')).toHaveText('1')
    await expect(app).toHaveTitle('(1) Nexo Workspace')
    // Alt+Mayús+N salta al panel que necesita atención.
    await app.locator('.xterm').first().click()
    await app.keyboard.press('Alt+Shift+N')
    await expect(agentTab(app)).toHaveAttribute('aria-selected', 'true')
    await expect(app.locator('section.perm.pending')).toBeVisible()
    await app.getByRole('button', { name: /Permitir/ }).click()
    await expect(app.locator('.blk-text').last()).toContainText('Permiso concedido')
    await expect(app).toHaveTitle('Nexo Workspace')
  })

  test('terminado: se queda marcado en la pestaña hasta enfocar el panel', async ({
    stack,
    app,
  }) => {
    await openAgentTab(stack, app)
    await say(app, 'lento 120')
    await baseTab(app).click()
    const tab = agentTabWrap(app)
    await expect(tab).toHaveAttribute('data-attention', 'done', { timeout: 30_000 })
    await expect(app).toHaveTitle('(1) Nexo Workspace')
    // Al volver al panel con la ventana a la vista el aviso desaparece.
    await agentTab(app).click()
    await expect(tab).toHaveAttribute('data-attention', 'idle')
    await expect(app).toHaveTitle('Nexo Workspace')
  })

  test('mientras trabaja la pestaña muestra working y al interrumpir vuelve a reposo', async ({
    stack,
    app,
  }) => {
    await openAgentTab(stack, app)
    await say(app, 'largo')
    await baseTab(app).click()
    await expect(agentTabWrap(app)).toHaveAttribute('data-attention', 'working')
    await agentTab(app).click()
    await app.getByRole('button', { name: 'Interrumpir' }).click()
    await expect(agentTabWrap(app)).toHaveAttribute('data-attention', 'idle')
  })
})

test.describe('notificaciones del sistema', () => {
  test('con la ventana sin foco avisa una vez, su clic enfoca el panel y responder no hace spam', async ({
    stack,
    app,
  }) => {
    await installFakeNotifications(app)
    await openAgentTab(stack, app)
    await app.getByRole('button', { name: 'Notificaciones desactivadas' }).click()
    await expect(app.getByRole('button', { name: 'Notificaciones activadas' })).toBeVisible()
    // Primer mensaje (crea la sesión) y se vuelve a la terminal; luego la ventana pierde el foco.
    await say(app, 'hola')
    await expect(app.locator('.usage')).toBeVisible()
    await pause(500)
    await baseTab(app).click()
    await setWindowFocus(app, false)
    await agentTab(app).click()
    await say(app, 'pregunta')
    await expect(app.locator('form.ask.pending')).toBeVisible()
    await baseTab(app).click()
    await expect.poll(async () => (await notices(app)).length, { timeout: 20_000 }).toBe(1)
    const [n] = await notices(app)
    expect(n?.title).toBe('Necesita tu respuesta')
    expect(n?.body).toContain('e2e')
    expect(n?.tag.startsWith('nexo-pane-')).toBe(true)
    await app.evaluate(() => (globalThis as unknown as NoticeApi).__noticeClicks[0]?.())
    await expect(agentTab(app)).toHaveAttribute('aria-selected', 'true')
    const form = app.locator('form.ask.pending')
    await expect(form).toBeVisible()
    // Responder y terminar el turno dentro de la espera por panel no dispara otro aviso.
    await form.getByLabel('B', { exact: true }).check()
    await form.getByRole('button', { name: 'Responder' }).click()
    await expect(app.locator('.blk-text').last()).toContainText('Elegiste: B')
    await pause(2500)
    expect(await notices(app)).toHaveLength(1)
  })

  test('con la ventana a la vista o el ajuste apagado no avisa', async ({ stack, app }) => {
    await installFakeNotifications(app)
    await openAgentTab(stack, app)
    // Ajuste apagado y ventana sin foco: nada.
    await setWindowFocus(app, false)
    await say(app, 'lento 10')
    await expect(app.locator('.usage')).toBeVisible()
    await pause(2500)
    expect(await notices(app)).toHaveLength(0)
    // Ajuste encendido y ventana a la vista: tampoco.
    await app.getByRole('button', { name: 'Notificaciones desactivadas' }).click()
    await expect(app.getByRole('button', { name: 'Notificaciones activadas' })).toBeVisible()
    await setWindowFocus(app, true)
    await say(app, 'lento 10')
    await expect(app.locator('.usage')).toHaveCount(2)
    await pause(2500)
    expect(await notices(app)).toHaveLength(0)
  })
})

/** Servidor HTTP que imita lo que usa el proveedor Ollama: `/api/tags` y `/api/chat` en NDJSON. */
async function fakeOllama(): Promise<{ url: string; server: Server; chats: unknown[] }> {
  const chats: unknown[] = []
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen3:8b' }] }))
      return
    }
    let body = ''
    req.on('data', (d: Buffer) => {
      body += d.toString('utf8')
    })
    req.on('end', () => {
      chats.push(JSON.parse(body))
      const line = (o: unknown) => `${JSON.stringify(o)}
`
      res.setHeader('content-type', 'application/x-ndjson')
      res.write(
        line({
          message: { role: 'assistant', content: '', thinking: 'Pienso la respuesta.' },
          done: false,
        }),
      )
      res.write(line({ message: { role: 'assistant', content: 'Hola desde ' }, done: false }))
      res.write(line({ message: { role: 'assistant', content: 'Ollama.' }, done: false }))
      res.end(line({ message: { content: '' }, done: true, prompt_eval_count: 9, eval_count: 4 }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, chats }
}

test.describe('proveedor Ollama (servidor falso)', () => {
  test('se elige proveedor, modelo y esfuerzo según agent.providers y la conversación funciona', async ({
    app,
  }) => {
    const ollama = await fakeOllama()
    const stack = await Stack.start({
      NEXO_AGENT_PROVIDERS: 'fake,ollama',
      NEXO_OLLAMA_URL: ollama.url,
    })
    try {
      await openAgentTab(stack, app)
      await app.getByLabel('Proveedor').selectOption('ollama')
      await expect(app.getByLabel('Modelo')).toHaveValue('llama3.2:latest')
      await expect(app.getByLabel('Modelo').locator('option')).toHaveText([
        'llama3.2:latest',
        'qwen3:8b',
      ])
      await app.getByLabel('Modelo').selectOption('qwen3:8b')
      await app.getByLabel('Esfuerzo').selectOption('think')
      await say(app, 'hola')
      await expect(app.locator('.blk-text')).toContainText('Hola desde Ollama.')
      await expect(app.locator('.blk-reasoning')).toBeVisible()
      await expect(app.locator('.usage')).toBeVisible()
      await expect(app.locator('.chip.fixed').first()).toHaveText('Ollama')
      expect(ollama.chats[0]).toMatchObject({ model: 'qwen3:8b', think: true, stream: true })
      await say(app, 'otra')
      await expect(app.locator('.blk-text')).toHaveCount(2)
      expect((ollama.chats[1] as { messages: unknown[] }).messages).toHaveLength(3)
    } finally {
      await stack.dispose()
      ollama.server.close()
    }
  })

  test('si Ollama no responde se ve deshabilitado con su motivo y queda el proveedor por omisión', async ({
    app,
  }) => {
    const stack = await Stack.start({
      NEXO_AGENT_PROVIDERS: 'fake,ollama',
      NEXO_OLLAMA_URL: 'http://127.0.0.1:1',
    })
    try {
      await openAgentTab(stack, app)
      const option = app.getByLabel('Proveedor').locator('option[value="ollama"]')
      await expect(option).toBeDisabled()
      await expect(option).toHaveText('Ollama (no disponible)')
      await expect(app.getByRole('note')).toContainText('Ollama no responde en http://127.0.0.1:1')
      await expect(app.getByLabel('Proveedor')).toHaveValue('fake')
      await say(app, 'sigue funcionando')
      await expect(app.locator('.blk-text')).toContainText('Eco: sigue funcionando')
    } finally {
      await stack.dispose()
    }
  })
})

/** Servidor  falso (el mismo de las pruebas del adaptador): habla JSON-RPC por stdio. */
const FAKE_CODEX = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'adapters',
  'provider-codex',
  'test',
  'fake-codex.mjs',
)

test.describe('proveedor Codex (app-server falso)', () => {
  test('se elige Codex, la aprobación de un comando se responde en línea y los items salen como bloques', async ({
    app,
  }) => {
    const stack = await Stack.start({
      NEXO_AGENT_PROVIDERS: 'fake,codex',
      NEXO_CODEX_EXECUTABLE: FAKE_CODEX,
    })
    try {
      await openAgentTab(stack, app)
      await app.getByLabel('Proveedor').selectOption('codex')
      await expect(app.getByLabel('Modelo').locator('option')).toHaveText(['GPT Fake', 'GPT Mini'])
      await app.getByLabel('Esfuerzo').selectOption('high')
      await say(app, 'permiso')
      await expect(app.locator('section.perm.pending')).toBeVisible()
      await expect(app.locator('section.perm.pending')).toContainText('Ejecutar: rm -rf build')
      await expect(app.locator('.chip.fixed').first()).toHaveText('Codex')
      await app.getByRole('button', { name: '1 Permitir', exact: true }).click()
      await expect(app.locator('.blk-text').last()).toContainText('Hecho.')
      await expect(app.locator('.usage')).toBeVisible()
      await say(app, 'rich')
      await expect(app.locator('.blk-reasoning')).toBeVisible()
      await expect(app.locator('.blk-action')).toHaveCount(5)
    } finally {
      await stack.dispose()
    }
  })

  test('sin sesión iniciada Codex sale deshabilitado con el motivo, sin repetir el nombre', async ({
    app,
  }) => {
    const stack = await Stack.start({
      NEXO_AGENT_PROVIDERS: 'fake,codex',
      NEXO_CODEX_EXECUTABLE: FAKE_CODEX,
      FAKE_CODEX_LOGGED_OUT: '1',
    })
    try {
      await openAgentTab(stack, app)
      const option = app.getByLabel('Proveedor').locator('option[value="codex"]')
      await expect(option).toBeDisabled()
      await expect(app.getByRole('note')).toContainText('Codex no tiene la sesión iniciada')
      await expect(app.getByRole('note')).not.toContainText('Codex: Codex')
    } finally {
      await stack.dispose()
    }
  })
})

// Capturas de la documentación: `NEXO_CAPTURAS=1 pnpm e2e -g capturas` las regenera en docs/capturas.
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'capturas')

test.describe('capturas', () => {
  test.skip(process.env.NEXO_CAPTURAS === undefined, 'solo con NEXO_CAPTURAS=1')
  const shot = async (app: Page, name: string, prefix = 'f2-5') => {
    // La carpeta real es la del entorno donde corre la prueba: se sustituye por una neutra en la captura.
    await app.evaluate(() => {
      for (const el of document.querySelectorAll('.chip.fixed.ellipsis'))
        el.textContent = '~/proyecto'
      for (const el of document.querySelectorAll<HTMLInputElement>('.chip-cwd')) {
        el.placeholder = '~/proyecto'
      }
    })
    mkdirSync(OUT, { recursive: true })
    await app.screenshot({ path: join(OUT, `${prefix}-${name}.png`) })
  }

  test('capturas del panel de agente', async ({ stack, app }) => {
    await app.setViewportSize({ width: 1280, height: 800 })
    await openAgentTab(stack, app)
    await shot(app, 'inicio-chips')

    await say(
      app,
      [
        'Resumen del cambio',
        '## Qué se hizo',
        '- Se añadió el **panel de agente** con `AgentDocument`',
        '- Markdown seguro: `<script>` y [javascript:](javascript:alert(1)) no hacen nada',
        '',
        '```ts',
        'const total = bloques.length // solo se dibujan los visibles',
        '```',
        '',
        '| Bloque | Estado |',
        '|---|---|',
        '| user | listo |',
        '| action | plegable |',
      ].join('\n'),
    )
    await expect(app.locator('.usage')).toBeVisible()
    await shot(app, 'conversacion')

    await say(app, 'permiso')
    await expect(app.locator('section.perm.pending')).toBeVisible()
    await shot(app, 'permiso')
    await app.getByRole('button', { name: /Permitir/ }).click()
    await expect(app.locator('.blk-text').last()).toContainText('Permiso concedido')
    await app.locator('.blk-action .fold-head').click()
    await shot(app, 'accion')

    await say(app, 'pregunta')
    await expect(app.locator('form.ask.pending')).toBeVisible()
    await shot(app, 'pregunta')
  })

  test('capturas del selector de proveedor y modelo (F3.1)', async ({ app }) => {
    await app.setViewportSize({ width: 1280, height: 800 })
    const ollama = await fakeOllama()
    const stack = await Stack.start({
      NEXO_AGENT_PROVIDERS: 'fake,ollama',
      NEXO_OLLAMA_URL: ollama.url,
    })
    try {
      await openAgentTab(stack, app)
      await app.getByLabel('Proveedor').selectOption('ollama')
      await app.getByLabel('Modelo').selectOption('qwen3:8b')
      await app.getByLabel('Esfuerzo').selectOption('think')
      await shot(app, 'selector', 'f3-1')
      await say(app, 'hola')
      await expect(app.locator('.usage')).toBeVisible()
      await shot(app, 'conversacion', 'f3-1')
    } finally {
      await stack.dispose()
      ollama.server.close()
    }
    const down = await Stack.start({
      NEXO_AGENT_PROVIDERS: 'fake,ollama',
      NEXO_OLLAMA_URL: 'http://127.0.0.1:1',
    })
    try {
      await app.goto('about:blank')
      await openAgentTab(down, app)
      await expect(app.getByRole('note')).toBeVisible()
      await shot(app, 'no-disponible', 'f3-1')
    } finally {
      await down.dispose()
    }
  })

  test('capturas del proveedor Codex (F3.2)', async ({ app }) => {
    await app.setViewportSize({ width: 1280, height: 800 })
    const stack = await Stack.start({
      NEXO_AGENT_PROVIDERS: 'fake,codex',
      NEXO_CODEX_EXECUTABLE: FAKE_CODEX,
    })
    try {
      await openAgentTab(stack, app)
      await app.getByLabel('Proveedor').selectOption('codex')
      await app.getByLabel('Esfuerzo').selectOption('high')
      await shot(app, 'selector', 'f3-2')
      await say(app, 'permiso')
      await expect(app.locator('section.perm.pending')).toBeVisible()
      await shot(app, 'aprobacion', 'f3-2')
      await app.getByRole('button', { name: '1 Permitir', exact: true }).click()
      await expect(app.locator('.blk-text').last()).toContainText('Hecho.')
      await say(app, 'rich')
      await expect(app.locator('.blk-action')).toHaveCount(5)
      await shot(app, 'acciones', 'f3-2')
    } finally {
      await stack.dispose()
    }
    const out = await Stack.start({
      NEXO_AGENT_PROVIDERS: 'fake,codex',
      NEXO_CODEX_EXECUTABLE: FAKE_CODEX,
      FAKE_CODEX_LOGGED_OUT: '1',
    })
    try {
      await app.goto('about:blank')
      await openAgentTab(out, app)
      await expect(app.getByRole('note')).toBeVisible()
      await shot(app, 'sin-sesion', 'f3-2')
    } finally {
      await out.dispose()
    }
  })

  test('capturas de la atención, el diff y la salida ANSI (F2.6)', async ({ stack, app }) => {
    await app.setViewportSize({ width: 1280, height: 800 })
    await openAgentTab(stack, app)
    await say(app, 'editar')
    await expect(app.locator('.blk-text').last()).toContainText('Edición aplicada')
    await app.locator('.blk-action .fold-head').click()
    await expect(app.locator('.blk-action .diff')).toBeVisible()
    await shot(app, 'diff', 'f2-6')
    await app.locator('.blk-action .fold-head').click()

    await say(app, 'ansi')
    await expect(app.locator('.blk-text').last()).toContainText('Salida con colores')
    await app.locator('.blk-action').last().locator('.fold-head').click()
    await expect(app.locator('.blk-action pre.output').last()).toBeVisible()
    await shot(app, 'ansi', 'f2-6')

    // Un permiso pendiente con la terminal a la vista: punto de alerta, contador y título con el número.
    await say(app, 'permiso')
    await expect(app.locator('section.perm.pending')).toBeVisible()
    await baseTab(app).click()
    await expect(agentTabWrap(app)).toHaveAttribute('data-attention', 'needs-input')
    await expect(app).toHaveTitle('(1) Nexo Workspace')
    await shot(app, 'atencion', 'f2-6')
  })
})
