import { type Block, type Question, type QuestionAnswer, validateAnswers } from '@nexo/contracts'
import {
  createContext,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  Show,
  Switch,
  useContext,
} from 'solid-js'
import { es, format } from '../i18n/es.ts'
import { Icon, type IconName } from '../ui/Icon.tsx'
import { PathLink } from '../viewer/PathLink.tsx'
import { ansiClass, parseAnsi, tailLines } from './ansi.ts'
import { diffStats, parseDiff } from './diff.ts'
import { formatDuration, usageParts } from './format.ts'
import { Markdown } from './markdown.tsx'
import type { AgentPaneModel } from './pane-model.ts'

/** Lo que los bloques necesitan de su modelo: el panel de agente lo cumple y la vista de historial usa una versión de solo lectura. */
export type BlockModel = Pick<
  AgentPaneModel,
  'block' | 'expanded' | 'toggle' | 'respondPermission' | 'respondQuestion' | 'removed' | 'status'
>

export const AgentModelContext = createContext<BlockModel>()

export function useAgentModel(): BlockModel {
  const m = useContext(AgentModelContext)
  if (m === undefined) throw new Error('falta el modelo del panel de agente')
  return m
}

/** Líneas de salida que se pintan como mucho (las últimas): una salida enorme no debe congelar la página. */
export const MAX_OUTPUT_LINES = 1500

type Of<T extends Block['type']> = Extract<Block, { type: T }>

/** Altura estimada (px) de un bloque aún no medido. */
export function estimateHeight(block: Block | undefined): number {
  switch (block?.type) {
    case 'user':
      return 56
    case 'text':
      return Math.min(900, 40 + Math.ceil(block.text.length / 90) * 20)
    case 'permission':
    case 'question':
      return 120
    case 'plan':
      return 90
    default:
      return 36
  }
}

export function BlockView(props: { id: string }) {
  const model = useAgentModel()
  const block = model.block(props.id)
  return (
    <Show when={block()}>
      {(b) => (
        <div class={`blk blk-${b().type}`} data-block-id={props.id} data-block-type={b().type}>
          <Switch>
            <Match when={b().type === 'user'}>
              <div class="bubble">{(b() as Of<'user'>).text}</div>
            </Match>
            <Match when={b().type === 'text'}>
              <TextView block={b() as Of<'text'>} />
            </Match>
            <Match when={b().type === 'reasoning'}>
              <ReasoningView block={b() as Of<'reasoning'>} />
            </Match>
            <Match when={b().type === 'action'}>
              <ActionView block={b() as Of<'action'>} />
            </Match>
            <Match when={b().type === 'permission'}>
              <PermissionView block={b() as Of<'permission'>} />
            </Match>
            <Match when={b().type === 'question'}>
              <QuestionView block={b() as Of<'question'>} />
            </Match>
            <Match when={b().type === 'plan'}>
              <PlanView block={b() as Of<'plan'>} />
            </Match>
            <Match when={b().type === 'error'}>
              <ErrorView block={b() as Of<'error'>} />
            </Match>
            <Match when={b().type === 'usage'}>
              <UsageView block={b() as Of<'usage'>} />
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  )
}

function TextView(props: { block: Of<'text'> }) {
  return (
    <>
      <Markdown text={props.block.text} />
      <Show when={!props.block.complete}>
        <span class="caret" aria-hidden="true" />
      </Show>
      <Show when={props.block.truncated === true}>
        <p class="notice">{es.agent.truncated}</p>
      </Show>
    </>
  )
}

/** Cabecera plegable: botón con `aria-expanded` que controla el cuerpo. */
function Fold(props: { id: string; head: JSX.Element; children: JSX.Element; class?: string }) {
  const model = useAgentModel()
  const open = model.expanded(props.id)
  const bodyId = `fold-${props.id}`
  return (
    <div class={`fold ${props.class ?? ''}`} classList={{ open: open() }}>
      <button
        type="button"
        class="fold-head"
        aria-expanded={open()}
        aria-controls={bodyId}
        onClick={() => model.toggle(props.id)}
      >
        <Icon name="chevron-right" size="sm" class="fold-chevron" />
        {props.head}
      </button>
      <Show when={open()}>
        <div class="fold-body" id={bodyId}>
          {props.children}
        </div>
      </Show>
    </div>
  )
}

function ReasoningView(props: { block: Of<'reasoning'> }) {
  return (
    <Fold
      id={props.block.id}
      class="reasoning"
      head={
        <span class="fold-title">
          {props.block.complete ? es.agent.reasoning : es.agent.thinking}
        </span>
      }
    >
      <Markdown text={props.block.text} />
      <Show when={props.block.truncated === true}>
        <p class="notice">{es.agent.truncated}</p>
      </Show>
    </Fold>
  )
}

const STATUS_ICON = {
  pending: 'circle',
  running: 'circle-half',
  ok: 'check',
  error: 'x',
} as const satisfies Record<string, IconName>

function ActionView(props: { block: Of<'action'> }) {
  const b = () => props.block
  const meta = () => {
    const parts: string[] = []
    if (b().exitCode !== undefined && b().exitCode !== null) {
      parts.push(format(es.agent.exitCode, { code: b().exitCode as number }))
    }
    const d = b().durationMs
    if (d !== undefined) parts.push(formatDuration(d))
    return parts.join(' · ')
  }
  return (
    <Fold
      id={b().id}
      class={`action status-${b().status}`}
      head={
        <>
          <span
            class="status-icon"
            role="img"
            aria-label={es.agent.actionStatus[b().status]}
            title={es.agent.actionStatus[b().status]}
          >
            <Icon name={STATUS_ICON[b().status]} size="sm" />
          </span>
          <span class="kind">{es.agent.actionKind[b().kind]}</span>
          <span class="fold-title ellipsis" title={b().title}>
            {b().title}
          </span>
          <Show when={meta() !== ''}>
            <span class="meta">{meta()}</span>
          </Show>
        </>
      }
    >
      <Show when={b().path}>
        {(p) => (
          <p class="path">
            <PathLink path={p()} />
          </p>
        )}
      </Show>
      <Show when={b().input}>
        {(input) => (
          <>
            <h5>{es.agent.input}</h5>
            <pre class="output">{input()}</pre>
          </>
        )}
      </Show>
      <Show when={b().diff}>{(d) => <DiffView patch={d().patch} path={d().path} />}</Show>
      <Show when={b().output}>
        {(out) => (
          <>
            <h5>{es.agent.output}</h5>
            <AnsiOutput text={out()} />
          </>
        )}
      </Show>
      <Show when={b().truncated === true}>
        <p class="notice">{es.agent.truncated}</p>
      </Show>
    </Fold>
  )
}

/** Salida con colores ANSI traducidos a clases; todo lo demás se descarta. */
export function AnsiOutput(props: { text: string }) {
  const view = createMemo(() => {
    const tail = tailLines(props.text, MAX_OUTPUT_LINES)
    return { spans: parseAnsi(tail.text), hidden: tail.hidden }
  })
  return (
    <>
      <Show when={view().hidden > 0}>
        <p class="notice">{format(es.agent.hiddenLines, { count: view().hidden })}</p>
      </Show>
      <pre class="output">
        <For each={view().spans}>
          {(s) => <span class={ansiClass(s) || undefined}>{s.text}</span>}
        </For>
      </pre>
    </>
  )
}

export function DiffView(props: { patch: string; path?: string }) {
  const parsed = createMemo(() => parseDiff(props.patch))
  const stats = createMemo(() => diffStats(parsed().lines))
  return (
    <div class="diff">
      <p class="diff-stats">
        <Show when={props.path}>{(p) => <PathLink class="path" path={p()} />}</Show>
        <span class="add">+{stats().added}</span> <span class="del">−{stats().removed}</span>
      </p>
      <pre class="diff-body">
        <For each={parsed().lines}>
          {(l) => (
            <span class={`diff-line diff-${l.kind}`}>
              {l.text}
              {'\n'}
            </span>
          )}
        </For>
      </pre>
      <Show when={parsed().hidden > 0}>
        <p class="notice">{format(es.agent.hiddenLines, { count: parsed().hidden })}</p>
      </Show>
    </div>
  )
}

const OPTION_KIND_CLASS = {
  'allow-once': 'allow',
  'allow-always': 'allow',
  'reject-once': 'reject',
  'reject-always': 'reject',
} as const

/** «1» con una opción, «1-N» con varias: el número real de opciones. */
export function permissionKeys(count: number): string {
  return count <= 1 ? '1' : `1-${count}`
}

function PermissionView(props: { block: Of<'permission'> }) {
  const model = useAgentModel()
  const [sending, setSending] = createSignal(false)
  let group!: HTMLFieldSetElement
  const pending = () => props.block.state === 'pending'
  const enabled = () => pending() && !sending() && !model.removed() && model.status() !== 'error'

  const choose = async (optionId: string) => {
    if (!enabled()) return
    setSending(true)
    try {
      await model.respondPermission(props.block.id, optionId)
    } finally {
      setSending(false)
    }
  }
  const buttons = () => [...group.querySelectorAll<HTMLButtonElement>('button[data-option]')]
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const digit = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1
    const opt = props.block.options[digit]
    if (opt !== undefined) {
      e.preventDefault()
      void choose(opt.id)
      return
    }
    const list = buttons()
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % list.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (i - 1 + list.length) % list.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = list.length - 1
    if (next >= 0) {
      e.preventDefault()
      list[next]?.focus()
    }
  }
  const resolvedLabel = () => {
    const kind = props.block.options.find((o) => o.id === props.block.selectedOptionId)?.kind
    if (kind === 'allow-always') return es.agent.permissionAlways.accepted
    if (kind === 'reject-always') return es.agent.permissionAlways.rejected
    return es.agent.permissionState[props.block.state]
  }

  return (
    <section
      class="perm"
      classList={{ pending: pending() }}
      data-state={props.block.state}
      aria-label={format(es.agent.permissionFor, { title: props.block.title })}
    >
      <header>
        <span class="perm-tool">{props.block.tool}</span>
        <strong class="perm-title">{props.block.title}</strong>
      </header>
      <Show when={props.block.detail}>{(d) => <pre class="output">{d()}</pre>}</Show>
      <Show
        when={pending()}
        fallback={
          <p class="perm-result" data-state={props.block.state}>
            {resolvedLabel()}
          </p>
        }
      >
        <fieldset ref={group} class="perm-options" onKeyDown={onKeyDown}>
          <legend class="sr-only">{es.agent.permissionOptions}</legend>
          <For each={props.block.options}>
            {(o, i) => (
              <button
                type="button"
                class={`perm-option ${OPTION_KIND_CLASS[o.kind]}`}
                data-option={o.id}
                data-autofocus={i() === 0 ? '' : undefined}
                disabled={!enabled()}
                aria-keyshortcuts={String(i() + 1)}
                onClick={() => void choose(o.id)}
              >
                <kbd>{i() + 1}</kbd> {o.label}
              </button>
            )}
          </For>
        </fieldset>
        <p class="hint">
          {format(es.agent.permissionHint, {
            keys: permissionKeys(Math.min(props.block.options.length, 9)),
          })}
        </p>
      </Show>
    </section>
  )
}

function QuestionView(props: { block: Of<'question'> }) {
  const model = useAgentModel()
  const [picked, setPicked] = createSignal<Record<string, string[]>>({})
  const [typed, setTyped] = createSignal<Record<string, string>>({})
  const [sending, setSending] = createSignal(false)
  const pending = () => props.block.state === 'pending'

  const answers = (): QuestionAnswer[] =>
    props.block.questions.flatMap((q) => {
      const selected = picked()[q.id] ?? []
      const text = (typed()[q.id] ?? '').trim()
      if (selected.length === 0 && text === '') return []
      return [{ questionId: q.id, selected, ...(q.allowText && text !== '' ? { text } : {}) }]
    })
  const problem = createMemo(() => validateAnswers(props.block.questions, answers()))
  const enabled = () => pending() && !sending() && !model.removed() && model.status() !== 'error'

  const toggle = (q: Question, label: string) => {
    setPicked((cur) => {
      const old = cur[q.id] ?? []
      const next = q.multiSelect
        ? old.includes(label)
          ? old.filter((l) => l !== label)
          : [...old, label]
        : [label]
      return { ...cur, [q.id]: next }
    })
  }
  const submit = async (e: Event) => {
    e.preventDefault()
    if (!enabled() || problem() !== null) return
    setSending(true)
    try {
      await model.respondQuestion(props.block.id, answers())
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      class="ask"
      classList={{ pending: pending() }}
      data-state={props.block.state}
      aria-label={es.agent.questionLabel}
      onSubmit={submit}
    >
      <For each={props.block.questions}>
        {(q) => (
          <fieldset disabled={!enabled()}>
            <legend>
              <Show when={q.header}>{(h) => <span class="ask-header">{h()}</span>}</Show>
              {q.question}
            </legend>
            <For each={q.options}>
              {(o) => (
                <label class="ask-option">
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name={`${props.block.id}-${q.id}`}
                    checked={(picked()[q.id] ?? []).includes(o.label)}
                    onChange={() => toggle(q, o.label)}
                  />
                  <span>
                    {o.label}
                    <Show when={o.description}>{(d) => <small>{d()}</small>}</Show>
                  </span>
                </label>
              )}
            </For>
            <Show when={q.allowText}>
              <input
                type="text"
                class="ask-text"
                aria-label={format(es.agent.otherAnswer, { question: q.header ?? q.question })}
                placeholder={es.agent.otherAnswerPlaceholder}
                maxLength={2000}
                value={typed()[q.id] ?? ''}
                onInput={(e) => setTyped((cur) => ({ ...cur, [q.id]: e.currentTarget.value }))}
              />
            </Show>
          </fieldset>
        )}
      </For>
      <Show
        when={pending()}
        fallback={
          <p class="perm-result" data-state={props.block.state}>
            {es.agent.questionState[props.block.state]}
            <Show when={props.block.answers}>
              {(a) => (
                <ul class="ask-answers">
                  <For each={a()}>
                    {(x) => (
                      <li>
                        {[...x.selected, ...(x.text === undefined ? [] : [x.text])].join(', ')}
                      </li>
                    )}
                  </For>
                </ul>
              )}
            </Show>
          </p>
        }
      >
        <button type="submit" class="primary" disabled={!enabled() || problem() !== null}>
          {es.agent.answer}
        </button>
      </Show>
    </form>
  )
}

const PLAN_ICON = { pending: '○', 'in-progress': '◐', completed: '●' } as const

function PlanView(props: { block: Of<'plan'> }) {
  return (
    <section class="plan" aria-label={es.agent.plan}>
      <h4>{es.agent.plan}</h4>
      <ol>
        <For each={props.block.entries}>
          {(e) => (
            <li data-status={e.status}>
              <span role="img" aria-label={es.agent.planStatus[e.status]}>
                {PLAN_ICON[e.status]}
              </span>{' '}
              {e.text}
            </li>
          )}
        </For>
      </ol>
      <Show when={props.block.markdown}>{(m) => <Markdown text={m()} />}</Show>
    </section>
  )
}

function ErrorView(props: { block: Of<'error'> }) {
  return (
    <div class="err" role="alert">
      <strong>{es.agent.error}</strong> <code>{props.block.code}</code>
      <Show when={props.block.fatal}>
        <span class="badge">{es.agent.fatal}</span>
      </Show>
      <Show when={props.block.retryable === true}>
        <span class="badge">{es.agent.retryable}</span>
      </Show>
      <p>{props.block.message}</p>
    </div>
  )
}

function UsageView(props: { block: Of<'usage'> }) {
  const parts = () =>
    usageParts(props.block.usage, {
      input: es.agent.tokensIn,
      output: es.agent.tokensOut,
      cache: es.agent.tokensCache,
    })
  return (
    <p class="usage">
      <span>{es.agent.stopReason[props.block.stopReason]}</span>
      <For each={parts()}>{(p) => <span>{p}</span>}</For>
    </p>
  )
}
