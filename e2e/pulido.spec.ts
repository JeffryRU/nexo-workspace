import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { tinyCompanion } from '../packages/testkit/src/companion-package.ts'
import { FAKE_CODEX } from './providers.ts'
import { ECHO_SCRIPT, expect, Stack, test } from './stack.ts'

/**
 * Pulido visual (F5.4): la interfaz a varios anchos, con las vistas principales (terminal con tres paneles, agente
 * con chips y con un permiso, historial, memoria, mascota, visor y barra lateral). Comprueba que nada desborda en
 * horizontal, que los botones clave se ven y se pueden pulsar a 360 px y, con `NEXO_CAPTURAS=1`, saca las capturas
 * de la documentación (`NEXO_CAPTURAS_PREFIX` cambia el prefijo del nombre; `NEXO_CAPTURAS_DIR`, la carpeta).
 */

const WIDTHS = [
  { width: 360, height: 640 },
  { width: 768, height: 900 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
] as const

const OUT =
  process.env.NEXO_CAPTURAS_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'capturas')
const PREFIX = process.env.NEXO_CAPTURAS_PREFIX ?? 'f5-4-'
const CAPTURE = process.env.NEXO_CAPTURAS !== undefined

const MEMORY_FILLER = 'Usamos pnpm y Biome en este proyecto. '.repeat(120)

type Scene = { stack: Stack; dir: string; tmp: string; viewerPane: string }

const thread = (cwd: string, title: string, minutesAgo: number, user: string, agent: string) => {
  const updated = Math.floor(Date.now() / 1000) - minutesAgo * 60
  const id = `00000000-0000-4000-8000-${String(minutesAgo).padStart(12, '0')}`
  return {
    id,
    name: title,
    preview: user,
    cwd,
    createdAt: updated - 600,
    updatedAt: updated,
    modelProvider: 'openai',
    source: 'cli',
    status: { type: 'notLoaded' },
    turns: [
      {
        id: `${id}-t`,
        status: 'completed',
        items: [
          {
            type: 'userMessage',
            id: `${id}-u`,
            content: [{ type: 'text', text: user, text_elements: [] }],
          },
          { type: 'agentMessage', id: `${id}-a`, text: agent },
        ],
      },
    ],
  }
}

async function buildScene(): Promise<Scene> {
  const tmp = mkdtempSync(join(tmpdir(), 'nexo-e2e-pulido-'))
  const dir = join(tmp, 'tienda-web')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'LEEME.md'),
    '# Tienda web\n\nCatálogo y carrito.\n\n- `src/carrito.ts`\n- `src/pagos.ts`\n\n| Módulo | Pruebas | Cobertura |\n|---|---:|---:|\n| carrito | 42 | 96 % |\n| pagos | 18 | 91 % |\n',
  )
  const threads = [
    thread(
      dir,
      'Corregir las pruebas del carrito',
      12,
      'Las pruebas del carrito fallan en CI.',
      'El fallo venía de un redondeo en `total()`. Lo corregí y añadí una prueba.',
    ),
    thread(
      dir,
      'Migrar a Biome',
      180,
      'Migra el lint a Biome.',
      'Hecho: configuración y scripts actualizados.',
    ),
    thread(
      join(tmp, 'api-pagos'),
      'Documentar la API de pagos con un título bastante largo para comprobar el recorte',
      60 * 26,
      'Escribe la guía de la API.',
      'Guía escrita en `docs/api.md`.',
    ),
  ]
  const threadsFile = join(tmp, 'threads.json')
  writeFileSync(threadsFile, JSON.stringify(threads))
  const limitsFile = join(tmp, 'limits.json')
  const inSeconds = (h: number) => Math.floor(Date.now() / 1000) + h * 3600
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
    FAKE_CODEX_LIMITS_FILE: limitsFile,
    NEXO_MEMORY: 'on',
    NEXO_MEMORY_SUMMARIZER: 'fake',
    NEXO_MEMORY_OBSERVER_TOKENS: '500',
    NEXO_MEMORY_REFLECTOR_TOKENS: '100000',
  })
  // Mascota de prueba instalada antes de abrir la interfaz.
  for (const [rel, data] of Object.entries(tinyCompanion())) {
    const file = join(stack.dir, 'companions', 'tiny', ...rel.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, data)
  }
  const make = (name: string, script: string) =>
    stack.json<{ paneId: string; tabId: string }>([
      'new',
      '--cwd',
      dir,
      '--workspace',
      'tienda-web',
      '--name',
      name,
      '--',
      process.execPath,
      '-e',
      script,
    ])
  const base = await make('base', ECHO_SCRIPT)
  const second = await stack.json<{ paneId: string }>([
    'split',
    base.paneId,
    '--right',
    '--',
    process.execPath,
    '-e',
    ECHO_SCRIPT,
  ])
  await stack.json(['split', second.paneId, '--down', '--', process.execPath, '-e', ECHO_SCRIPT])
  const viewer = await make('visor', ECHO_SCRIPT)
  await stack.json(['agent', 'new', '--provider', 'fake', '--cwd', dir, '--name', 'permiso'])
  const memorySession = await stack.json<{ sessionId: string }>([
    'agent',
    'new',
    '--provider',
    'fake',
    '--cwd',
    dir,
    '--name',
    'memoria',
  ])
  for (const text of [`Elegimos pnpm. ${MEMORY_FILLER}`, `Biome formatea todo. ${MEMORY_FILLER}`]) {
    const r = await stack.nexo(['agent', 'send', memorySession.sessionId, '--stdin'], {
      input: text,
    })
    if (r.code !== 0) throw new Error(`agent send: ${r.stderr}`)
  }
  await expect
    .poll(
      async () =>
        (await stack.json<{ observations: unknown[] }>(['memory', 'ls', '--cwd', dir])).observations
          .length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0)
  const opened = await stack.nexo(['open', join(dir, 'LEEME.md'), '--pane', viewer.paneId])
  if (opened.code !== 0) throw new Error(`nexo open: ${opened.stderr}`)
  return { stack, dir, tmp, viewerPane: viewer.paneId }
}

const tab = (app: Page, name: string) => app.getByRole('tab', { name })
const dialog = (app: Page, name: string) => app.getByRole('dialog', { name })

const isNarrow = (app: Page) => (app.viewportSize()?.width ?? 1280) < 760

type View = {
  /** Solo en anchos estrechos (cajón) o amplios (barra fija o carril). */
  only?: 'narrow' | 'wide'
  name: string
  enter: (app: Page, scene: Scene) => Promise<void>
  leave?: (app: Page) => Promise<void>
}

const closeDialog = async (app: Page, name: string) => {
  await dialog(app, name).getByRole('button', { name: 'Cerrar' }).click()
  await expect(dialog(app, name)).toHaveCount(0)
}

const VIEWS: View[] = [
  {
    name: 'terminal',
    enter: async (app) => {
      await tab(app, 'base').click()
      await expect(app.locator('.tab-panel:visible .pane')).toHaveCount(3)
    },
  },
  {
    name: 'agente-chips',
    enter: async (app) => {
      await app.getByRole('button', { name: 'Nueva pestaña de agente' }).click()
      await expect(app.getByLabel('Proveedor')).toBeVisible()
    },
    // La pestaña de la vista se cierra para que cada anchura parta del mismo estado.
    leave: async (app) => {
      await app.locator('.tab-wrap.selected .tab-close').click()
    },
  },
  {
    name: 'agente-permiso',
    enter: async (app) => {
      await tab(app, 'permiso').click()
      const composer = app.locator('.tab-panel:visible').getByLabel('Mensaje para el agente')
      if ((await app.locator('.tab-panel:visible .perm.pending').count()) === 0) {
        await composer.fill('permiso')
        await composer.press('Enter')
      }
      await expect(app.locator('.tab-panel:visible .perm.pending')).toBeVisible()
    },
  },
  {
    name: 'visor',
    enter: async (app) => {
      await tab(app, 'visor').click()
      await expect(app.locator('[data-testid="viewer"]:visible')).toContainText('Tienda web')
    },
  },
  {
    name: 'historial',
    enter: async (app) => {
      await app.getByRole('button', { name: 'Historial' }).click()
      await expect(dialog(app, 'Historial')).toBeVisible()
      await expect(dialog(app, 'Historial').locator('.history-session').first()).toBeVisible()
    },
    leave: (app) => closeDialog(app, 'Historial'),
  },
  {
    name: 'historial-sesion',
    enter: async (app) => {
      await app.getByRole('button', { name: 'Historial' }).click()
      await dialog(app, 'Historial')
        .getByRole('button', { name: 'Ver', exact: true })
        .first()
        .click()
      await expect(dialog(app, 'Historial').locator('.history-session-head')).toBeVisible()
    },
    leave: (app) => closeDialog(app, 'Historial'),
  },
  {
    name: 'memoria',
    enter: async (app) => {
      await app.getByRole('button', { name: /^Memoria/ }).click()
      await expect(dialog(app, 'Memoria')).toBeVisible()
      await expect(dialog(app, 'Memoria').locator('.memory-cost')).toContainText('Observador')
    },
    leave: (app) => closeDialog(app, 'Memoria'),
  },
  {
    name: 'mascota',
    enter: async (app) => {
      await app.getByRole('button', { name: 'Mascota', exact: true }).click()
      await expect(dialog(app, 'Mascota')).toBeVisible()
      await dialog(app, 'Mascota').getByRole('radio', { name: /Tiny/ }).check()
      await expect(dialog(app, 'Mascota').locator('.companion-choice').nth(1)).toBeVisible()
    },
    leave: (app) => closeDialog(app, 'Mascota'),
  },
  {
    name: 'limites',
    enter: async (app) => {
      await app.locator('.limits-toggle').click()
      await expect(app.locator('.limits-detail')).toBeVisible()
    },
    leave: async (app) => {
      await app.keyboard.press('Escape')
      await expect(app.locator('.limits-detail')).toHaveCount(0)
    },
  },
  {
    name: 'ayuda',
    enter: async (app) => {
      await app.keyboard.press('Control+Shift+P')
      await expect(dialog(app, 'Atajos de teclado')).toBeVisible()
    },
    leave: async (app) => {
      await app.keyboard.press('Escape')
      await expect(dialog(app, 'Atajos de teclado')).toHaveCount(0)
    },
  },
  {
    name: 'cajon',
    only: 'narrow',
    enter: async (app) => {
      await app.getByRole('button', { name: 'Mostrar espacios' }).click()
      await expect(app.getByRole('dialog', { name: 'Menú de espacios' })).toBeVisible()
    },
    leave: async (app) => {
      await app.keyboard.press('Escape')
      await expect(app.getByRole('dialog', { name: 'Menú de espacios' })).toHaveCount(0)
    },
  },
  {
    name: 'barra-colapsada',
    only: 'wide',
    enter: async (app) => {
      await app.getByRole('button', { name: 'Ocultar espacios' }).click()
      await expect(app.locator('.side-column.rail .companion-dock')).toBeVisible()
    },
    leave: async (app) => {
      await app.getByRole('button', { name: 'Mostrar espacios' }).click()
      await expect(app.getByRole('navigation', { name: 'Espacios de trabajo' })).toBeVisible()
    },
  },
]

/** Elementos que se miden: el documento y las barras. */
const BARS = [
  '.tabbar',
  '.statusbar',
  '.composer',
  '.sidebar',
  '.modal',
  '.pane-header',
  '.history-toolbar',
]

async function overflowReport(app: Page): Promise<string[]> {
  return app.evaluate((bars) => {
    const out: string[] = []
    const doc = document.documentElement
    if (doc.scrollWidth > doc.clientWidth)
      out.push(`documento ${doc.scrollWidth}>${doc.clientWidth}`)
    if (document.body.scrollWidth > document.body.clientWidth) out.push('body')
    for (const sel of bars) {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue
        if (el.scrollWidth > el.clientWidth + 1)
          out.push(`${sel} ${el.scrollWidth}>${el.clientWidth}`)
        const r = el.getBoundingClientRect()
        if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1))
          out.push(`${sel} fuera de la ventana`)
      }
    }
    return out
  }, BARS)
}

/** Los botones de solo icono visibles miden al menos 28 px. */
async function smallTargets(app: Page): Promise<string[]> {
  return app.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('button.icon-button')) {
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      if (r.width === 0 || style.visibility === 'hidden' || style.display === 'none') continue
      if (r.width < 28 - 0.5 || r.height < 28 - 0.5) {
        out.push(`${el.getAttribute('aria-label')} ${r.width.toFixed(0)}x${r.height.toFixed(0)}`)
      }
    }
    return out
  })
}

const sanitize = (app: Page) =>
  app.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLInputElement>('.chip-cwd'))
      el.placeholder = '~/tienda-web'
    for (const el of document.querySelectorAll('.chip.fixed.ellipsis, .memory-dialog p.ellipsis')) {
      el.textContent = '~/tienda-web'
    }
  })

let scene: Scene | undefined

test.describe.configure({ mode: 'serial' })
test.describe('pulido visual (F5.4)', () => {
  test.beforeAll(async () => {
    scene = await buildScene()
  })
  test.afterAll(async () => {
    if (scene === undefined) return
    await scene.stack.dispose()
    rmSync(scene.tmp, { recursive: true, force: true })
  })

  for (const size of WIDTHS) {
    test(`sin desbordes a ${size.width}x${size.height}${CAPTURE ? ' y capturas' : ''}`, async ({
      app,
    }) => {
      if (scene === undefined) throw new Error('sin escena')
      await app.setViewportSize(size)
      await app.goto(scene.stack.url())
      await expect(tab(app, 'base')).toBeVisible()
      const problems: string[] = []
      for (const view of VIEWS) {
        if (view.only === 'narrow' && !isNarrow(app)) continue
        if (view.only === 'wide' && isNarrow(app)) continue
        await view.enter(app, scene)
        await app.waitForTimeout(250)
        for (const p of await overflowReport(app)) problems.push(`${view.name}: ${p}`)
        for (const p of await smallTargets(app))
          problems.push(`${view.name}: objetivo pequeño ${p}`)
        if (CAPTURE) {
          await sanitize(app)
          mkdirSync(OUT, { recursive: true })
          await app.screenshot({ path: join(OUT, `${PREFIX}${view.name}-${size.width}.png`) })
        }
        await view.leave?.(app)
      }
      expect(problems).toEqual([])
    })
  }

  test('a 360 px las acciones clave están visibles y se pueden pulsar', async ({ app }) => {
    if (scene === undefined) throw new Error('sin escena')
    await app.setViewportSize({ width: 360, height: 640 })
    await app.goto(scene.stack.url())
    await expect(tab(app, 'base')).toBeAttached()
    const visibleAndInside = async (loc: Locator) => {
      await expect(loc).toBeVisible()
      const box = await loc.boundingBox()
      expect(box).not.toBeNull()
      if (box === null) return
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(360)
      expect(box.width).toBeGreaterThanOrEqual(28)
      expect(box.height).toBeGreaterThanOrEqual(28)
    }
    await visibleAndInside(app.getByRole('button', { name: 'Nueva pestaña', exact: true }))
    await visibleAndInside(app.getByRole('button', { name: 'Nueva pestaña de agente' }))
    await visibleAndInside(app.getByRole('button', { name: 'Mostrar espacios' }))
    for (const name of ['Historial', /^Memoria/, 'Mascota']) {
      const button = app.getByRole('button', { name })
      await expect(button.first()).toBeVisible()
      const box = await button.first().boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(28)
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360)
    }
    await app.getByRole('button', { name: 'Nueva pestaña', exact: true }).click()
    await expect(app.getByRole('tab')).toHaveCount(5)

    // La pestaña activa queda entera a la vista dentro de la barra, con su botón de cerrar.
    const inside = async () => {
      const list = await app.locator('.tablist').boundingBox()
      const selected = await app.locator('.tab-wrap.selected').boundingBox()
      expect(list).not.toBeNull()
      expect(selected).not.toBeNull()
      if (list === null || selected === null) return
      expect(selected.x).toBeGreaterThanOrEqual(list.x - 1)
      expect(selected.x + selected.width).toBeLessThanOrEqual(list.x + list.width + 1)
    }
    await expect
      .poll(async () => {
        try {
          await inside()
          return true
        } catch {
          return false
        }
      })
      .toBe(true)
    await app.getByRole('button', { name: 'Nueva pestaña de agente' }).click()
    await expect(app.getByRole('tab')).toHaveCount(6)
    await expect
      .poll(async () => {
        try {
          await inside()
          return true
        } catch {
          return false
        }
      })
      .toBe(true)
  })

  test('el cajón de espacios en estrecho: abre, Esc y clic fuera lo cierran, y el estado persiste', async ({
    app,
  }) => {
    if (scene === undefined) throw new Error('sin escena')
    await app.setViewportSize({ width: 600, height: 700 })
    await app.goto(scene.stack.url())
    await expect(tab(app, 'base')).toBeAttached()
    const sidebar = app.getByRole('navigation', { name: 'Espacios de trabajo' })
    await expect(sidebar).toBeHidden()
    await app.getByRole('button', { name: 'Mostrar espacios' }).click()
    await expect(sidebar).toBeVisible()
    await app.keyboard.press('Escape')
    await expect(sidebar).toBeHidden()
    await app.getByRole('button', { name: 'Mostrar espacios' }).click()
    await expect(sidebar).toBeVisible()
    await app.mouse.click(595, 400)
    await expect(sidebar).toBeHidden()

    // Ancho: colapsar se recuerda al recargar.
    await app.setViewportSize({ width: 1280, height: 800 })
    await expect(sidebar).toBeVisible()
    await app.getByRole('button', { name: 'Ocultar espacios' }).click()
    await expect(sidebar).toBeHidden()
    await app.reload()
    await expect(sidebar).toBeHidden()
    await app.getByRole('button', { name: 'Mostrar espacios' }).click()
    await expect(sidebar).toBeVisible()
  })
})
