import { describe, expect, it } from 'vitest'
import { AgentPrinter } from './agent-render.ts'
import { blk, PERMISSION, QUESTION } from './test-helpers.ts'

const action = (n: number, status: string, extra: Record<string, unknown> = {}) =>
  blk(n, { type: 'action', kind: 'exec', status, tool: 'Bash', title: 'ls', ...extra })

describe('AgentPrinter', () => {
  it('texto en streaming: imprime solo lo nuevo y cierra la línea al completarse', () => {
    const p = new AgentPrinter()
    const t = (text: string, complete = false) => blk(0, { type: 'text', text, complete })
    expect(p.feed(t('Ho'))).toBe('Ho')
    expect(p.feed(t('Hola'))).toBe('la')
    expect(p.feed(t('Hola'))).toBe('')
    expect(p.feed(t('Hola', true))).toBe('\n')
    expect(p.feed(t('Hola', true))).toBe('')
  })

  it('cierra la línea abierta antes de pintar otro bloque', () => {
    const p = new AgentPrinter()
    p.feed(blk(0, { type: 'text', text: 'a', complete: false }))
    expect(p.feed(blk(1, { type: 'user', text: 'hey' }))).toBe('\n> hey\n')
    expect(p.flush()).toBe('')
    p.feed(blk(2, { type: 'text', text: 'b', complete: false }))
    expect(p.flush()).toBe('\n')
  })

  it('el razonamiento lleva marca; un bloque completo de golpe termina con salto', () => {
    const p = new AgentPrinter()
    expect(p.feed(blk(0, { type: 'reasoning', text: 'pienso', complete: true }))).toBe('~ pienso\n')
    expect(p.feed(blk(1, { type: 'text', text: 'listo\n', complete: true }))).toBe('listo\n')
  })

  it('acciones: encabezado al empezar y resultado con salida acotada', () => {
    const p = new AgentPrinter()
    expect(p.feed(action(0, 'running'))).toBe('[Bash] ls\n')
    expect(p.feed(action(0, 'running'))).toBe('')
    const output = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')
    const done = p.feed(action(0, 'ok', { output, exitCode: 0 }))
    expect(done).toContain('  -> ok (código 0)')
    expect(done).toContain('  | l0')
    expect(done).toContain('… (18 líneas más)')
    expect(done).not.toContain('l20')
    // una acción que llega ya terminada (snapshot) lleva su encabezado
    expect(new AgentPrinter().feed(action(1, 'error', { exitCode: 2 }))).toBe(
      '[Bash] ls\n  -> error (código 2)\n',
    )
  })

  it('permisos: pendiente con opciones y luego su resolución', () => {
    const p = new AgentPrinter()
    const pending = p.feed(PERMISSION(0, 'pending', { detail: 'rm -rf x' }))
    expect(pending).toContain('? Permiso: Ejecutar ls [Bash]')
    expect(pending).toContain('rm -rf x')
    expect(pending).toContain('  2) Rechazar')
    expect(p.feed(PERMISSION(0))).toBe('')
    expect(p.feed(PERMISSION(0, 'accepted', { selectedOptionId: 'allow' }))).toBe(
      '  permiso aceptado: Permitir\n',
    )
    expect(new AgentPrinter().feed(PERMISSION(1, 'cancelled'))).toBe('  permiso cancelado\n')
  })

  it('preguntas: opciones, texto libre y estados finales', () => {
    const p = new AgentPrinter()
    const q = QUESTION(0, {
      questions: [
        {
          id: 'q1',
          question: '¿Cuál?',
          options: [{ label: 'A' }],
          multiSelect: true,
          allowText: true,
        },
      ],
    })
    const out = p.feed(q)
    expect(out).toContain('? ¿Cuál? (varias)')
    expect(out).toContain('  1) A')
    expect(out).toContain('texto libre')
    expect(p.feed({ ...q, state: 'answered' } as never)).toBe('  pregunta respondida\n')
    expect(new AgentPrinter().feed({ ...q, state: 'cancelled' } as never)).toBe(
      '  pregunta cancelada\n',
    )
  })

  it('plan, error y uso', () => {
    const p = new AgentPrinter()
    const plan = blk(0, {
      type: 'plan',
      entries: [
        { text: 'uno', status: 'completed' },
        { text: 'dos', status: 'in-progress' },
        { text: 'tres', status: 'pending' },
      ],
    })
    expect(p.feed(plan)).toBe('Plan:\n  [x] uno\n  [~] dos\n  [ ] tres\n')
    expect(p.feed(plan)).toBe('')
    expect(p.feed(blk(1, { type: 'error', code: 'X', message: 'mal', fatal: true }))).toBe(
      '! error fatal (X): mal\n',
    )
    expect(p.feed(blk(2, { type: 'error', code: 'Y', message: 'leve', fatal: false }))).toContain(
      '! error (Y)',
    )
    expect(
      p.feed(
        blk(3, {
          type: 'usage',
          stopReason: 'end-turn',
          usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.0123 },
        }),
      ),
    ).toBe('· fin del turno: end-turn (1 entrada, 2 salida) ~$0.0123\n')
    expect(new AgentPrinter().feed(blk(4, { type: 'usage', stopReason: 'error', usage: {} }))).toBe(
      '· fin del turno: error\n',
    )
  })
})
