import { agentCommand } from './commands/agent.ts'
import { daemonCommand } from './commands/daemon.ts'
import { fsCommand } from './commands/fs.ts'
import { historyCommand } from './commands/history.ts'
import { limitsCommand } from './commands/limits.ts'
import { lsCommand } from './commands/ls.ts'
import { memoryCommand } from './commands/memory.ts'
import { newCommand } from './commands/new.ts'
import { openCommand } from './commands/open.ts'
import { closeCommand, focusCommand, killCommand, renameCommand } from './commands/pane-ops.ts'
import { readCommand } from './commands/read.ts'
import { sendCommand } from './commands/send.ts'
import { splitCommand } from './commands/split.ts'
import { Ctx, type Deps } from './context.ts'
import { classifyError, EXIT, usageError } from './errors.ts'
import { COMMANDS, type CommandName, GENERAL_HELP, GLOBALS, HELP } from './help.ts'
import { ErrorOutput } from './schemas.ts'
import { sanitize } from './text.ts'
import { CLI_VERSION } from './version.ts'

type Handler = (ctx: Ctx, args: string[]) => Promise<void>

const HANDLERS: Record<CommandName, Handler> = {
  ls: lsCommand,
  new: newCommand,
  split: splitCommand,
  send: sendCommand,
  read: readCommand,
  focus: focusCommand,
  kill: killCommand,
  close: closeCommand,
  rename: renameCommand,
  agent: agentCommand,
  memory: memoryCommand,
  fs: fsCommand,
  history: historyCommand,
  limits: limitsCommand,
  open: openCommand,
  daemon: daemonCommand,
}

const isCommand = (name: string): name is CommandName =>
  (COMMANDS as readonly string[]).includes(name)

function commandHelp(name: CommandName): string {
  return `${HELP[name]}\n${GLOBALS}\n`
}

function reportError(deps: Deps, json: boolean, error: unknown): number {
  const err = classifyError(error)
  if (json) {
    const body = ErrorOutput.parse({
      error: { code: err.kind, exit: err.exitCode, message: sanitize(err.message, 1000) },
    })
    deps.io.stderr.write(`${JSON.stringify(body)}\n`)
  } else {
    deps.io.stderr.write(`nexo: ${sanitize(err.message, 1000)}\n`)
  }
  if (deps.env.NEXO_DEBUG === '1' && error instanceof Error) {
    deps.io.stderr.write(
      `${sanitize(error.stack ?? String(error), 8000).replaceAll('\\x0a', '\n')}\n`,
    )
  }
  return err.exitCode
}

/** Punto de entrada testeable: recibe los argumentos (sin `node` ni el script) y devuelve el código de salida. */
export async function runCli(argv: readonly string[], deps: Deps): Promise<number> {
  const dashIndex = argv.indexOf('--')
  const flags = dashIndex === -1 ? argv : argv.slice(0, dashIndex)
  const json = flags.includes('--json')
  const ctx = new Ctx(deps, { json, autostart: !flags.includes('--no-start') })
  try {
    let i = 0
    while (i < argv.length) {
      const arg = argv[i] as string
      if (arg === '--') break
      if (!arg.startsWith('-')) break
      if (arg === '--help' || arg === '-h') {
        deps.io.stdout.write(GENERAL_HELP)
        return EXIT.ok
      }
      if (arg === '--version' || arg === '-V') {
        deps.io.stdout.write(`nexo ${CLI_VERSION}\n`)
        return EXIT.ok
      }
      if (arg !== '--json' && arg !== '--no-start') {
        throw usageError(`opción desconocida: ${sanitize(arg, 64)} (mira \`nexo --help\`)`)
      }
      i++
    }
    const name = argv[i]
    const rest = argv.slice(i + 1)
    if (name === undefined || name === 'help') {
      const topic = rest[0]
      if (topic !== undefined && isCommand(topic)) deps.io.stdout.write(commandHelp(topic))
      else deps.io.stdout.write(GENERAL_HELP)
      return EXIT.ok
    }
    if (!isCommand(name)) {
      throw usageError(`comando desconocido: ${sanitize(name, 64)} (mira \`nexo --help\`)`)
    }
    const restFlags = rest.indexOf('--') === -1 ? rest : rest.slice(0, rest.indexOf('--'))
    if (restFlags.includes('--help') || restFlags.includes('-h')) {
      deps.io.stdout.write(commandHelp(name))
      return EXIT.ok
    }
    await HANDLERS[name](ctx, rest)
    return ctx.exitCode
  } catch (error) {
    return reportError(deps, json, error)
  } finally {
    ctx.closeAll()
  }
}
