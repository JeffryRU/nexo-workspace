import { Lexer, type Token, type Tokens } from 'marked'
import { createMemo, For, type JSX, Match, Show, Switch } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { es } from '../i18n/es.ts'
import { safeHref } from './safe-url.ts'

/**
 * Markdown seguro. `marked` solo se usa como analizador (`Lexer.lex`): las fichas se convierten en nodos de
 * Solid, así que jamás se genera una cadena HTML ni se usa `innerHTML`. El HTML crudo, las imágenes y los
 * enlaces con esquemas peligrosos se muestran como texto.
 */

/** Más texto que esto no se analiza como Markdown (los bloques ya traen un tope de 128 KiB). */
export const MAX_MARKDOWN_CHARS = 256 * 1024
/** Anidamiento (citas, listas) a partir del cual se deja de interpretar y se muestra el texto tal cual. */
export const MAX_MARKDOWN_DEPTH = 24

export type MarkdownTokens = { tokens: Token[]; failed: false } | { tokens: []; failed: true }

/**
 * Hasta este tamaño el texto se analiza entero (fidelidad total). Por encima se parte en trozos separados por
 * líneas en blanco: el análisis de énfasis de `marked` es cuadrático con entradas patológicas (`*a*a*a…`), así que
 * acotar el trozo acota el peor caso, y los trozos ya terminados se reutilizan mientras el texto sigue creciendo.
 */
export const FULL_PARSE_CHARS = 12_000
/** Un trozo (sin código vallado) más largo que esto no se interpreta: se muestra como texto. */
export const MAX_CHUNK_CHARS = 8_000

const LF = String.fromCharCode(10)
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** Parte el texto en trozos de bloques por líneas en blanco, sin cortar los bloques de código vallados. */
export function splitChunks(text: string): { text: string; fenced: boolean }[] {
  const chunks: { text: string; fenced: boolean }[] = []
  let current: string[] = []
  let fence: string | undefined
  let fenced = false
  const push = () => {
    if (current.length > 0) chunks.push({ text: current.join(LF), fenced })
    current = []
    fenced = false
  }
  for (const line of text.split(LF)) {
    if (fence !== undefined) {
      current.push(line)
      const close = FENCE.exec(line)?.[1]
      if (
        close !== undefined &&
        close[0] === fence[0] &&
        close.length >= fence.length &&
        line.trim() === close
      ) {
        fence = undefined
      }
      continue
    }
    const open = FENCE.exec(line)
    if (open !== null) {
      fence = open[1] as string
      fenced = true
      current.push(line)
    } else if (line.trim() === '') {
      push()
    } else current.push(line)
  }
  push()
  return chunks
}

export function parseMarkdown(text: string): MarkdownTokens {
  if (text.length > MAX_MARKDOWN_CHARS) return { tokens: [], failed: true }
  try {
    if (text.length <= FULL_PARSE_CHARS) {
      return { tokens: Lexer.lex(text, { gfm: true, breaks: false }), failed: false }
    }
    const tokens: Token[] = []
    for (const chunk of splitChunks(text)) {
      if (!chunk.fenced && chunk.text.length > MAX_CHUNK_CHARS) {
        tokens.push({ type: 'plain', raw: chunk.text, text: chunk.text })
      } else tokens.push(...Lexer.lex(chunk.text, { gfm: true, breaks: false }))
    }
    return { tokens, failed: false }
  } catch {
    // Anidamiento extremo (RangeError) u otro fallo: se muestra como texto plano.
    return { tokens: [], failed: true }
  }
}

export function Markdown(props: { text: string }) {
  // Los bloques cuyo texto no cambió conservan su ficha (y por tanto su DOM): al llegar texto solo se repinta el final.
  let known = new Map<string, Token>()
  const parsed = createMemo((): MarkdownTokens => {
    const p = parseMarkdown(props.text)
    if (p.failed) return p
    const next = new Map<string, Token>()
    const tokens = p.tokens.map((t) => {
      const kept = known.get(t.raw) ?? t
      next.set(t.raw, kept)
      return kept
    })
    known = next
    return { tokens, failed: false }
  })
  return (
    <div class="md">
      <Show
        when={!parsed().failed}
        fallback={<pre class="md-plain">{props.text.slice(0, MAX_MARKDOWN_CHARS)}</pre>}
      >
        <Blocks tokens={parsed().tokens} depth={0} />
      </Show>
    </div>
  )
}

function Blocks(props: { tokens: Token[]; depth: number }) {
  return <For each={props.tokens}>{(t) => <BlockToken token={t} depth={props.depth} />}</For>
}

function BlockToken(props: { token: Token; depth: number }) {
  const t = () => props.token
  return (
    <Show
      when={props.depth <= MAX_MARKDOWN_DEPTH}
      fallback={<pre class="md-plain">{(t() as { raw?: string }).raw ?? ''}</pre>}
    >
      <Switch fallback={<RawText raw={(t() as { raw?: string }).raw} />}>
        <Match when={t().type === 'space' || t().type === 'def'}>{null}</Match>
        <Match when={t().type === 'paragraph'}>
          <p>
            <Inline tokens={(t() as Tokens.Paragraph).tokens} />
          </p>
        </Match>
        <Match when={t().type === 'text'}>
          <p>
            <Show when={(t() as Tokens.Text).tokens} fallback={(t() as Tokens.Text).text}>
              {(inner) => <Inline tokens={inner()} />}
            </Show>
          </p>
        </Match>
        <Match when={t().type === 'heading'}>
          <Dynamic component={headingTag((t() as Tokens.Heading).depth)} class="md-heading">
            <Inline tokens={(t() as Tokens.Heading).tokens} />
          </Dynamic>
        </Match>
        <Match when={t().type === 'hr'}>
          <hr />
        </Match>
        <Match when={t().type === 'blockquote'}>
          <blockquote>
            <Blocks tokens={(t() as Tokens.Blockquote).tokens} depth={props.depth + 1} />
          </blockquote>
        </Match>
        <Match when={t().type === 'code'}>
          <CodeBlock code={(t() as Tokens.Code).text} lang={(t() as Tokens.Code).lang} />
        </Match>
        <Match when={t().type === 'list'}>
          <ListView list={t() as Tokens.List} depth={props.depth} />
        </Match>
        <Match when={t().type === 'table'}>
          <TableView table={t() as Tokens.Table} />
        </Match>
        <Match when={t().type === 'plain'}>
          <pre class="md-plain">{(t() as { text: string }).text}</pre>
        </Match>
        <Match when={t().type === 'html'}>
          {/* HTML crudo: se muestra como texto, nunca se interpreta. */}
          <pre class="md-plain">{(t() as Tokens.HTML).text}</pre>
        </Match>
      </Switch>
    </Show>
  )
}

function RawText(props: { raw: string | undefined }) {
  return <Show when={props.raw}>{(raw) => <p>{raw()}</p>}</Show>
}

const HEADING_TAGS = ['h3', 'h4', 'h5', 'h6', 'h6', 'h6'] as const
/** Los títulos del Markdown del agente son más bajos que los de la interfaz. */
function headingTag(depth: number): (typeof HEADING_TAGS)[number] {
  return HEADING_TAGS[Math.min(Math.max(depth, 1), 6) - 1] ?? 'h6'
}

function ListView(props: { list: Tokens.List; depth: number }) {
  const start = () => {
    const s = props.list.start
    return typeof s === 'number' && Number.isFinite(s) ? s : 1
  }
  const items = () => (
    <For each={props.list.items}>
      {(item) => (
        <li classList={{ task: item.task }}>
          <Show when={item.task}>
            <input
              type="checkbox"
              checked={item.checked === true}
              disabled
              aria-label={es.agent.task}
            />
          </Show>
          <Blocks
            tokens={item.tokens.filter((t) => t.type !== 'checkbox')}
            depth={props.depth + 1}
          />
        </li>
      )}
    </For>
  )
  return (
    <Show when={props.list.ordered} fallback={<ul>{items()}</ul>}>
      <ol start={start()}>{items()}</ol>
    </Show>
  )
}

function TableView(props: { table: Tokens.Table }) {
  const cls = (align: string | null) => (align === null ? undefined : `md-align-${align}`)
  return (
    <div class="md-table-wrap">
      <table>
        <thead>
          <tr>
            <For each={props.table.header}>
              {(c) => (
                <th class={cls(c.align)} scope="col">
                  <Inline tokens={c.tokens} />
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.table.rows}>
            {(row) => (
              <tr>
                <For each={row}>
                  {(c) => (
                    <td class={cls(c.align)}>
                      <Inline tokens={c.tokens} />
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

/** El nombre del lenguaje de un bloque de código, saneado (solo una palabra corta). */
export function codeLanguage(lang: string | undefined): string | undefined {
  const first = (lang ?? '').trim().split(/\s+/)[0] ?? ''
  return /^[A-Za-z0-9_+#.-]{1,24}$/.test(first) ? first : undefined
}

export function CodeBlock(props: { code: string; lang?: string | undefined }) {
  const lang = () => codeLanguage(props.lang)
  const copy = () => {
    void navigator.clipboard?.writeText(props.code).catch(() => {})
  }
  return (
    <div class="md-code">
      <div class="md-code-bar">
        <span class="md-code-lang">{lang() ?? es.agent.code}</span>
        <button type="button" class="text-button" onClick={copy}>
          {es.agent.copy}
        </button>
      </div>
      <pre>
        <code>{props.code}</code>
      </pre>
    </div>
  )
}

function Inline(props: { tokens: Token[] | undefined }): JSX.Element {
  return (
    <For each={props.tokens ?? []}>
      {(t) => (
        <Switch fallback={(t as { raw?: string }).raw ?? ''}>
          <Match when={t.type === 'text' || t.type === 'escape'}>
            <Show when={(t as Tokens.Text).tokens} fallback={(t as Tokens.Text).text}>
              {(inner) => <Inline tokens={inner()} />}
            </Show>
          </Match>
          <Match when={t.type === 'strong'}>
            <strong>
              <Inline tokens={(t as Tokens.Strong).tokens} />
            </strong>
          </Match>
          <Match when={t.type === 'em'}>
            <em>
              <Inline tokens={(t as Tokens.Em).tokens} />
            </em>
          </Match>
          <Match when={t.type === 'del'}>
            <del>
              <Inline tokens={(t as Tokens.Del).tokens} />
            </del>
          </Match>
          <Match when={t.type === 'codespan'}>
            <code class="md-inline-code">{(t as Tokens.Codespan).text}</code>
          </Match>
          <Match when={t.type === 'br'}>
            <br />
          </Match>
          <Match when={t.type === 'link'}>
            <LinkView link={t as Tokens.Link} />
          </Match>
          <Match when={t.type === 'image'}>
            {/* Nunca se cargan imágenes remotas (rastreo, exfiltración): solo se muestra su texto. */}
            <span class="md-image" title={es.agent.imageBlocked}>
              [{es.agent.image}: {(t as Tokens.Image).text || es.agent.untitled}]
            </span>
          </Match>
          <Match when={t.type === 'html'}>{(t as Tokens.HTML).text}</Match>
          <Match when={t.type === 'checkbox'}>{null}</Match>
        </Switch>
      )}
    </For>
  )
}

function LinkView(props: { link: Tokens.Link }) {
  const href = createMemo(() => safeHref(props.link.href))
  return (
    <Show
      when={href()}
      fallback={
        <span class="md-link-blocked" title={es.agent.linkBlocked}>
          <Inline tokens={props.link.tokens} />
        </span>
      }
    >
      {(url) => (
        <a href={url()} target="_blank" rel="noopener noreferrer nofollow" title={url()}>
          <Inline tokens={props.link.tokens} />
        </a>
      )}
    </Show>
  )
}
