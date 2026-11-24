import { buildRules, cruiseOptions } from './tools/depcruise/rules.mjs'

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: buildRules(),
  options: {
    ...cruiseOptions,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'default'] },
  },
}
