import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProviderSession, UsageWindowInfo } from '@nexo/core'
import { type CodexUsageLimits, createCodexProvider } from '../src/index.ts'
import { FAKE, wait } from './helpers.ts'
import { dir } from './history-rig.ts'

type Raw = Record<string, unknown>

/** Ventana en la forma de `app-server` (segundos Unix, minutos). */
export const rawWindow = (usedPercent: number, mins?: number, resetsAt?: number): Raw => ({
  usedPercent,
  windowDurationMins: mins ?? null,
  resetsAt: resetsAt ?? null,
})

/** Instantánea con datos de cuenta que no deben salir del adaptador (todos empiezan por SECRETO). */
export const rawSnapshot = (
  limitId: string | null,
  primary: Raw | null,
  secondary: Raw | null = null,
  extra: Raw = {},
): Raw => ({
  limitId,
  limitName: null,
  primary,
  secondary,
  credits: { hasCredits: true, unlimited: false, balance: 'SECRETO-saldo' },
  planType: 'SECRETO-plan',
  rateLimitReachedType: null,
  ...extra,
})

/** Respuesta de `account/rateLimits/read` con los datos de cuenta de relleno. */
export const rawResult = (byId: Record<string, Raw>, extra: Raw = {}): Raw => ({
  rateLimits: Object.values(byId)[0] ?? rawSnapshot('codex', null),
  rateLimitsByLimitId: byId,
  accountId: 'SECRETO-cuenta',
  ordinaryUsageAllowed: true,
  ...extra,
})

/** Ventanas del puerto → forma de `app-server`, agrupadas por cubo. */
function toRawByBucket(windows: UsageWindowInfo[]): Record<string, Raw> {
  const byId: Record<string, Raw> = {}
  for (const w of windows) {
    const bucket = w.bucket ?? 'codex'
    const snap = byId[bucket] ?? rawSnapshot(bucket, null)
    byId[bucket] = snap
    snap[w.id] = rawWindow(
      w.usedPercent,
      w.windowMinutes,
      w.resetsAt === undefined ? undefined : Math.floor(w.resetsAt / 1000),
    )
  }
  return byId
}

/** Proveedor contra `fake-codex.mjs` con los límites y las notificaciones que fija la prueba (en archivos). */
export function limitsRig(env: Record<string, string> = {}) {
  const id = randomUUID()
  const limitsFile = join(dir, `limits-${id}.json`)
  const notifyFile = join(dir, `notify-${id}.json`)
  writeFileSync(limitsFile, JSON.stringify(rawResult({ codex: rawSnapshot('codex', null) })))
  writeFileSync(notifyFile, '[]')
  const provider = createCodexProvider({
    env: {
      ...process.env,
      FAKE_CODEX_LIMITS_FILE: limitsFile,
      FAKE_CODEX_NOTIFY_FILE: notifyFile,
      ...env,
    },
    executable: FAKE,
    probeCacheMs: 0,
  })
  const limits = provider.usageLimits as CodexUsageLimits | undefined
  if (limits === undefined) throw new Error('Codex debe exponer límites')
  let session: AgentProviderSession | undefined
  /** Envía estas notificaciones (params) desde una sesión abierta y espera a que acabe el turno. */
  async function notify(paramsList: unknown[], word = 'notificar'): Promise<void> {
    writeFileSync(notifyFile, JSON.stringify(paramsList))
    session ??= await provider.open({ cwd: dir })
    let ended = 0
    const off = session.onEvent((e) => {
      if (e.type === 'turn-end') ended++
    })
    await session.send(word)
    await wait(() => ended > 0)
    off()
  }
  return {
    provider,
    limits,
    setRead: (value: unknown) => writeFileSync(limitsFile, JSON.stringify(value)),
    seed: async (windows: UsageWindowInfo[]) =>
      writeFileSync(limitsFile, JSON.stringify(rawResult(toRawByBucket(windows)))),
    notify,
    report: async (windows: UsageWindowInfo[]) =>
      notify(Object.values(toRawByBucket(windows)).map((rateLimits) => ({ rateLimits }))),
    async dispose() {
      await session?.close().catch(() => {})
    },
  }
}
