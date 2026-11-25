import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { CDPSession, Page } from '@playwright/test'
import { bufferText, expect, test } from './stack.ts'

// Presupuesto del contrato (docs/ARCHITECTURE.md, "Rendimiento"): cambiar de pestaña con 10 terminales
// activas tarda < 16 ms. En CI se acepta más margen por la variabilidad de los runners compartidos.
const TAB_SWITCH_P95_MS = Number(process.env.NEXO_PERF_TAB_P95_MS ?? '16')
// Salida masiva: ninguna tarea larga de la página (> 50 ms según la API) puede pasar de este límite.
const LONGTASK_MAX_MS = Number(process.env.NEXO_PERF_LONGTASK_MAX_MS ?? '150')
const HEAP_GROWTH_MAX_MB = Number(process.env.NEXO_PERF_HEAP_GROWTH_MB ?? '100')

const TABS = 10
const SWITCHES = 50
const OUT_DIR = join(import.meta.dirname, 'results')

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] as number
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const r = (n: number) => Math.round(n * 100) / 100
  return {
    n: sorted.length,
    p50: r(percentile(sorted, 50)),
    p95: r(percentile(sorted, 95)),
    max: r(sorted[sorted.length - 1] ?? Number.NaN),
  }
}

function save(name: string, data: unknown): void {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`)
}

/** Salida continua: una línea de ~70 caracteres cada 5 ms. */
const EMITTER = "let n=0;setInterval(()=>console.log('linea '+(n++)+' '+'x'.repeat(60)),5)"

test('cambiar de pestaña con 10 terminales activas: p95 < 16 ms', async ({ stack, app }) => {
  for (let i = 1; i <= TABS; i++) await stack.newTab(`t${i}`, EMITTER)
  await app.goto(stack.url())
  const tabs = app.getByRole('tab')
  await expect(tabs).toHaveCount(TABS)

  // Visita cada pestaña una vez: las terminales se crean al verlas por primera vez.
  for (let i = 0; i < TABS; i++) {
    await tabs.nth(i).click()
    await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true')
    await sleep(150)
  }
  await app.evaluate(() => {
    globalThis.__NEXO_PERF__ = undefined
  })

  for (let i = 0; i < SWITCHES; i++) {
    await tabs.nth((i + 1) % TABS).click()
    await app.waitForFunction((n) => (globalThis.__NEXO_PERF__?.tabSwitch.length ?? 0) >= n, i + 1)
    await sleep(40)
  }

  const samples = await app.evaluate(() => globalThis.__NEXO_PERF__)
  const work = summarize(samples?.tabSwitch ?? [])
  const raw = summarize(samples?.tabSwitchRaw ?? [])
  const result = { tabs: TABS, switches: SWITCHES, limitP95Ms: TAB_SWITCH_P95_MS, work, raw }
  save('tab-switch', result)
  console.log(`tab-switch (ms): ${JSON.stringify(result)}`)

  expect(work.n).toBeGreaterThanOrEqual(SWITCHES)
  expect(work.p95).toBeLessThan(TAB_SWITCH_P95_MS)
})

async function heapMb(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage')
  const { metrics } = await cdp.send('Performance.getMetrics')
  const used = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0
  return Math.round((used / 1024 / 1024) * 10) / 10
}

async function longTasks(page: Page): Promise<number[]> {
  return page.evaluate(() => (globalThis as unknown as { __long: number[] }).__long ?? [])
}

// 20 MiB en líneas de 1 KiB cada vez que recibe una línea (así la página ya está mirando el panel).
const SPEW =
  "let n=0;let busy=false;process.stdin.on('data',()=>{if(busy)return;busy=true;const line='x'.repeat(1022)+'\\n';let i=0;(function w(){while(i<20480){i++;if(!process.stdout.write(i%1000===0?'tramo '+i+' '+line:line))return process.stdout.once('drain',w)}console.log('FIN-20MB-'+(++n));busy=false})()})"

test('una terminal que escupe 20 MB no congela la interfaz ni deja crecer la memoria', async ({
  stack,
  app,
}) => {
  const { paneId } = await stack.newTab('spew', SPEW)
  await app.addInitScript(() => {
    const w = globalThis as unknown as { __long: number[] }
    w.__long = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push(e.duration)
    }).observe({ type: 'longtask', buffered: true })
    // Diagnóstico: qué scripts hay en los fotogramas largos (Long Animation Frames).
    const frames: unknown[] = []
    ;(w as unknown as { __loaf: unknown[] }).__loaf = frames
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as {
          duration: number
          scripts: { invoker: string; sourceFunctionName: string; duration: number }[]
        }[]) {
          frames.push({
            ms: Math.round(e.duration),
            scripts: e.scripts.map(
              (x) => `${x.invoker}/${x.sourceFunctionName}:${Math.round(x.duration)}`,
            ),
          })
        }
      }).observe({ type: 'long-animation-frame', buffered: true })
    } catch {
      // sin soporte de Long Animation Frames
    }
  })
  await app.goto(stack.url())
  await expect(app.getByRole('tab')).toHaveCount(1)
  await expect.poll(() => bufferText(app, paneId), { timeout: 20_000 }).not.toBeNull()
  const cdp = await app.context().newCDPSession(app)
  await cdp.send('Performance.enable')

  const baselineMb = await heapMb(cdp)
  await sleep(500) // la pausa del GC forzado también cuenta como tarea larga: que no caiga en la ronda
  const rounds: { heapAfterMb: number; peakMb: number; longestTaskMs: number; seconds: number }[] =
    []
  for (let round = 1; round <= 2; round++) {
    const before = (await longTasks(app)).length
    let peak = 0
    const t0 = Date.now()
    await stack.nexo(['send', paneId, '--enter', 'go'])
    for (;;) {
      // El fin se comprueba en el daemon: la interfaz puede ir por detrás (ver docs/ARCHITECTURE.md, Rendimiento).
      const tail = (await stack.nexo(['read', paneId, '--lines', '2'])).stdout
      if (tail.includes(`FIN-20MB-${round}`)) break
      if (Date.now() - t0 > 120_000) throw new Error('la salida de 20 MB no terminó a tiempo')
      const { metrics } = await cdp.send('Performance.getMetrics')
      const used = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0
      peak = Math.max(peak, used / 1048576)
      await sleep(250)
    }
    await sleep(3000) // la interfaz sigue procesando lo recibido
    const seconds = Math.round((Date.now() - t0) / 100) / 10
    const during = (await longTasks(app)).slice(before)
    const heapAfterMb = await heapMb(cdp)
    await sleep(500)
    rounds.push({
      heapAfterMb,
      peakMb: Math.round(peak * 10) / 10,
      longestTaskMs: Math.round(Math.max(0, ...during)),
      seconds,
    })
  }
  const result = {
    limitLongTaskMs: LONGTASK_MAX_MS,
    limitHeapGrowthMb: HEAP_GROWTH_MAX_MB,
    baselineMb,
    rounds,
  }
  const slowFrames = await app.evaluate(() =>
    ((globalThis as unknown as { __loaf: { ms: number }[] }).__loaf ?? []).filter(
      (f) => f.ms >= 80,
    ),
  )
  save('output-20mb', { ...result, slowFrames })
  console.log(`fotogramas largos: ${JSON.stringify(slowFrames)}`)
  console.log(`salida de 20 MB: ${JSON.stringify(result)}`)

  for (const r of rounds) expect(r.longestTaskMs).toBeLessThan(LONGTASK_MAX_MS)
  // Tras la salida la memoria no puede haber crecido sin límite (el scrollback de xterm está acotado)...
  expect(rounds[1]?.heapAfterMb ?? Number.POSITIVE_INFINITY).toBeLessThan(
    baselineMb + HEAP_GROWTH_MAX_MB,
  )
  // ...y una segunda tanda de 20 MB no suma sobre la primera.
  expect((rounds[1]?.heapAfterMb ?? 0) - (rounds[0]?.heapAfterMb ?? 0)).toBeLessThan(
    HEAP_GROWTH_MAX_MB / 2,
  )
})
