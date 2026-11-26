import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAcpProvider } from '../src/index.ts'
import { AGENT } from './helpers.ts'

const dir = mkdtempSync(join(tmpdir(), 'nexo-acp-history-'))
process.once('exit', () => rmSync(dir, { recursive: true, force: true }))

type Entry = { sessionId: string; cwd: string; title?: string; updatedAt: string }

export function acpRig(env: Record<string, string> = {}) {
  const file = join(dir, `sessions-${Math.random().toString(36).slice(2)}.json`)
  const sessions: Entry[] = []
  const save = () => writeFileSync(file, JSON.stringify(sessions))
  save()
  const provider = createAcpProvider({
    agent: AGENT,
    env: { ...process.env, FAKE_ACP_LIST: '1', FAKE_ACP_SESSIONS_FILE: file, ...env },
    probeCacheMs: 0,
  })
  const history = provider.history
  if (history === undefined) throw new Error('el proveedor ACP debe exponer historial')
  let n = 0
  return {
    history,
    add(entry: Omit<Entry, 'sessionId'> & { sessionId?: string }) {
      const sessionId = entry.sessionId ?? `fake-session-${++n}`
      sessions.push({ ...entry, sessionId })
      save()
      return sessionId
    },
  }
}
