import { fireEvent, render } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { Markdown, type MarkdownEnv, MarkdownEnvContext } from '../agent/markdown.tsx'
import { PathLink } from './PathLink.tsx'

function withEnv(ui: () => import('solid-js').JSX.Element) {
  const opened: string[] = []
  const env: MarkdownEnv = { baseDir: '/work', openFile: (p) => void opened.push(p) }
  const view = render(() => (
    <MarkdownEnvContext.Provider value={env}>{ui()}</MarkdownEnvContext.Provider>
  ))
  return { ...view, opened }
}

describe('PathLink', () => {
  it('una ruta de un bloque se abre en el visor al pulsarla, resuelta contra la carpeta', () => {
    const { getByRole, opened } = withEnv(() => <PathLink path="src/a.ts" />)
    fireEvent.click(getByRole('button'))
    expect(opened).toEqual(['/work/src/a.ts'])
  })

  it('sin entorno (o con una ruta que no resuelve) es solo texto', () => {
    const plain = render(() => <PathLink path="src/a.ts" />)
    expect(plain.container.querySelector('button')).toBeNull()
    expect(plain.container.textContent).toBe('src/a.ts')
    const bad = withEnv(() => <PathLink path="../../../etc/passwd" />)
    expect(bad.container.querySelector('button')).toBeNull()
  })

  it('una ruta con HTML se pinta como texto', () => {
    const { container } = withEnv(() => <PathLink path="/work/<img src=x onerror=alert(1)>.ts" />)
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('enlaces a archivos en el texto del agente', () => {
  it('con el entorno del panel, un enlace relativo abre el visor y las imágenes siguen sin cargarse', () => {
    const { container, opened } = withEnv(() => (
      <Markdown text={'ver [guía](docs/guia.md) ![x](img/a.png) [web](https://example.com)'} />
    ))
    fireEvent.click(container.querySelector('.md-file-link') as HTMLElement)
    expect(opened).toEqual(['/work/docs/guia.md'])
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a[href^="https"]')?.getAttribute('rel')).toContain('noopener')
  })

  it('sin entorno, los relativos siguen bloqueados como antes', () => {
    const { container } = render(() => <Markdown text="[guía](docs/guia.md)" />)
    expect(container.querySelector('a')).toBeNull()
  })
})
