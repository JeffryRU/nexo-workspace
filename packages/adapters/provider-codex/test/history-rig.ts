import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexProvider } from '../src/index.ts'
import { FAKE } from './helpers.ts'

type Thread = Record<string, unknown>

export const userItem = (text: string) => ({
  type: 'userMessage',
  id: randomUUID(),
  content: [{ type: 'text', text, text_elements: [] }],
})
export const agentItem = (text: string) => ({ type: 'agentMessage', id: randomUUID(), text })

/** Hilos como los devuelve `thread/read`: un turno por cada mensaje del usuario. */
export function threadFrom(session: {
  cwd?: string
  title?: string
  updatedAt: number
  messages: { role: 'user' | 'assistant'; text: string }[]
  id?: string
}): Thread {
  const turns: { id: string; status: string; items: unknown[] }[] = []
  for (const m of session.messages) {
    if (m.role === 'user')
      turns.push({ id: randomUUID(), status: 'completed', items: [userItem(m.text)] })
    else turns[turns.length - 1]?.items.push(agentItem(m.text))
  }
  return {
    id: session.id ?? randomUUID(),
    name: session.title ?? null,
    preview: session.messages[0]?.text ?? '',
    cwd: session.cwd ?? '/work/app',
    createdAt: Math.floor(session.updatedAt / 1000) - 60,
    updatedAt: Math.floor(session.updatedAt / 1000),
    modelProvider: 'openai',
    source: 'cli',
    status: { type: 'notLoaded' },
    turns,
  }
}

export const dir = mkdtempSync(join(tmpdir(), 'nexo-codex-history-'))
process.once('exit', () => rmSync(dir, { recursive: true, force: true }))

export function codexRig(env: Record<string, string> = {}) {
  const file = join(dir, `threads-${randomUUID()}.json`)
  const threads: Thread[] = []
  const save = () => writeFileSync(file, JSON.stringify(threads))
  save()
  const provider = createCodexProvider({
    env: { ...process.env, FAKE_CODEX_THREADS_FILE: file, ...env },
    executable: FAKE,
    probeCacheMs: 0,
  })
  const history = provider.history
  if (history === undefined) throw new Error('Codex debe exponer historial')
  return {
    history,
    provider,
    threads,
    add(t: Thread) {
      threads.push(t)
      save()
      return t.id as string
    },
  }
}
