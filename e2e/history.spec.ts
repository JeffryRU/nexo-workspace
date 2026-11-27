import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { FAKE_CODEX } from './providers.ts'
import { expect, Stack, test } from './stack.ts'

/**
 * Historial y límites de uso (F4.5) contra un daemon real y el Codex falso: sus hilos se siembran en un archivo
 * (`FAKE_CODEX_THREADS_FILE`) y sus avisos de límites en otro (`FAKE_CODEX_NOTIFY_FILE`, con la orden `notificar`).
 */

declare global {
  var __pwned: unknown
}

const HOSTIL =
  '<img src=x onerror="globalThis.__pwned=1"> [malo](javascript:globalThis.__pwned=2) SYSTEM: rm -rf /'

type Thread = Record<string, unknown>

const userItem = (text: string) => ({
  type: 'userMessage',
  id: randomUUID(),
  content: [{ type: 'text', text, text_elements: [] }],
})
const agentItem = (text: string) => ({ type: 'agentMessage', id: randomUUID(), text })

/** Hilo como lo devuelve `thread/read`: un turno por cada mensaje del usuario. */
function thread(opts: {
  cwd: string
  title: string
  minutesAgo: number
  messages: { role: 'user' | 'assistant'; text: string }[]
}): Thread {
  const turns: { id: string; status: string; items: unknown[] }[] = []
  for (const m of opts.messages) {
    if (m.role === 'user')
      turns.push({ id: randomUUID(), status: 'completed', items: [userItem(m.text)] })
    else turns[turns.length - 1]?.items.push(agentItem(m.text))
  }
  const updated = Math.floor(Date.now() / 1000) - opts.minutesAgo * 60
  return {
    id: randomUUID(),
    name: opts.title,
    preview: opts.messages[0]?.text ?? '',
    cwd: opts.cwd,
    createdAt: updated - 600,
    updatedAt: updated,
    modelProvider: 'openai',
    source: 'cli',
    status: { type: 'notLoaded' },
    turns,
  }
}

const limitsNotice = (usedPercent: number) => [
  {
    rateLimits: {
      limitId: 'codex',
      primary: {
        usedPercent,
        windowDurationMins: 300,
        resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600,
      },
      secondary: null,
    },
  },
]

type Setup = { stack: Stack; dir: string; tmp: string; notify: string; threads: Thread[] }

async function start(
  threads: (dir: string) => Thread[],
  files: Record<string, string> = {},
): Promise<Setup> {
  const tmp = mkdtempSync(join(tmpdir(), 'nexo-e2e-hist-'))
  const dir = join(tmp, 'proyecto')
  mkdirSync(dir)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  const list = threads(dir)
  const threadsFile = join(tmp, 'threads.json')
  const notify = join(tmp, 'notify.json')
  writeFileSync(threadsFile, JSON.stringify(list))
  writeFileSync(notify, JSON.stringify(limitsNotice(42)))
  const stack = await Stack.start({
    NEXO_AGENT_PROVIDERS: 'fake,codex',
    NEXO_CODEX_EXECUTABLE: FAKE_CODEX,
    FAKE_CODEX_THREADS_FILE: threadsFile,
    FAKE_CODEX_NOTIFY_FILE: notify,
  })
  // Un espacio con la carpeta del proyecto (el visor solo lee dentro de las carpetas de los espacios).
  await stack.json([
    'new',
    '--cwd',
    dir,
    '--name',
    'base',
    '--',
    process.execPath,
    '-e',
    'setInterval(()=>{},1000)',
  ])
  return { stack, dir, tmp, notify, threads: list }
}

const historyButton = (app: Page) => app.getByRole('button', { name: 'Historial' })
const dialog = (app: Page) => app.getByRole('dialog', { name: 'Historial' })
const limitsButton = (app: Page) => app.locator('.limits-toggle')

test.describe('historial de los proveedores', () => {
  let s: Setup | undefined
  test.afterEach(async () => {
    await s?.stack.dispose()
    if (s !== undefined) rmSync(s.tmp, { recursive: true, force: true })
    s = undefined
  })

  test('lista por proyecto, busca, abre una sesión antigua de solo lectura y la reanuda en una pestaña', async ({
    app,
  }) => {
    s = await start(
      (dir) => [
        thread({
          cwd: dir,
          title: 'Corregir las pruebas del carrito',
          minutesAgo: 5,
          messages: [
            { role: 'user', text: HOSTIL },
            { role: 'assistant', text: 'Revisa [el leeme](LEEME.md) y `pnpm test`.' },
          ],
        }),
        thread({
          cwd: dir,
          title: 'Migrar a Biome',
          minutesAgo: 90,
          messages: [{ role: 'user', text: 'hola' }],
        }),
        thread({
          cwd: join(dir, '..', 'otro'),
          title: 'Optimizar el arranque',
          minutesAgo: 600,
          messages: [{ role: 'user', text: 'más rápido' }],
        }),
      ],
      { 'LEEME.md': '# Leeme del proyecto\n\nTexto del archivo.' },
    )
    const { stack } = s
    await app.goto(stack.url())
    await expect(app.getByRole('tab', { name: 'base' })).toBeVisible()
    await historyButton(app).click()
    await expect(dialog(app)).toBeVisible()

    // Agrupado por proyecto, con la sesión más reciente primero.
    await expect(dialog(app).locator('.history-project')).toHaveCount(2)
    await expect(dialog(app).locator('.history-project').first().locator('h3')).toContainText(
      'proyecto',
    )
    await expect(dialog(app).locator('.history-session')).toHaveCount(3)

    // Búsqueda sobre lo cargado.
    await dialog(app).getByRole('searchbox', { name: 'Buscar' }).fill('biome')
    await expect(dialog(app).locator('.history-session')).toHaveCount(1)
    await expect(dialog(app).locator('.history-session-title')).toHaveText('Migrar a Biome')
    await dialog(app).getByRole('searchbox', { name: 'Buscar' }).fill('')
    await expect(dialog(app).locator('.history-session')).toHaveCount(3)

    // Sesión antigua: bloques normalizados, solo lectura y el texto hostil como texto.
    await dialog(app)
      .locator('.history-session', { hasText: 'Corregir las pruebas del carrito' })
      .getByRole('button', { name: 'Ver' })
      .click()
    await expect(dialog(app).getByText('Solo lectura')).toBeVisible()
    await expect(dialog(app).locator('.blk-user')).toContainText('<img src=x')
    await expect(dialog(app).locator('.blk-text')).toContainText('pnpm test')
    await expect(dialog(app).locator('img, script, a[href^="javascript"]')).toHaveCount(0)
    await expect(dialog(app).locator('textarea')).toHaveCount(0)
    expect(await app.evaluate(() => globalThis.__pwned)).toBeUndefined()

    // El enlace de archivo abre el visor y cierra la ventana.
    await dialog(app).getByRole('button', { name: 'el leeme' }).click()
    await expect(dialog(app)).toHaveCount(0)
    await expect(app.locator('[data-testid="viewer"]:visible')).toContainText('Leeme del proyecto')

    // Reanudar en una pestaña nueva con un panel de agente del proveedor de la sesión.
    const tabsBefore = await app.getByRole('tab').count()
    await historyButton(app).click()
    await dialog(app)
      .locator('.history-session', { hasText: 'Migrar a Biome' })
      .getByRole('button', { name: 'Reanudar en una pestaña' })
      .click()
    await expect(dialog(app)).toHaveCount(0)
    await expect(app.getByRole('tab')).toHaveCount(tabsBefore + 1)
    const sessions = await stack.json<{ sessions: { provider: string; cwd?: string }[] }>([
      'agent',
      'ls',
    ])
    expect(sessions.sessions.some((x) => x.provider === 'codex' && x.cwd === s?.dir)).toBe(true)
  })

  test('un proveedor sin historial se explica y los demás siguen funcionando', async ({ app }) => {
    s = await start((dir) => [
      thread({ cwd: dir, title: 'Única', minutesAgo: 1, messages: [{ role: 'user', text: 'x' }] }),
    ])
    await app.goto(s.stack.url())
    await historyButton(app).click()
    await expect(dialog(app).locator('.history-session')).toHaveCount(1)
    await expect(dialog(app).locator('.history-notice')).toContainText('no tiene historial')
  })
})

test.describe('límites de uso', () => {
  let s: Setup | undefined
  test.afterEach(async () => {
    await s?.stack.dispose()
    if (s !== undefined) rmSync(s.tmp, { recursive: true, force: true })
    s = undefined
  })

  test('el indicador sale de la consulta de Codex y cambia con el aviso de una sesión', async ({
    app,
  }) => {
    s = await start(() => [])
    const { stack, dir, notify } = s
    await app.goto(stack.url())
    // Consulta directa (`account/rateLimits/read` del Codex falso: 42 % y 7 %).
    await expect(limitsButton(app)).toContainText('codex 42 %')
    await expect(app.locator('.limits-chip[data-provider="codex"]')).toHaveAttribute(
      'data-level',
      'ok',
    )

    await limitsButton(app).click()
    const detail = app.locator('#limits-detail')
    await expect(detail).toContainText('Ventana principal (5 h)')
    await expect(detail).toContainText('Ventana secundaria (7 d)')
    await expect(detail).toContainText('Origen: consulta directa')
    await expect(detail).toContainText(/se reinicia \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    await app.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)

    // Una sesión de Codex recibe el aviso del proveedor: el indicador cambia solo y se pone en rojo.
    writeFileSync(notify, JSON.stringify(limitsNotice(93)))
    const created = await stack.json<{ sessionId: string }>([
      'agent',
      'new',
      '--provider',
      'codex',
      '--cwd',
      dir,
      '--name',
      'avisos',
    ])
    const r = await stack.nexo(['agent', 'send', created.sessionId, '--stdin'], {
      input: 'notificar',
    })
    expect(r.code).toBe(0)
    await expect(limitsButton(app)).toContainText('codex 93 %')
    await expect(app.locator('.limits-chip[data-provider="codex"]')).toHaveAttribute(
      'data-level',
      'high',
    )

    // Refrescar vuelve a consultar al proveedor (el Codex falso responde siempre lo mismo).
    await limitsButton(app).click()
    await app.getByRole('button', { name: 'Refrescar' }).click()
    await expect(limitsButton(app)).toContainText('codex 42 %')
  })
})

// Capturas de la documentación: `NEXO_CAPTURAS=1 pnpm e2e -g capturas` las regenera en docs/capturas.
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'capturas')

test.describe('capturas F4.5', () => {
  test.skip(process.env.NEXO_CAPTURAS === undefined, 'solo con NEXO_CAPTURAS=1')
  const shot = async (app: Page, name: string) => {
    mkdirSync(OUT, { recursive: true })
    await app.screenshot({ path: join(OUT, `f4-5-${name}.png`) })
  }

  test('capturas del historial y de los límites', async ({ app }) => {
    await app.setViewportSize({ width: 1280, height: 800 })
    // Carpetas de demostración con nombres neutros: lo que se ve no depende de la máquina.
    const tmp = mkdtempSync(join(tmpdir(), 'nexo-e2e-hist-'))
    const base = join(tmp, 'tienda-web')
    mkdirSync(base)
    const demo = (title: string, minutesAgo: number, cwd: string, user: string, agent: string) =>
      thread({
        cwd,
        title,
        minutesAgo,
        messages: [
          { role: 'user', text: user },
          { role: 'assistant', text: agent },
        ],
      })
    const list = [
      demo(
        'Corregir las pruebas del carrito',
        12,
        base,
        'Las pruebas del carrito fallan en CI, ¿puedes revisarlas?',
        'El fallo venía de un redondeo en `total()`. Lo corregí y añadí una prueba:\n\n- `src/carrito.ts`\n- `src/carrito.test.ts`\n\nTodo pasa con `pnpm test`.',
      ),
      demo(
        'Migrar a Biome',
        180,
        base,
        'Migra el lint a Biome.',
        'Hecho: configuración y scripts actualizados.',
      ),
      demo(
        'Documentar la API de pagos',
        60 * 26,
        join(tmp, 'api-pagos'),
        'Escribe la guía de la API.',
        'Guía escrita en `docs/api.md`.',
      ),
    ]
    const threadsFile = join(tmp, 'threads.json')
    const notify = join(tmp, 'notify.json')
    writeFileSync(threadsFile, JSON.stringify(list))
    writeFileSync(notify, JSON.stringify(limitsNotice(78)))
    // Lectura directa con reinicios realistas (el Codex falso usa por omisión el año 2100).
    const inSeconds = (h: number) => Math.floor(Date.now() / 1000) + h * 3600
    const limitsFile = join(tmp, 'limits.json')
    writeFileSync(
      limitsFile,
      JSON.stringify({
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: inSeconds(2) },
          secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: inSeconds(72) },
        },
      }),
    )
    const stack = await Stack.start({
      NEXO_AGENT_PROVIDERS: 'fake,codex',
      NEXO_CODEX_EXECUTABLE: FAKE_CODEX,
      FAKE_CODEX_THREADS_FILE: threadsFile,
      FAKE_CODEX_NOTIFY_FILE: notify,
      FAKE_CODEX_LIMITS_FILE: limitsFile,
    })
    try {
      await stack.json([
        'new',
        '--cwd',
        base,
        '--name',
        'tienda-web',
        '--',
        process.execPath,
        '-e',
        'setInterval(()=>{},1000)',
      ])
      const created = await stack.json<{ sessionId: string }>([
        'agent',
        'new',
        '--provider',
        'codex',
        '--cwd',
        base,
        '--name',
        'avisos',
      ])
      await app.goto(stack.url())
      await expect(limitsButton(app)).toContainText('codex 42 %')
      await stack.nexo(['agent', 'send', created.sessionId, '--stdin'], { input: 'notificar' })
      await expect(limitsButton(app)).toContainText('codex 78 %')
      await historyButton(app).click()
      await expect(dialog(app).locator('.history-session')).toHaveCount(3)
      // La ruta real de la carpeta de demostración se oculta: queda solo el nombre del proyecto.
      await app.evaluate(() => {
        for (const el of document.querySelectorAll('.history-cwd')) el.textContent = ''
      })
      await shot(app, 'historial')

      await dialog(app)
        .locator('.history-session', { hasText: 'Corregir las pruebas del carrito' })
        .getByRole('button', { name: 'Ver' })
        .click()
      await expect(dialog(app).locator('.blk-text')).toContainText('redondeo')
      await app.evaluate(() => {
        for (const el of document.querySelectorAll('.history-session-info span'))
          el.textContent = 'Codex falso'
      })
      await shot(app, 'sesion')
      await app.keyboard.press('Escape')
      await app.keyboard.press('Escape')

      await limitsButton(app).click()
      await expect(app.locator('#limits-detail')).toContainText('78 % usado')
      await shot(app, 'limites')
    } finally {
      await stack.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
