import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { tinyCompanion } from '../packages/testkit/src/companion-package.ts'
import { ECHO_SCRIPT, expect, type Stack, test } from './stack.ts'

/**
 * La mascota en la interfaz (F5.3) contra un daemon real y el paquete de prueba del testkit, instalado en
 * `<estado>/companions/tiny`. Los estados salen de la atención de un agente de prueba (`lento`, `permiso`).
 */

/** Copia un paquete (ruta relativa -> bytes) a la carpeta de compañeros del daemon. */
function install(stack: Stack, id: string, files: Record<string, Uint8Array | string>): string {
  const root = join(stack.dir, 'companions', id)
  for (const [rel, data] of Object.entries(files)) {
    const file = join(root, ...rel.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, data)
  }
  return root
}

const dock = (app: Page) => app.locator('.companion-dock')
const selector = (app: Page) => app.getByRole('dialog', { name: 'Mascota' })
const composer = (app: Page) => app.getByLabel('Mensaje para el agente')

async function openApp(stack: Stack, app: Page): Promise<void> {
  await stack.newTab('base', ECHO_SCRIPT)
  await app.goto(stack.url())
  await expect(app.getByRole('tab', { name: 'base' })).toBeVisible()
}

async function openAgentTab(stack: Stack, app: Page): Promise<void> {
  await openApp(stack, app)
  await app.getByRole('button', { name: 'Nueva pestaña de agente' }).click()
  await expect(app.locator('.agent-panel')).toBeVisible()
  await expect(app.getByLabel('Proveedor')).toBeVisible()
}

async function say(app: Page, text: string): Promise<void> {
  await composer(app).fill(text)
  await composer(app).press('Enter')
}

/** ¿La imagen de la mascota se decodificó de verdad? (un `<img>` roto tiene `naturalWidth` 0). */
const decoded = (app: Page) =>
  dock(app)
    .locator('img')
    .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)

test.describe('mascota en la interfaz', () => {
  test('sin mascota por omisión; se elige, se dibuja como imagen, sobrevive a recargar y se quita', async ({
    stack,
    app,
  }) => {
    install(stack, 'tiny', tinyCompanion())
    await openApp(stack, app)
    // Sin mascota: nada dibujado.
    await expect(dock(app)).toHaveCount(0)

    await app.getByRole('button', { name: 'Mascota', exact: true }).click()
    await expect(selector(app)).toBeVisible()
    const radios = selector(app).getByRole('radio')
    await expect(radios).toHaveCount(2)
    await expect(radios.first()).toBeChecked() // «Sin mascota» es la primera y la elegida
    await expect(selector(app).locator('.companion-choice').first()).toContainText('Sin mascota')
    await expect(selector(app)).toContainText('Tiny')

    await selector(app).getByRole('radio', { name: /Tiny/ }).check()
    await expect(dock(app)).toBeVisible()
    await expect(dock(app).locator('img')).toHaveAttribute('src', /^blob:/)
    await expect(dock(app).locator('img')).toHaveAttribute('alt', 'Tiny: en reposo')
    expect(await decoded(app)).toBe(true)
    // Nunca se incrusta un SVG ni se usan <object>/<iframe>.
    await expect(dock(app).locator('svg, object, iframe, embed')).toHaveCount(0)

    // La elección la guarda el daemon.
    expect((await stack.nexo(['companion', 'list'])).stdout).toContain('elegida: tiny')
    await app.reload()
    await expect(dock(app)).toBeVisible()
    await expect(dock(app)).toHaveAttribute('data-companion', 'tiny')

    // «Sin mascota» la quita y se guarda.
    await app.getByRole('button', { name: 'Mascota', exact: true }).click()
    await selector(app).getByRole('radio', { name: 'Sin mascota' }).check()
    await expect(dock(app)).toHaveCount(0)
    expect((await stack.nexo(['companion', 'list'])).stdout).toContain('sin mascota')
    await app.reload()
    await expect(app.getByRole('tab', { name: 'base' })).toBeVisible()
    await expect(dock(app)).toHaveCount(0)
  })

  test('reacciona a los estados del agente: pensando, esperando (hoja de sprites), terminó y vuelve a reposo', async ({
    stack,
    app,
  }) => {
    install(stack, 'tiny', tinyCompanion())
    await stack.nexo(['companion', 'select', 'tiny'])
    await openAgentTab(stack, app)
    await expect(dock(app)).toHaveAttribute('data-state', 'idle')
    const idleSrc = await dock(app).locator('img').getAttribute('src')

    await say(app, 'lento 400')
    await expect(dock(app)).toHaveAttribute('data-requested-state', 'thinking')
    await expect(dock(app).locator('img')).toHaveAttribute('alt', 'Tiny: pensando')
    expect(await dock(app).locator('img').getAttribute('src')).not.toBe(idleSrc)
    expect(await decoded(app)).toBe(true)
    // El aviso para lectores de pantalla es discreto y educado.
    await expect(dock(app).locator('[aria-live="polite"]')).toContainText('pensando')

    await expect(app.locator('.usage')).toBeVisible({ timeout: 60_000 })
    await expect(dock(app)).toHaveAttribute('data-requested-state', /done|idle/)

    // Esperando permiso: el paquete de prueba anima una hoja de sprites en este estado.
    await say(app, 'permiso')
    await expect(dock(app)).toHaveAttribute('data-requested-state', 'waiting')
    await expect(dock(app).locator('.companion-sheet')).toBeVisible()
    await app
      .getByRole('button', { name: /Permitir/ })
      .first()
      .click()
    await expect(app.locator('.perm-result')).toContainText('Permitido')
    await expect(dock(app)).toHaveAttribute('data-requested-state', /done|idle/)
    await expect(dock(app)).toHaveAttribute('data-requested-state', 'idle', { timeout: 20_000 })
  })

  test('no tapa la barra de estado, las pestañas ni el compositor', async ({ stack, app }) => {
    install(stack, 'tiny', tinyCompanion())
    await stack.nexo(['companion', 'select', 'tiny'])
    await openAgentTab(stack, app)
    await expect(dock(app)).toBeVisible()
    type Rect = { x: number; y: number; width: number; height: number }
    const box = async (sel: string): Promise<Rect> => {
      const b = await app.locator(sel).first().boundingBox()
      if (b === null) throw new Error(`sin caja: ${sel}`)
      return b
    }
    const d = await box('.companion-dock')
    const overlaps = (a: Rect, b: Rect) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    for (const sel of [
      '.statusbar',
      '.tabbar, [role="tablist"]',
      'textarea[aria-label="Mensaje para el agente"]',
    ]) {
      expect(overlaps(d, await box(sel)), `se solapa con ${sel}`).toBe(false)
    }
    // El compositor sigue siendo utilizable con la mascota puesta.
    await composer(app).fill('hola')
    await expect(composer(app)).toHaveValue('hola')
  })

  test('se oculta y se vuelve a mostrar sin perder la elegida; la preferencia sobrevive a recargar', async ({
    stack,
    app,
  }) => {
    install(stack, 'tiny', tinyCompanion())
    await stack.nexo(['companion', 'select', 'tiny'])
    await openApp(stack, app)
    await expect(dock(app)).toBeVisible()
    await dock(app).hover()
    await dock(app).getByRole('button', { name: 'Ocultar la mascota' }).click()
    await expect(dock(app)).toHaveCount(0)
    await app.reload()
    await expect(app.getByRole('tab', { name: 'base' })).toBeVisible()
    await expect(dock(app)).toHaveCount(0)
    // El daemon sigue con la mascota elegida.
    expect((await stack.nexo(['companion', 'list'])).stdout).toContain('elegida: tiny')
    await app.getByRole('button', { name: 'Mascota', exact: true }).click()
    await expect(selector(app).getByLabel('Mostrar la mascota en la ventana')).not.toBeChecked()
    await selector(app).getByLabel('Mostrar la mascota en la ventana').check()
    await expect(dock(app)).toBeVisible()
  })

  test('una mascota borrada en disco no rompe la interfaz', async ({ stack, app }) => {
    const root = install(stack, 'tiny', tinyCompanion())
    await stack.nexo(['companion', 'select', 'tiny'])
    await openApp(stack, app)
    await expect(dock(app)).toBeVisible()
    rmSync(root, { recursive: true, force: true })
    await app.reload()
    await expect(app.getByRole('tab', { name: 'base' })).toBeVisible()
    await expect(dock(app)).toHaveCount(0)
    await expect(app.locator('.statusbar')).toBeVisible()
    // Se puede volver a «sin mascota» desde el selector.
    await app.getByRole('button', { name: 'Mascota', exact: true }).click()
    await expect(selector(app)).toBeVisible()
    await selector(app).getByRole('radio', { name: 'Sin mascota' }).check()
    await expect(selector(app).getByRole('radio', { name: 'Sin mascota' })).toBeChecked()
  })

  test('un paquete no válido se lista aparte y no se puede elegir', async ({ stack, app }) => {
    install(stack, 'tiny', tinyCompanion())
    install(stack, 'roto', { 'companion.json': '{ no es json' })
    await openApp(stack, app)
    await app.getByRole('button', { name: 'Mascota', exact: true }).click()
    await expect(selector(app).getByRole('radio')).toHaveCount(2)
    await expect(selector(app).locator('.companion-invalid')).toContainText('roto')
  })
})

// Capturas de la documentación: `NEXO_CAPTURAS=1 pnpm e2e -g capturas` las regenera en docs/capturas.
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'capturas')

/** Una carita en SVG (solo formas): el paquete de demostración de las capturas. */
const face = (bg: string, eyes: string, mouth: string, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="6" y="10" width="52" height="46" rx="14" fill="${bg}"/><path d="M32 4v8" stroke="${bg}" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="4" r="3.5" fill="#e5c07b"/>${eyes}${mouth}${extra}</svg>`
const eyes = (fill = '#15181d') =>
  `<circle cx="22" cy="30" r="5" fill="${fill}"/><circle cx="42" cy="30" r="5" fill="${fill}"/>`
const DEMO: Record<string, string> = {
  'idle.svg': face(
    '#61afef',
    eyes(),
    '<path d="M23 43q9 6 18 0" stroke="#15181d" stroke-width="3" fill="none" stroke-linecap="round"/>',
  ),
  'thinking.svg': face(
    '#c678dd',
    eyes(),
    '<circle cx="32" cy="45" r="3" fill="#15181d"/>',
    '<circle cx="52" cy="12" r="2.5" fill="#d7dae0"/><circle cx="57" cy="6" r="3.5" fill="#d7dae0"/>',
  ),
  'waiting.svg': face(
    '#e5c07b',
    eyes(),
    '<path d="M24 45h16" stroke="#15181d" stroke-width="3" stroke-linecap="round"/>',
    '<text x="50" y="14" font-size="16" font-weight="700" fill="#15181d" font-family="sans-serif">?</text>',
  ),
  'busy.svg': face(
    '#d19a66',
    eyes(),
    '<path d="M23 44h18" stroke="#15181d" stroke-width="3" stroke-linecap="round"/>',
  ),
  'done.svg': face(
    '#98c379',
    '<path d="M17 31q5-7 10 0M37 31q5-7 10 0" stroke="#15181d" stroke-width="3" fill="none" stroke-linecap="round"/>',
    '<path d="M22 41q10 12 20 0z" fill="#15181d"/>',
  ),
  'error.svg': face(
    '#e06c75',
    '<path d="M17 26l10 8M27 26l-10 8M37 26l10 8M47 26l-10 8" stroke="#15181d" stroke-width="3" stroke-linecap="round"/>',
    '<path d="M23 47q9-7 18 0" stroke="#15181d" stroke-width="3" fill="none" stroke-linecap="round"/>',
  ),
}
const DEMO_MANIFEST = {
  format: 1,
  id: 'robi',
  name: 'Robi',
  version: '1.0.0',
  description: 'Un robot sencillo de demostración, dibujado con formas SVG.',
  author: { name: 'Nexo' },
  license: 'CC0-1.0',
  states: Object.fromEntries(
    ['idle', 'thinking', 'waiting', 'busy', 'done', 'error'].map((s) => [s, { src: `${s}.svg` }]),
  ),
}

test.describe('capturas F5.3', () => {
  test.skip(process.env.NEXO_CAPTURAS === undefined, 'solo con NEXO_CAPTURAS=1')
  const shot = async (app: Page, name: string) => {
    // Deja terminar el fundido de entrada de la imagen (180 ms) antes de la captura.
    await app.waitForTimeout(450)
    mkdirSync(OUT, { recursive: true })
    await app.screenshot({ path: join(OUT, `f5-${name}.png`) })
  }

  test('capturas del selector y de la mascota en varios estados', async ({ stack, app }) => {
    await app.setViewportSize({ width: 1280, height: 800 })
    install(stack, 'robi', { ...DEMO, 'companion.json': JSON.stringify(DEMO_MANIFEST) })
    install(stack, 'tiny', tinyCompanion())
    install(stack, 'roto', { 'companion.json': '{ no es json' })
    await openAgentTab(stack, app)

    await app.getByRole('button', { name: 'Mascota', exact: true }).click()
    await expect(selector(app).getByRole('radio')).toHaveCount(3)
    await shot(app, 'selector')
    await selector(app).getByRole('radio', { name: /Robi/ }).check()
    await expect(dock(app)).toBeVisible()
    await app.keyboard.press('Escape')
    await expect(selector(app)).toHaveCount(0)

    await expect(dock(app)).toHaveAttribute('data-state', 'idle')
    await shot(app, 'estado-reposo')

    await say(app, 'lento 60')
    await expect(dock(app)).toHaveAttribute('data-requested-state', 'thinking')
    await shot(app, 'estado-pensando')
    await expect(dock(app)).toHaveAttribute('data-requested-state', 'done', { timeout: 30_000 })
    await shot(app, 'estado-terminado')

    await say(app, 'permiso')
    await expect(dock(app)).toHaveAttribute('data-requested-state', 'waiting')
    await shot(app, 'estado-esperando')
    await app
      .getByRole('button', { name: /Permitir/ })
      .first()
      .click()
    await expect(app.locator('.perm-result')).toContainText('Permitido')
  })
})

test.describe('capturas F5.3 en anchos estrechos', () => {
  test.skip(process.env.NEXO_CAPTURAS === undefined, 'solo con NEXO_CAPTURAS=1')

  test('selector y mascota en 360, 768 y 1280 de ancho', async ({ stack, app }) => {
    install(stack, 'robi', { ...DEMO, 'companion.json': JSON.stringify(DEMO_MANIFEST) })
    install(stack, 'tiny', tinyCompanion())
    await stack.nexo(['companion', 'select', 'robi'])
    await openAgentTab(stack, app)
    mkdirSync(OUT, { recursive: true })
    const sizes = [
      { w: 360, h: 640, name: '360' },
      { w: 768, h: 700, name: '768' },
      { w: 1280, h: 600, name: '1280-bajo' },
    ]
    for (const { w, h, name } of sizes) {
      await app.setViewportSize({ width: w, height: h })
      await expect(dock(app)).toBeVisible()
      await app.waitForTimeout(450)
      await app.screenshot({ path: join(OUT, `f5-ancho-${name}-mascota.png`) })
      await app.getByRole('button', { name: 'Mascota', exact: true }).click()
      await expect(selector(app)).toBeVisible()
      await app.waitForTimeout(200)
      await app.screenshot({ path: join(OUT, `f5-ancho-${name}-selector.png`) })
      await app.keyboard.press('Escape')
      await expect(selector(app)).toHaveCount(0)
    }
  })
})
