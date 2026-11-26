import { basename, resolve } from 'node:path'
import { AgentDocument } from '@nexo/client'
import {
  type AgentSession,
  AgentSessionId,
  type Block,
  BlockId,
  LIMITS,
  PermissionMode,
  type QuestionAnswer,
  TabId,
  utf8ByteLength,
  validateAnswers,
  WorkspaceId,
} from '@nexo/contracts'
import { AgentPrinter } from '../agent-render.ts'
import { expectPositionals, flag, parseArgv, str } from '../args.ts'
import type { ClientLike, Ctx } from '../context.ts'
import { CliError, classifyError, notFoundError, unavailableError, usageError } from '../errors.ts'
import { shortId } from '../resolve.ts'
import {
  AgentActionOutput,
  AgentAttachLine,
  AgentLsOutput,
  AgentNewOutput,
  AgentSendOutput,
} from '../schemas.ts'
import { sanitize } from '../text.ts'
import { readStdin } from './send.ts'

const AGENT_EVENTS = ['agent.block', 'agent.delta', 'agent.status', 'agent.session'] as const
const SUBCOMMANDS = [
  'new',
  'send',
  'ls',
  'attach',
  'interrupt',
  'close',
  'respond',
  'renew',
] as const

export async function agentCommand(ctx: Ctx, args: string[]): Promise<void> {
  // Las opciones globales pueden ir antes del subcomando (`nexo agent --json ls`).
  const at = args.findIndex((a) => !a.startsWith('-'))
  const sub = at === -1 ? undefined : args[at]
  const rest = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 1)]
  switch (sub) {
    case 'new':
      return agentNew(ctx, rest)
    case 'send':
      return agentSend(ctx, rest)
    case 'ls':
      return agentLs(ctx, rest)
    case 'attach':
      return agentAttach(ctx, rest)
    case 'interrupt':
      return agentSimple(ctx, rest, 'interrupt')
    case 'close':
      return agentSimple(ctx, rest, 'close')
    case 'respond':
      return agentRespond(ctx, rest)
    case 'renew':
      return agentSimple(ctx, rest, 'renew')
    default:
      throw usageError(`uso: nexo agent ${SUBCOMMANDS.join('|')} (mira \`nexo agent --help\`)`)
  }
}

// ---- Resolución de sesiones ----

function describeSession(s: AgentSession): string {
  return `${shortId(s.id)} (${s.provider}, ${s.status})`
}

/** Sesión por id completo o prefijo único del id (con o sin `agent-`). */
export function resolveSession(sessions: readonly AgentSession[], ref: string): AgentSession {
  if (ref.trim() === '') throw usageError('la referencia está vacía')
  if (ref.length > 256) throw usageError('la referencia es demasiado larga (máximo 256)')
  const exact = sessions.filter((s) => s.id === ref)
  const matches =
    exact.length > 0
      ? exact
      : sessions.filter((s) => s.id.startsWith(ref) || s.id.replace(/^[a-z]+-/, '').startsWith(ref))
  const [only] = matches
  if (matches.length === 1 && only !== undefined) return only
  if (matches.length === 0) throw notFoundError(`no se encontró la sesión "${sanitize(ref, 64)}"`)
  throw usageError(
    `la referencia "${sanitize(ref, 64)}" es ambigua (${matches.length} coincidencias): ${matches
      .slice(0, 5)
      .map(describeSession)
      .join('; ')}. Usa un id más largo.`,
  )
}

async function lookupSession(
  ctx: Ctx,
  ref: string,
): Promise<{ client: ClientLike; session: AgentSession }> {
  const client = await ctx.client()
  const { sessions } = await client.call('agent.list', {})
  return { client, session: resolveSession(sessions, ref) }
}

const sessionView = (s: AgentSession) => ({
  id: s.id,
  provider: s.provider,
  paneId: s.paneId,
  status: s.status,
  turn: s.turn,
  cwd: s.cwd,
  permissionMode: s.permissionMode,
  ...(s.title === undefined ? {} : { title: s.title }),
  ...(s.model === undefined ? {} : { model: s.model }),
  ...(s.effort === undefined ? {} : { effort: s.effort }),
})

// ---- new ----

const NEW_USAGE =
  'nexo agent new [--provider <id>] [--model <m>] [--effort <e>] [--permissions ask|accept-edits|plan|bypass] [--cwd <ruta>] [--name <título>]'

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function agentNew(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, {
    provider: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    permissions: { type: 'string' },
    cwd: { type: 'string' },
    name: { type: 'string' },
  })
  if (parsed.positionals.length > 0) throw usageError(`uso: ${NEW_USAGE}`)
  const cwdOption = str(parsed, 'cwd')
  if (cwdOption === '') throw usageError('--cwd no puede estar vacío')
  const cwd = resolve(ctx.deps.cwd(), cwdOption ?? '.')
  const provider = str(parsed, 'provider') ?? 'claude'
  const model = str(parsed, 'model')
  const effort = str(parsed, 'effort')
  const permissionsRaw = str(parsed, 'permissions')
  let permissionMode: PermissionMode | undefined
  if (permissionsRaw !== undefined) {
    const p = PermissionMode.safeParse(permissionsRaw)
    if (!p.success) throw usageError('--permissions debe ser ask, accept-edits, plan o bypass')
    permissionMode = p.data
  }
  const name = str(parsed, 'name')

  const client = await ctx.client()
  const { workspaces } = await client.call('workspace.list', {})
  let workspaceId = workspaces.find(
    (w) => w.cwd !== undefined && samePath(w.cwd, cwd, ctx.deps.platform),
  )?.id
  let createdWorkspace = false
  if (workspaceId === undefined) {
    const created = await client.call('workspace.create', { name: basename(cwd) || cwd, cwd })
    workspaceId = created.workspace.id
    createdWorkspace = true
  }
  let tabId: string | undefined
  try {
    // Un panel de agente nace de dividir otro: se crea la pestaña, se divide y se cierra el panel inicial.
    const { tab } = await client.call('tab.create', {
      workspaceId: WorkspaceId.parse(workspaceId),
      ...(name === undefined ? {} : { title: name }),
      cwd,
    })
    tabId = tab.id
    const first = tab.panes[0]
    if (first === undefined)
      throw new CliError('DAEMON_ERROR', 'el daemon creó una pestaña sin paneles')
    const { pane } = await client.call('pane.split', {
      paneId: first.id,
      direction: 'row',
      kind: 'agent',
    })
    await client.call('pane.close', { paneId: first.id })
    const { session } = await client.call('agent.create', {
      paneId: pane.id,
      provider,
      cwd,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
    })
    ctx.emit(
      AgentNewOutput,
      {
        workspaceId,
        tabId: tab.id,
        paneId: pane.id,
        sessionId: session.id,
        provider: session.provider,
        createdWorkspace,
      },
      () => `creada la sesión ${session.id} (${session.provider}) en el panel ${pane.id}`,
    )
  } catch (error) {
    try {
      if (createdWorkspace) {
        await client.call('workspace.close', { workspaceId: WorkspaceId.parse(workspaceId) })
      } else if (tabId !== undefined) {
        await client.call('tab.close', { tabId: TabId.parse(tabId) })
      }
    } catch {
      // el error original es el que importa
    }
    throw classifyError(error)
  }
}

// ---- send ----

const SEND_USAGE = 'nexo agent send <id> [--stdin] [--] <texto...>'

async function agentSend(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, { stdin: { type: 'boolean' } })
  const [ref, ...words] = parsed.positionals
  if (ref === undefined) throw usageError(`uso: ${SEND_USAGE}`)
  const useStdin = flag(parsed, 'stdin')
  if (useStdin && words.length > 0)
    throw usageError('usa el texto como argumentos o --stdin, no ambos')
  if (!useStdin && words.length === 0)
    throw usageError(`falta el texto a enviar (uso: ${SEND_USAGE})`)
  const text = useStdin ? await readStdin(ctx) : words.join(' ')
  if (text.trim() === '') throw usageError('el mensaje está vacío')
  if (utf8ByteLength(text) > LIMITS.maxBlockTextBytes) {
    throw usageError(`el mensaje supera el máximo de ${LIMITS.maxBlockTextBytes} bytes`)
  }
  const { client, session } = await lookupSession(ctx, ref)
  const r = await client.call('agent.send', { sessionId: session.id, text })
  ctx.emit(
    AgentSendOutput,
    { sessionId: session.id, blockId: r.blockId, index: r.index, turn: r.turn },
    () => `enviado (turno ${r.turn})`,
  )
}

// ---- ls ----

async function agentLs(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args)
  if (parsed.positionals.length > 0) throw usageError('uso: nexo agent ls [--json]')
  const client = await ctx.client()
  const { sessions } = await client.call('agent.list', {})
  ctx.emit(AgentLsOutput, { sessions: sessions.map(sessionView) }, () => {
    if (sessions.length === 0) return 'No hay sesiones de agente. Crea una con `nexo agent new`.'
    return sessions
      .map(
        (s) =>
          `${s.id}  ${s.provider}${s.model === undefined ? '' : `/${sanitize(s.model, 40)}`}  ${s.status}  turno ${s.turn}  panel ${shortId(s.paneId)}  ${sanitize(s.cwd, 120)}`,
      )
      .join('\n')
  })
}

// ---- interrupt / close ----

async function agentSimple(
  ctx: Ctx,
  args: string[],
  action: 'interrupt' | 'close' | 'renew',
): Promise<void> {
  const [ref] = expectPositionals(parseArgv(args), 1, 1, `nexo agent ${action} <id>`) as [string]
  const { client, session } = await lookupSession(ctx, ref)
  const sessionId = AgentSessionId.parse(session.id)
  if (action === 'interrupt') await client.call('agent.interrupt', { sessionId })
  else if (action === 'renew')
    await client.call('agent.renew', { sessionId }, { timeoutMs: 120_000 })
  else await client.call('agent.close', { sessionId })
  const done = { interrupt: 'interrumpida', close: 'cerrada', renew: 'renovada' }[action]
  ctx.emit(
    AgentActionOutput,
    { ok: true, action, sessionId },
    () => `${done} la sesión ${session.id}`,
  )
}

// ---- respuestas a permisos y preguntas ----

type Response =
  | { type: 'permission'; optionId: string }
  | { type: 'question'; answers: QuestionAnswer[] }

const isIndex = (token: string, max: number): boolean =>
  /^\d{1,4}$/.test(token) && Number(token) >= 1 && Number(token) <= max

/** Convierte lo que escribió el usuario en una respuesta válida para el bloque; lanza error de uso si no. */
export function buildResponse(block: Block, input: string): Response {
  const text = input.trim()
  if (text === '') throw usageError('la respuesta está vacía')
  if (block.type === 'permission') {
    const byIndex = isIndex(text, block.options.length)
      ? block.options[Number(text) - 1]
      : undefined
    const option = byIndex ?? block.options.find((o) => o.id === text)
    if (option === undefined) {
      throw usageError(`opción no válida: elige 1 a ${block.options.length} o un id de opción`)
    }
    return { type: 'permission', optionId: option.id }
  }
  if (block.type !== 'question') throw usageError('el bloque no espera respuesta')
  const segments = block.questions.length === 1 ? [text] : text.split(';')
  if (segments.length !== block.questions.length) {
    throw usageError(`responde las ${block.questions.length} preguntas separadas por ";"`)
  }
  const answers: QuestionAnswer[] = block.questions.map((q, i) => {
    const segment = (segments[i] ?? '').trim()
    const tokens = segment
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '')
    const labels = q.options.map((o) => o.label)
    if (tokens.length > 0 && tokens.every((t) => isIndex(t, labels.length))) {
      return { questionId: q.id, selected: tokens.map((t) => labels[Number(t) - 1] as string) }
    }
    if (tokens.length > 0 && tokens.every((t) => labels.includes(t))) {
      return { questionId: q.id, selected: tokens }
    }
    if (q.allowText && segment !== '') return { questionId: q.id, selected: [], text: segment }
    throw usageError(`respuesta no válida para "${sanitize(q.question, 60)}"`)
  })
  const problem = validateAnswers(block.questions, answers)
  if (problem !== null) throw usageError(`respuesta no válida: ${sanitize(problem, 120)}`)
  return { type: 'question', answers }
}

async function sendResponse(
  client: ClientLike,
  sessionId: AgentSessionId,
  block: Block,
  response: Response,
): Promise<void> {
  const blockId = BlockId.parse(block.id)
  if (response.type === 'permission') {
    await client.call('agent.respond', {
      type: 'permission',
      sessionId,
      blockId,
      optionId: response.optionId,
    })
  } else {
    await client.call('agent.respond', {
      type: 'question',
      sessionId,
      blockId,
      answers: response.answers,
    })
  }
}

const RESPOND_USAGE = 'nexo agent respond <id> [--block <bloque>] <respuesta...>'

async function agentRespond(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, { block: { type: 'string' } })
  const [ref, ...words] = parsed.positionals
  if (ref === undefined || words.length === 0) throw usageError(`uso: ${RESPOND_USAGE}`)
  const { client, session } = await lookupSession(ctx, ref)
  const sessionId = AgentSessionId.parse(session.id)
  const doc = await AgentDocument.open(client, sessionId)
  try {
    const pending = doc.pending()
    const want = str(parsed, 'block')
    const candidates = want === undefined ? pending : pending.filter((b) => b.id.startsWith(want))
    const [target] = candidates
    if (target === undefined || candidates.length > 1) {
      if (candidates.length === 0) throw notFoundError('no hay permisos ni preguntas pendientes')
      throw usageError(
        `hay ${candidates.length} pendientes; indica uno con --block: ${candidates.map((b) => b.id).join(', ')}`,
      )
    }
    const response = buildResponse(target, words.join(' '))
    await sendResponse(client, sessionId, target, response)
    ctx.emit(
      AgentActionOutput,
      { ok: true, action: 'respond', sessionId, blockId: target.id },
      () =>
        `respondido ${target.type === 'permission' ? 'el permiso' : 'la pregunta'} ${target.id}`,
    )
  } finally {
    doc.dispose()
  }
}

// ---- attach ----

/** Lector de líneas sobre la entrada estándar; `undefined` al terminar. */
class LineReader {
  readonly #iterator: AsyncIterator<Uint8Array | string>
  readonly #decoder = new TextDecoder('utf-8')
  #buffer = ''
  #done = false

  constructor(source: AsyncIterable<Uint8Array | string>) {
    this.#iterator = source[Symbol.asyncIterator]()
  }

  async read(): Promise<string | undefined> {
    for (;;) {
      const i = this.#buffer.indexOf('\n')
      if (i >= 0) {
        const line = this.#buffer.slice(0, i).replace(/\r$/, '')
        this.#buffer = this.#buffer.slice(i + 1)
        return line
      }
      if (this.#done) {
        if (this.#buffer === '') return undefined
        const rest = this.#buffer
        this.#buffer = ''
        return rest
      }
      const next = await this.#iterator.next()
      if (next.done === true) this.#done = true
      else {
        this.#buffer +=
          typeof next.value === 'string'
            ? next.value
            : this.#decoder.decode(next.value, { stream: true })
        // Una línea enorme sin salto no debe crecer sin límite.
        if (this.#buffer.length > 1024 * 1024) this.#buffer = this.#buffer.slice(-1024 * 1024)
      }
    }
  }
}

async function agentAttach(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, { 'no-follow': { type: 'boolean' } })
  const [ref] = expectPositionals(parsed, 1, 1, 'nexo agent attach <id> [--no-follow]') as [string]
  const follow = !flag(parsed, 'no-follow')
  const { client, session } = await lookupSession(ctx, ref)
  const sessionId = AgentSessionId.parse(session.id)
  const printer = new AgentPrinter()
  const emitLine = (line: unknown) => {
    const parsedLine = AgentAttachLine.parse(line)
    ctx.out(`${JSON.stringify(parsedLine)}\n`)
  }

  if (follow) await client.subscribe([...AGENT_EVENTS])
  const doc = await AgentDocument.open(client, sessionId)
  const offs: (() => void)[] = []
  try {
    const printAll = () => {
      for (const block of doc.blocks()) {
        if (ctx.json) emitLine({ sessionId, event: 'block', block })
        else ctx.out(printer.feed(block))
      }
    }
    printAll()
    if (!follow) {
      ctx.out(printer.flush())
      return
    }
    const reader = ctx.json ? undefined : new LineReader(ctx.io.stdin())
    const prompted = new Set<string>()
    let prompting = false
    let hinted = false
    let interactive = reader !== undefined

    const hint = () => {
      if (hinted || ctx.json) return
      hinted = true
      ctx.io.stderr.write(
        `[sin entrada interactiva: responde con \`nexo agent respond ${sessionId} <respuesta>\`]\n`,
      )
    }
    const askOne = async (block: Block): Promise<void> => {
      for (let attempt = 0; attempt < 3 && reader !== undefined; attempt++) {
        ctx.out(printer.flush())
        ctx.out('respuesta> ')
        const line = await Promise.race([
          reader.read(),
          new Promise<undefined>((r) =>
            ctx.signal.addEventListener('abort', () => r(undefined), { once: true }),
          ),
        ])
        if (line === undefined) {
          interactive = false
          return
        }
        try {
          await sendResponse(client, sessionId, block, buildResponse(block, line))
          return
        } catch (error) {
          const message = error instanceof CliError ? error.message : classifyError(error).message
          ctx.io.stderr.write(`nexo: ${sanitize(message, 300)}\n`)
        }
      }
    }
    const promptPending = async () => {
      if (prompting) return
      prompting = true
      try {
        for (const block of doc.pending()) {
          if (prompted.has(block.id) || ctx.signal.aborted) continue
          prompted.add(block.id)
          if (interactive) await askOne(block)
          if (!interactive) hint()
        }
      } finally {
        prompting = false
      }
    }

    await new Promise<void>((resolveDone, rejectDone) => {
      let finished = false
      const finish = (error?: Error) => {
        if (finished) return
        finished = true
        ctx.signal.removeEventListener('abort', onAbort)
        if (error === undefined) resolveDone()
        else rejectDone(error)
      }
      const onAbort = () => finish()
      offs.push(
        doc.subscribe((event) => {
          if (event.type === 'block' || event.type === 'delta') {
            if (ctx.json) {
              if (event.type === 'delta') {
                emitLine({
                  sessionId,
                  event: 'delta',
                  blockId: event.block.id,
                  field: event.field,
                  text: event.text,
                })
              } else emitLine({ sessionId, event: 'block', block: event.block })
            } else ctx.out(printer.feed(event.block))
            void promptPending()
          } else if (event.type === 'synced') {
            if (!ctx.json) printAll()
            void promptPending()
          } else if (event.type === 'status') {
            if (ctx.json) emitLine({ sessionId, event: 'status', status: event.status })
          } else if (event.type === 'removed') {
            if (ctx.json) emitLine({ sessionId, event: 'removed' })
            else ctx.out(`${printer.flush()}[la sesión se cerró]\n`)
            finish()
          }
        }),
        client.on('state', (state) => {
          if (state === 'closed' && !ctx.signal.aborted) {
            finish(unavailableError('se perdió la conexión con el daemon'))
          }
        }),
      )
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      if (ctx.signal.aborted) return finish()
      printAll()
      void promptPending()
    })
    ctx.out(printer.flush())
  } finally {
    for (const off of offs) off()
    doc.dispose()
  }
}
