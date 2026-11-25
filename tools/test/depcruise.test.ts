import { cruise } from 'dependency-cruiser'
import { describe, expect, it } from 'vitest'
// @ts-expect-error módulo .mjs sin tipos; tools/ no entra en ningún tsconfig
import { buildRules, cruiseOptions } from '../depcruise/rules.mjs'

const FIXTURES = 'tools/depcruise/fixtures'

async function violationsOf(dir: string): Promise<Map<string, string[]>> {
  const prefix = `${FIXTURES}/${dir}/`
  const result = await cruise([`${FIXTURES}/${dir}`], {
    ...cruiseOptions,
    exclude: { path: ['/coverage/', '/dist/'] },
    validate: true,
    ruleSet: { forbidden: buildRules(prefix) },
  })
  const output = result.output
  if (typeof output === 'string') throw new Error('salida inesperada')
  const byRule = new Map<string, string[]>()
  for (const v of output.summary.violations) {
    const list = byRule.get(v.rule.name) ?? []
    list.push(`${v.from} -> ${v.to}`)
    byRule.set(v.rule.name, list)
  }
  return byRule
}

describe('reglas de dependency-cruiser', () => {
  it('un árbol conforme no tiene violaciones', async () => {
    expect([...(await violationsOf('clean')).keys()]).toEqual([])
  })

  it('rechaza cada violación del contrato de dependencias', async () => {
    const found = await violationsOf('violations')
    const rules = [...found.keys()].sort()
    expect(rules).toEqual(
      [
        'adapters-aislados',
        'adapters-sin-apps',
        'apps-aisladas',
        'client-solo-contracts',
        'contracts-solo-zod',
        'core-solo-contracts',
        'no-circular',
        'paquetes-sin-apps',
        'produccion-sin-testkit',
        'testkit-sin-adapters-ni-apps',
      ].sort(),
    )
  })

  it('core no puede importar node:* ni módulos de Node sin prefijo', async () => {
    const found = await violationsOf('violations')
    const core = (found.get('core-solo-contracts') ?? []).join('\n')
    expect(core).toMatch(/ -> fs$/m)
    expect(core).toMatch(/ -> path$/m)
  })

  it('contracts no puede importar librerías que no sean zod', async () => {
    const found = await violationsOf('violations')
    expect((found.get('contracts-solo-zod') ?? []).join('\n')).toContain('fast-check')
  })
})
