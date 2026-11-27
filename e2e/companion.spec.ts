import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { tinyCompanion } from '../packages/testkit/src/companion-package.ts'
import { robiPackage } from './robi.ts'
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
    await expect(dock(app).locator('svg:not([data-icon]), object, iframe, embed')).toHaveCount(0)

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

  test('Robi, el paquete de ejemplo, se dibuja con una expresión distinta en cada estado', async ({
    stack,
    app,
  }) => {
    install(stack, 'robi', robiPackage())
    await stack.nexo(['companion', 'select', 'robi'])
    await openAgentTab(stack, app)
    await expect(dock(app)).toHaveAttribute('data-state', 'idle')
    const seen = new Map<string, string | null>()
    const look = async (state: string) => {
      await expect(dock(app)).toHaveAttribute('data-requested-state', state)
      await expect(dock(app).locator('img')).toHaveAttribute('alt', /^Robi: /)
      expect(await decoded(app)).toBe(true)
      seen.set(state, await dock(app).locator('img').getAttribute('src'))
    }
    seen.set('idle', await dock(app).locator('img').getAttribute('src'))
    await say(app, 'lento 60')
    await look('thinking')
    await expect(dock(app)).toHaveAttribute('data-requested-state', 'done', { timeout: 30_000 })
    await look('done')
    await say(app, 'permiso')
    await look('waiting')
    // Cada estado usa su propio dibujo (el origen es una URL de objeto distinta por imagen).
    expect(new Set(seen.values()).size).toBe(seen.size)
    await app
      .getByRole('button', { name: /Permitir/ })
      .first()
      .click()
    await expect(app.locator('.perm-result')).toContainText('Permitido')
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

test.describe('capturas F5.3', () => {
  test.skip(process.env.NEXO_CAPTURAS === undefined, 'solo con NEXO_CAPTURAS=1')
  const shot = async (app: Page, name: string) => {
    // Deja terminar el fundido de entrada de la imagen (180 ms) antes de la captura.
    await app.waitForTimeout(450)
    // La ruta de trabajo de la prueba no es la de nadie: se sustituye por una de ejemplo.
    await app.evaluate(() => {
      for (const el of document.querySelectorAll('.chip.fixed.ellipsis'))
        el.textContent = '~/tienda-web'
    })
    mkdirSync(OUT, { recursive: true })
    await app.screenshot({ path: join(OUT, `f5-${name}.png`) })
  }

  test('capturas del selector y de la mascota en varios estados', async ({ stack, app }) => {
    await app.setViewportSize({ width: 1280, height: 800 })
    install(stack, 'robi', robiPackage())
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
